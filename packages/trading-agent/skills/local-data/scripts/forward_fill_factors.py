#!/usr/bin/env python3
"""Forward-fill adjust_factors from last known date to latest kline date.

This is a fallback when upstream APIs (Tencent/akshare/Eastmoney) are blocked.
Assumes no dividend/split corporate actions occurred during the gap period.
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
from datetime import datetime, timedelta

def main():
    conn = get_db()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Get latest kline date (trading calendar)
    row = cur.execute("SELECT MAX(date) as max_date FROM klines WHERE period = 'daily' AND adjust = 'bfq'").fetchone()
    target_date = row["max_date"] if row and row["max_date"] else datetime.now().strftime("%Y-%m-%d")
    print(f"Target date (latest kline): {target_date}")

    # Get all stocks with existing factors (deterministic: pick the row at MAX(date))
    stocks = cur.execute("""
        SELECT af.code, af.market, af.date as last_date, af.qfq_factor, af.hfq_factor
        FROM adjust_factors af
        INNER JOIN (
            SELECT code, market, MAX(date) as max_date
            FROM adjust_factors
            GROUP BY code, market
        ) latest ON af.code = latest.code AND af.market = latest.market AND af.date = latest.max_date
    """).fetchall()
    print(f"Stocks with existing factors: {len(stocks)}")

    # Dynamic start date: earliest last factor date, falling back to earliest kline date.
    row = cur.execute("""
        SELECT MIN(last_date) as min_date FROM (
            SELECT code, market, MAX(date) as last_date
            FROM adjust_factors
            GROUP BY code, market
        )
    """).fetchone()
    fill_start = row["min_date"] if row and row["min_date"] else None
    if not fill_start:
        row = cur.execute("SELECT MIN(date) FROM klines WHERE period = 'daily' AND adjust = 'bfq'").fetchone()
        fill_start = row[0] if row and row[0] else datetime.now().strftime("%Y-%m-%d")
    print(f"Fill start date: {fill_start}")

    # Get trading dates from klines
    trade_dates = [r[0] for r in cur.execute(
        "SELECT DISTINCT date FROM klines WHERE period = 'daily' AND adjust = 'bfq' AND date > ? AND date <= ? ORDER BY date",
        (fill_start, target_date)
    ).fetchall()]
    if not trade_dates:
        print(f"Trading dates to fill: 0 (already up to date)")
        conn.close()
        return
    print(f"Trading dates to fill: {len(trade_dates)} ({trade_dates[0]} ~ {trade_dates[-1]})")

    total_inserted = 0
    total_skipped = 0
    now = datetime.now().isoformat()

    for s in stocks:
        code, market, last_date, qfq, hfq = s["code"], s["market"], s["last_date"], s["qfq_factor"], s["hfq_factor"]
        if not last_date or last_date >= target_date:
            total_skipped += 1
            continue

        # Find trading dates after last_date up to target_date
        fill_dates = [d for d in trade_dates if d > last_date]
        if not fill_dates:
            continue

        rows = [(code, market, d, qfq, hfq, now) for d in fill_dates]
        cur.executemany(
            "INSERT OR REPLACE INTO adjust_factors (code, market, date, qfq_factor, hfq_factor, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            rows
        )
        total_inserted += len(rows)

    conn.commit()
    print(f"\nDone. Forward-filled {total_inserted} factor rows for {len(stocks) - total_skipped} stocks.")
    print(f"Skipped {total_skipped} stocks (already up to date or no factors).")

    row = cur.execute("SELECT MAX(date) as latest, COUNT(*) as total FROM adjust_factors").fetchone()
    print(f"DB adjust_factors: latest={row['latest']}, total={row['total']}")
    conn.close()


if __name__ == "__main__":
    main()
