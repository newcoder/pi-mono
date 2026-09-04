#!/usr/bin/env python3
"""Sync adjust_factors using mootdx TCP xdxr (corporate action) data.

Unlike batch_get_factors.py which relies on Tencent/akshare HTTP APIs,
this script computes qfq/hfq factors locally from:
- bfq klines in the local SQLite DB
- xdxr (除权除息) info fetched via mootdx TCP 7709

This avoids the WAF/connection-reset issues that block HTTP factor sources
in the current environment.
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import sqlite3
from local_data.db import get_db, get_db_path, db_exists
from datetime import datetime
from typing import Any

import pandas as pd

script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

from mootdx.quotes import Quotes

def fetch_klines_range(
    cur: sqlite3.Cursor, code: str, market: int, start_date: str, end_date: str
) -> dict[str, float]:
    """Return {date: close} for daily bfq klines in a date range."""
    rows = cur.execute(
        """
        SELECT date, close FROM klines
        WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq'
          AND date >= ? AND date <= ?
        ORDER BY date
        """,
        (code, market, start_date, end_date),
    ).fetchall()
    return {row[0]: float(row[1]) for row in rows if row[1] is not None}


def parse_xdxr(xdxr: pd.DataFrame) -> list[dict[str, Any]]:
    """Extract category-1 corporate actions from mootdx xdxr DataFrame."""
    if xdxr is None or xdxr.empty:
        return []

    actions = []
    for _, row in xdxr.iterrows():
        if int(row.get("category", 0)) != 1:
            continue
        year = row.get("year")
        month = row.get("month")
        day = row.get("day")
        if pd.isna(year) or pd.isna(month) or pd.isna(day):
            continue
        date = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
        actions.append(
            {
                "date": date,
                "fenhong": float(row.get("fenhong") or 0),
                "peigu": float(row.get("peigu") or 0),
                "peigujia": float(row.get("peigujia") or 0),
                "songzhuangu": float(row.get("songzhuangu") or 0),
            }
        )
    return actions


def compute_factors(
    dates: list[str], closes: dict[str, float], actions: list[dict[str, Any]]
) -> tuple[dict[str, float], dict[str, float]]:
    """Compute qfq_factor and hfq_factor for every date.

    DB convention (from batch_get_factors.py):
        qfq_price = bfq_price * qfq_factor
        hfq_price = bfq_price * hfq_factor

    For each action at ex-date d:
        pre_close = close on the trading day before d
        ref = (pre_close*10 - fenhong + peigu*peigujia) / (10 + peigu + songzhuangu)
        qfq_r = ref / pre_close   (applied to dates before d)
        hfq_r = pre_close / ref   (applied to dates d and after)
    """
    date_to_idx = {d: i for i, d in enumerate(dates)}

    valid_actions: dict[str, dict[str, float]] = {}
    for a in actions:
        d = a["date"]
        idx = date_to_idx.get(d)
        if idx is None or idx == 0:
            continue
        pre_close = closes.get(dates[idx - 1])
        if pre_close is None or pre_close == 0:
            continue

        fenhong = a.get("fenhong", 0) or 0
        peigu = a.get("peigu", 0) or 0
        peigujia = a.get("peigujia", 0) or 0
        songzhuangu = a.get("songzhuangu", 0) or 0

        denom = 10 + peigu + songzhuangu
        if denom == 0:
            continue
        ref = (pre_close * 10 - fenhong + peigu * peigujia) / denom
        if ref == 0:
            continue

        valid_actions[d] = {"qfq_r": ref / pre_close, "hfq_r": pre_close / ref}

    # qfq: latest date factor = 1.0, walk backwards, apply action ratio for dates before action
    qfq_factors: dict[str, float] = {}
    cum = 1.0
    for d in reversed(dates):
        qfq_factors[d] = cum
        if d in valid_actions:
            cum *= valid_actions[d]["qfq_r"]

    # hfq: earliest date factor = 1.0, walk forwards, apply action ratio for dates at/after action
    hfq_factors: dict[str, float] = {}
    cum = 1.0
    for d in dates:
        hfq_factors[d] = cum
        if d in valid_actions:
            cum *= valid_actions[d]["hfq_r"]

    return qfq_factors, hfq_factors


def main():
    conn = get_db()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Target date = latest daily bfq kline date
    row = cur.execute(
        "SELECT MAX(date) as max_date FROM klines WHERE period = 'daily' AND adjust = 'bfq'"
    ).fetchone()
    target_date = row["max_date"] if row and row["max_date"] else datetime.now().strftime("%Y-%m-%d")
    print(f"Target date: {target_date}")

    stocks = cur.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
    stocks = [{"code": s["code"], "market": s["market"]} for s in stocks]
    print(f"Total stocks: {len(stocks)}")

    # Per-stock anchor: latest date where both qfq and hfq are present.
    latest_factors = {
        (r["code"], r["market"]): {
            "date": r["date"],
            "qfq": r["qfq_factor"],
            "hfq": r["hfq_factor"],
        }
        for r in cur.execute(
            """
            SELECT code, market, date, qfq_factor, hfq_factor
            FROM adjust_factors f
            WHERE date = (
                SELECT MAX(date) FROM adjust_factors
                WHERE code = f.code AND market = f.market
                  AND qfq_factor IS NOT NULL AND hfq_factor IS NOT NULL
            )
            """
        ).fetchall()
    }

    # Per-stock latest non-null qfq / hfq for forward-fill.
    latest_qfq = {
        (r["code"], r["market"]): {"date": r["date"], "value": r["qfq_factor"]}
        for r in cur.execute(
            """
            SELECT code, market, date, qfq_factor
            FROM adjust_factors f
            WHERE date = (
                SELECT MAX(date) FROM adjust_factors
                WHERE code = f.code AND market = f.market
                  AND qfq_factor IS NOT NULL
            )
            """
        ).fetchall()
    }
    latest_hfq = {
        (r["code"], r["market"]): {"date": r["date"], "value": r["hfq_factor"]}
        for r in cur.execute(
            """
            SELECT code, market, date, hfq_factor
            FROM adjust_factors f
            WHERE date = (
                SELECT MAX(date) FROM adjust_factors
                WHERE code = f.code AND market = f.market
                  AND hfq_factor IS NOT NULL
            )
            """
        ).fetchall()
    }

    client = Quotes.factory(market="std")
    now = datetime.now().isoformat()

    total_inserted = 0
    total_updated_stocks = 0
    total_forward_filled = 0
    total_recomputed = 0
    errors: list[str] = []

    for i, s in enumerate(stocks, 1):
        code, market = s["code"], s["market"]
        if i % 100 == 0 or i == len(stocks):
            print(
                f"Progress {i}/{len(stocks)}: inserted={total_inserted} "
                f"ff={total_forward_filled} recompute={total_recomputed} errors={len(errors)}"
            )

        try:
            xdxr = client.xdxr(symbol=code)
            actions = parse_xdxr(xdxr)

            latest = latest_factors.get((code, market))
            qfq_anchor = latest_qfq.get((code, market))
            hfq_anchor = latest_hfq.get((code, market))

            # Determine if forward-fill is safe (no category-1 actions after the
            # most recent factor date with values).
            anchor_date = None
            if qfq_anchor and hfq_anchor:
                anchor_date = max(qfq_anchor["date"], hfq_anchor["date"])
            elif qfq_anchor:
                anchor_date = qfq_anchor["date"]
            elif hfq_anchor:
                anchor_date = hfq_anchor["date"]

            if anchor_date:
                gap_actions = [a for a in actions if anchor_date < a["date"] <= target_date]
                if not gap_actions:
                    # Forward-fill from anchor date to target date
                    trade_dates = [
                        r[0]
                        for r in cur.execute(
                            """
                            SELECT DISTINCT date FROM klines
                            WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq'
                              AND date > ? AND date <= ?
                            ORDER BY date
                            """,
                            (code, market, anchor_date, target_date),
                        ).fetchall()
                    ]
                    qfq_value = qfq_anchor["value"] if qfq_anchor else None
                    hfq_value = hfq_anchor["value"] if hfq_anchor else None
                    if qfq_value is not None or hfq_value is not None:
                        # Fill anchor_date as well so any NULL qfq/hfq on that row gets a consistent value.
                        fill_dates = [anchor_date] + trade_dates
                        rows = [
                            (code, market, d, qfq_value, hfq_value, now)
                            for d in fill_dates
                        ]
                        cur.executemany(
                            "INSERT OR REPLACE INTO adjust_factors (code, market, date, qfq_factor, hfq_factor, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                            rows,
                        )
                        conn.commit()
                        total_inserted += len(rows)
                        total_forward_filled += 1
                    continue

            # Need to recompute for dates around recent actions.
            # Recompute from the latest existing factor date to target_date so
            # the new qfq base is at target_date (standard convention).
            start_recompute = latest["date"] if latest and latest["date"] else None
            if not start_recompute:
                # No existing factors: fall back to earliest kline date
                row = cur.execute(
                    "SELECT MIN(date) as min_date FROM klines WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq'",
                    (code, market),
                ).fetchone()
                start_recompute = row["min_date"] if row and row["min_date"] else "1990-01-01"

            closes = fetch_klines_range(cur, code, market, start_recompute, target_date)
            if not closes:
                continue

            dates = sorted(closes.keys())
            qfq_map, hfq_map = compute_factors(dates, closes, actions)

            # Anchor hfq to existing latest factor ratio so historical continuity is preserved.
            #   qfq_price = bfq_price * qfq_factor
            #   hfq_price = bfq_price * hfq_factor
            # Therefore hfq_factor / qfq_factor is constant for a given set of actions.
            hfq_scale = None
            if latest and latest["qfq"] and latest["hfq"] is not None and latest["qfq"] != 0:
                hfq_scale = latest["hfq"] / latest["qfq"]

            rows = []
            for d in dates:
                qfq = round(qfq_map[d], 6)
                if hfq_scale is not None:
                    hfq = round(qfq * hfq_scale, 6)
                else:
                    hfq = round(hfq_map[d], 6)
                rows.append((code, market, d, qfq, hfq, now))

            if rows:
                cur.executemany(
                    "INSERT OR REPLACE INTO adjust_factors (code, market, date, qfq_factor, hfq_factor, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    rows,
                )
                conn.commit()
                total_inserted += len(rows)
                total_recomputed += 1
                total_updated_stocks += 1

        except Exception as e:
            err = f"{code}: {type(e).__name__}: {e}"
            errors.append(err)
            if len(errors) <= 5:
                print(f"ERROR {err}")

    client.close()

    print(f"\nDone.")
    print(f"  Forward-filled stocks: {total_forward_filled}")
    print(f"  Recomputed stocks: {total_recomputed}")
    print(f"  Total rows inserted/updated: {total_inserted}")
    print(f"  Errors: {len(errors)}")

    row = cur.execute("SELECT MAX(date) as latest, COUNT(*) as total FROM adjust_factors").fetchone()
    print(f"  DB adjust_factors: latest={row['latest']}, total={row['total']}")

    conn.close()


if __name__ == "__main__":
    main()
