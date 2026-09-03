#!/usr/bin/env python3
"""Sync weekly/monthly klines for all stocks (daily_sync only handles daily).

Usage: python sync_period_klines.py --period week
       python sync_period_klines.py --period month
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import argparse
import logging
import time

from local_data.db import get_db
from local_data.market import is_a_share

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sync_period_klines")


def _period_is_open(period: str, bar_date: str) -> bool:
    """True when a week/month bar belongs to the still-unfinished current period.

    TDX labels the in-progress week/month bar with the current date and only
    partial OHLCV. Persisting it leaves a duplicate stale row behind when the
    final bar (Friday for weeks, month-end for months) arrives with its proper
    date. Skip bars of the current period until the period has fully closed:
    week -> Friday 15:00, month -> last calendar day 15:00.
    """
    now = datetime.now()
    if period == "week":
        monday = now - timedelta(days=now.weekday())
        if bar_date >= monday.strftime("%Y-%m-%d"):
            friday_close = monday + timedelta(days=4, hours=15)
            return now < friday_close
        return False
    month_start = now.replace(day=1)
    if bar_date >= month_start.strftime("%Y-%m-%d"):
        next_month = (month_start + timedelta(days=32)).replace(day=1)
        month_end_close = (next_month - timedelta(days=1)).replace(hour=15)
        return now < month_end_close
    return False


def sync_period_klines(period: str = "week") -> dict:
    """Fetch one period (week/month) of klines for every stock via mootdx."""
    from batch_get_kline import batch_get_kline

    if period not in ("week", "month"):
        raise ValueError(f"Unsupported period: {period}")

    conn = get_db()
    try:
        stocks = conn.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
        stocks = [s for s in stocks if is_a_share(s["code"])]
        logger.info(f"Found {len(stocks)} valid A-share stocks for {period} klines...")

        synced = 0
        failed = 0
        total_rows = 0
        batch_size = 50

        # Fetch a wide window so existing history is preserved/refreshed
        # (mootdx returns the most recent ~800 bars per request).
        start_date = "2019-01-01"
        end_date = time.strftime("%Y-%m-%d")

        for i in range(0, len(stocks), batch_size):
            batch = stocks[i : i + batch_size]
            batch_dicts = [{"code": s["code"], "market": s["market"]} for s in batch]
            try:
                klines = batch_get_kline(batch_dicts, start_date=start_date, end_date=end_date,
                                         period=period, adjust="bfq")
                covered = set()
                for k in klines:
                    date_str = k.get("date")
                    if not date_str:
                        continue
                    # Skip degenerate realtime rows (collapsed OHLC + sentinel volume)
                    vol = k.get("volume")
                    o, h, l, c = k.get("open"), k.get("high"), k.get("low"), k.get("close")
                    if vol is not None and 0 < vol < 1e-10 and None not in (o, h, l, c) and o == h == l == c:
                        continue
                    # Skip bars of the still-open current week/month (partial data)
                    if _period_is_open(period, date_str):
                        continue
                    conn.execute(
                        """INSERT OR REPLACE INTO klines
                           (code, market, period, adjust, date, open, high, low, close,
                            volume, turnover, change_pct, change_amount, amplitude, pre_close)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (k["code"], k["market"], period, "bfq", date_str,
                         k.get("open"), k.get("high"), k.get("low"), k.get("close"),
                         k.get("volume"), k.get("amount"),
                         k.get("change_pct"), k.get("change_amount"), k.get("amplitude"),
                         k.get("pre_close")),
                    )
                    covered.add(k["code"])
                    total_rows += 1

                synced += len(covered)
                failed += len(batch) - len(covered)
                if (i // batch_size + 1) % 10 == 0:
                    conn.commit()
                    logger.info(f"  {period} progress: {min(i + batch_size, len(stocks))}/{len(stocks)} stocks, {total_rows} rows")
            except Exception as e:
                logger.warning(f"  Batch {i}-{i + batch_size} failed: {e}")
                failed += len(batch)

        conn.commit()
        logger.info(f"{period} klines done: {synced} synced, {failed} failed, {total_rows} rows inserted.")
        return {"period": period, "synced": synced, "failed": failed, "rows": total_rows}
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Sync weekly/monthly klines via mootdx")
    parser.add_argument("--period", required=True, choices=["week", "month"])
    args = parser.parse_args()

    result = sync_period_klines(args.period)
    print(f"Done: {result['rows']} rows for period={result['period']}")


if __name__ == "__main__":
    main()
