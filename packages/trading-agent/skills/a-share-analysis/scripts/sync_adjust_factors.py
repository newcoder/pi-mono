#!/usr/bin/env python3
"""Incremental sync adjust_factors from latest date in DB to today."""
import os
import sqlite3
import sys
from datetime import datetime, timedelta

# Need batch_get_factors in path
script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

from batch_get_factors import batch_get_factors

import time

DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")
BATCH_SIZE = 200
MAX_WORKERS = 2


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Get all stocks
    stocks = cur.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
    stocks = [{"code": s["code"], "market": s["market"]} for s in stocks]
    print(f"Total stocks: {len(stocks)}")

    # Determine date range: from min latest factor date - 3 days to today
    row = cur.execute("SELECT MIN(max_date) as min_latest FROM (SELECT code, market, MAX(date) as max_date FROM adjust_factors GROUP BY code, market)").fetchone()
    min_latest = row["min_latest"] if row and row["min_latest"] else None

    if not min_latest:
        print("No existing adjust_factors found. Doing full sync from 2020-01-01.")
        start_date = "20200101"
    else:
        # Start 3 days before to handle gaps
        d = datetime.strptime(min_latest, "%Y-%m-%d") - timedelta(days=3)
        start_date = d.strftime("%Y%m%d")

    end_date = datetime.now().strftime("%Y%m%d")
    print(f"Sync range: {start_date} ~ {end_date}")

    total_factors = 0
    for i in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(stocks) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"Batch {batch_num}/{total_batches}: {len(batch)} stocks...")

        factors = batch_get_factors(batch, start_date, end_date, max_workers=MAX_WORKERS)
        if not factors:
            print(f"  No factors returned")
            time.sleep(1)
            continue

        now = datetime.now().isoformat()
        rows = []
        for f in factors:
            rows.append((
                f["code"], f["market"], f["date"],
                f.get("qfq_factor"), f.get("hfq_factor"), now
            ))

        cur.executemany(
            "INSERT OR REPLACE INTO adjust_factors (code, market, date, qfq_factor, hfq_factor, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            rows
        )
        conn.commit()
        total_factors += len(rows)
        print(f"  Saved {len(rows)} factors (total {total_factors})")
        time.sleep(0.5)

    print(f"\nDone. Total factors synced: {total_factors}")

    # Verify
    row = cur.execute("SELECT MAX(date) as latest, COUNT(*) as total FROM adjust_factors").fetchone()
    print(f"DB adjust_factors: latest={row['latest']}, total={row['total']}")
    conn.close()


if __name__ == "__main__":
    main()
