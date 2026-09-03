#!/usr/bin/env python3
"""Repair: remove degenerate realtime kline rows and refetch the affected windows.

Degenerate rows are realtime snapshot bars that got persisted as if they were
regular bars: OHLC all collapse to one price with a sentinel volume
(~2^-127 float garbage, e.g. 5.877471754111438e-39). Sources:
  - TDX/Sina intraday realtime rows persisted by saveKlines / daemon fallback
  - mootdx's own 1m history feed returns such placeholder bars for no-trade
    minutes (14:58/14:59), so the insert loop here filters them too.
They polluted daily/minute/week/month tables 2026-05-21..2026-09-03.

Pass 2 scope (idempotent; safe to re-run):
  1. Delete every degenerate row still present.
  2. Refetch daily + week + month for every code that has a gap or stale max in
     the pollution window [2026-05-15, now] via batch_get_kline, INSERT OR
     REPLACE. Active stocks get their holes refilled from TDX; delisted or
     long-suspended codes return nothing (correct) and are reported.
  3. 1m is NOT refetched: mootdx returns the same degenerate placeholder bars,
     and per-minute history has no clean upstream. Deleted 1m rows stay gone;
     the degenerate filter in the persistent sync paths prevents re-pollution.

Run: python repair_degenerate_klines.py
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import logging
import time
from datetime import datetime, timedelta

from local_data.db import get_db
from local_data.market import is_a_share

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("repair_degenerate_klines")

DEGENERATE_WHERE = """(
    volume IS NOT NULL AND volume > 0 AND volume < 1e-10
    AND open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
    AND open = high AND high = low AND low = close
)"""

POLLUTION_START = "2026-05-15"  # 5 days before the earliest observed degenerate row


def is_degenerate(k: dict) -> bool:
    vol = k.get("volume")
    o, h, l, c = k.get("open"), k.get("high"), k.get("low"), k.get("close")
    return vol is not None and 0 < vol < 1e-10 and None not in (o, h, l, c) and o == h == l == c


def find_daily_gap_codes(conn, end_date: str) -> list:
    """Codes whose daily data has a hole or staleness in the pollution window.

    - max(date) within the window but < yesterday: last bar was possibly a
      polluted row that got deleted. Codes whose max predates the pollution
      window (< 2026-08-01) are delisted or long-suspended; TDX serves them
      nothing and the normal incremental daily sync repairs them if they ever
      resume trading, so they are left to it.
    - missing run of >= 3 market trading days between the code's first and last
      bar in the window. The trading calendar is derived from dates where > 200
      codes traded (suspension days are too thin to fake a calendar day).
      Deleted degenerate rows create such runs for active stocks (e.g. 002027
      lost 2026-08-03..08-10 = 6 trading days).
    """
    stale = conn.execute(
        "SELECT code, market FROM klines WHERE period='daily' AND adjust='bfq' "
        "GROUP BY code, market HAVING MAX(date) >= ? AND MAX(date) < ?",
        ("2026-08-01", (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")),
    ).fetchall()
    trading_rows = conn.execute(
        "SELECT date, COUNT(*) c FROM klines WHERE period='daily' AND adjust='bfq' "
        "AND date BETWEEN ? AND ? GROUP BY date HAVING c > 200",
        (POLLUTION_START, end_date),
    ).fetchall()
    trading_days = sorted(r["date"] for r in trading_rows)

    bars = conn.execute(
        "SELECT code, market, date FROM klines WHERE period='daily' AND adjust='bfq' "
        "AND date BETWEEN ? AND ? ORDER BY code, date",
        (POLLUTION_START, end_date),
    ).fetchall()
    per_code: dict = {}
    for r in bars:
        per_code.setdefault((r["code"], r["market"]), set()).add(r["date"])

    holes = []
    for (code, market), dates in per_code.items():
        if len(dates) < 3:
            continue
        # Trading days strictly inside (first, last) — a run of >= 3 missing
        # trading days that is bounded by real bars on both sides.
        ordered = sorted(d for d in dates if d > min(dates) and d < max(dates))
        if len(ordered) == 0:
            continue
        day_set = set(ordered)
        run = 0
        for d in trading_days:
            if d <= min(ordered) or d >= max(ordered):
                continue
            run = run + 1 if d not in day_set else 0
            if run >= 3:
                holes.append({"code": code, "market": market})
                break

    seen = set()
    result = []
    for row in stale + holes:
        key = (row["code"], row["market"])
        if key not in seen:
            seen.add(key)
            result.append({"code": row["code"], "market": row["market"]})
    result = [s for s in result if is_a_share(s["code"])]
    logger.info(f"Daily refetch universe: {len(result)} codes ({len(stale)} stale max, {len(holes)} with holes)")
    return result


def main():
    from batch_get_kline import batch_get_kline

    conn = get_db()
    try:
        # 1. Delete all degenerate rows (again; pass 1's mootdx 1m refetch
        #    re-inserted some because mootdx 1m returns those placeholder bars).
        cur = conn.execute(f"DELETE FROM klines WHERE {DEGENERATE_WHERE}")
        logger.info(f"Deleted {cur.rowcount} degenerate rows")
        conn.commit()

        end_date = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        # No refetch of 1m: mootdx returns the same degenerate placeholders.
        for period in ("daily", "week", "month"):
            if period == "daily":
                groups = find_daily_gap_codes(conn, end_date)
            else:
                groups = conn.execute(
                    f"""SELECT code, market FROM klines
                        WHERE period=? AND adjust='bfq'
                        GROUP BY code, market HAVING MAX(date) < ?""",
                    (period, (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")),
                ).fetchall()
                groups = [dict(g) for g in groups if is_a_share(g["code"])]
                logger.info(f"{period} refetch universe: {len(groups)} codes")
            if not groups:
                continue

            restored = 0
            failed = 0
            no_data = 0
            batch_size = 50
            for i in range(0, len(groups), batch_size):
                batch = groups[i : i + batch_size]
                batch_dicts = [{"code": g["code"], "market": g["market"]} for g in batch]
                try:
                    klines = batch_get_kline(batch_dicts, start_date=POLLUTION_START,
                                             end_date=end_date, period=period, adjust="bfq")
                except Exception as e:
                    logger.warning(f"Batch {i}-{i + batch_size} ({period}) fetch failed: {e}")
                    failed += len(batch)
                    continue

                covered = set()
                for k in klines:
                    code = k.get("code")
                    date_str = k.get("date")
                    if not code or not date_str:
                        continue
                    if is_degenerate(k):
                        continue
                    conn.execute(
                        """INSERT OR REPLACE INTO klines
                           (code, market, period, adjust, date, open, high, low, close,
                            volume, turnover, change_pct, change_amount, amplitude, pre_close)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (code, k.get("market"), period, "bfq", date_str,
                         k.get("open"), k.get("high"), k.get("low"), k.get("close"),
                         k.get("volume"), k.get("amount"),
                         k.get("change_pct"), k.get("change_amount"), k.get("amplitude"),
                         k.get("pre_close")),
                    )
                    covered.add(code)
                restored += len(covered)
                no_data += len(batch) - len(covered)
                if (i // batch_size + 1) % 10 == 0:
                    conn.commit()
                    logger.info(f"  {period} progress: {min(i + batch_size, len(groups))}/{len(groups)} restored={restored}")
            conn.commit()
            logger.info(f"{period}: {restored} restored, {no_data} with no upstream data (delisted/suspended), {failed} fetch failures")

        left = conn.execute(f"SELECT COUNT(*) FROM klines WHERE {DEGENERATE_WHERE}").fetchone()[0]
        logger.info(f"Repair pass 2 done. Degenerate rows left: {left}")
        return {"left": left}
    finally:
        conn.close()


if __name__ == "__main__":
    t0 = time.time()
    result = main()
    print(f"Result: {result} in {time.time() - t0:.1f}s")
