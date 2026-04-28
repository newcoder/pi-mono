#!/usr/bin/env python3
"""Resample daily klines to weekly/monthly locally using pandas."""
import os
import sys
import sqlite3
import time
from datetime import datetime

import pandas as pd
import numpy as np

DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")


def resample_period(period: str, rule: str):
    """
    Resample daily klines to weekly or monthly.
    rule: 'W-FRI' for weekly (Friday-based), 'ME' for month-end
    """
    print(f"\n=== Resampling to {period} ===")
    conn = sqlite3.connect(DB_PATH)
    t0 = time.time()

    # Load all daily data
    print("  Loading daily data...")
    df = pd.read_sql_query(
        """SELECT code, market, date, open, high, low, close, volume, turnover, pre_close
           FROM klines WHERE period='daily' AND adjust='bfq'""",
        conn
    )
    if df.empty:
        print("  No daily data found!")
        conn.close()
        return

    df['date'] = pd.to_datetime(df['date'])
    for col in ['open', 'high', 'low', 'close', 'volume', 'turnover', 'pre_close']:
        df[col] = pd.to_numeric(df[col], errors='coerce')

    print(f"  Loaded {len(df)} daily rows")

    # Set index for resampling
    df = df.set_index('date')

    rows_to_insert = []
    groups = df.groupby(['code', 'market'])
    total_groups = len(groups)

    for i, ((code, market), group) in enumerate(groups, 1):
        # Ensure native Python types for SQLite
        code = str(code)
        market = int(market)

        # Resample
        resampled = group.resample(rule).agg({
            'open': 'first',
            'high': 'max',
            'low': 'min',
            'close': 'last',
            'volume': 'sum',
            'turnover': 'sum',
            'pre_close': 'first',
        }).dropna()

        for date, row in resampled.iterrows():
            date_str = date.strftime('%Y-%m-%d')
            open_p = float(row['open']) if pd.notna(row['open']) else None
            high_p = float(row['high']) if pd.notna(row['high']) else None
            low_p = float(row['low']) if pd.notna(row['low']) else None
            close_p = float(row['close']) if pd.notna(row['close']) else None
            volume = float(row['volume']) if pd.notna(row['volume']) else None
            turnover = float(row['turnover']) if pd.notna(row['turnover']) else None
            pre_close = float(row['pre_close']) if pd.notna(row['pre_close']) else None

            change_pct = None
            change_amount = None
            amplitude = None
            if close_p is not None and pre_close is not None and pre_close != 0:
                change_pct = round((close_p - pre_close) / pre_close * 100, 4)
                change_amount = round(close_p - pre_close, 4)
                if high_p is not None and low_p is not None:
                    amplitude = round((high_p - low_p) / pre_close * 100, 4)

            rows_to_insert.append((
                code, market, period, 'bfq', date_str,
                open_p, high_p, low_p, close_p, volume, turnover,
                change_pct, change_amount, amplitude, pre_close
            ))

        if i % 500 == 0:
            print(f"  Processed {i}/{total_groups} stocks...")

    # Clear existing data for this period
    print(f"  Clearing existing {period} data...")
    conn.execute("DELETE FROM klines WHERE period = ? AND adjust = 'bfq'", (period,))

    # Insert in chunks
    chunk = 50000
    total = len(rows_to_insert)
    print(f"  Inserting {total} rows...")
    for i in range(0, total, chunk):
        batch = rows_to_insert[i:i+chunk]
        conn.executemany(
            """INSERT INTO klines
               (code, market, period, adjust, date, open, high, low, close, volume, turnover, change_pct, change_amount, amplitude, pre_close)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            batch
        )
        conn.commit()
        print(f"    Inserted {min(i+chunk, total)}/{total}")

    conn.close()
    elapsed = time.time() - t0
    print(f"=== {period} done: {total} rows in {elapsed:.1f}s ===")


if __name__ == "__main__":
    resample_period('weekly', 'W-FRI')
    resample_period('monthly', 'ME')
    print("\n=== All resampling complete ===")
