#!/usr/bin/env python3
"""Sync benchmark index daily klines for independence filter.
Fetches 沪深300 (000300) and 中证500 (000905) from akshare.
Usage: python sync_index_klines.py [--since 2020-01-01]
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
import sqlite3
import pandas as pd
from local_data.db import get_db, get_db_path, db_exists
from local_data.schema import ensure_tables
from datetime import datetime

INDEX_CODES = ["000300", "000905"]  # 沪深300, 中证500
AK_SYMBOL_MAP = {"000300": "sh000300", "000905": "sh000905"}


def sync_index_klines(conn: sqlite3.Connection, since: str = "2020-01-01") -> dict:
    """Fetch benchmark index klines from akshare and upsert into index_klines."""
    import akshare as ak

    ensure_tables()
    saved = 0

    for code in INDEX_CODES:
        symbol = AK_SYMBOL_MAP[code]
        try:
            df = ak.stock_zh_index_daily_em(symbol=symbol)
            if df is None or df.empty:
                print(f"  {code}: no data from akshare")
                continue

            rows = []
            for _, row in df.iterrows():
                date_str = str(row.get("date", ""))[:10]
                if date_str < since:
                    continue
                close = float(row["close"]) if pd.notna(row.get("close")) else None
                if close is None:
                    continue
                rows.append((code, date_str, close))

            if rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO index_klines (code, date, close) VALUES (?, ?, ?)",
                    rows,
                )
                conn.commit()
                print(f"  {code}: saved {len(rows)} rows (since {since})")
                saved += len(rows)
        except Exception as e:
            print(f"  {code}: error - {e}")

    return {"saved_rows": saved, "codes": len(INDEX_CODES)}


def main():
    parser = argparse.ArgumentParser(description="Sync benchmark index klines from akshare")
    parser.add_argument("--since", default="2020-01-01", help="Start date YYYY-MM-DD")
    args = parser.parse_args()

    conn = get_db()
    try:
        result = sync_index_klines(conn, since=args.since)
        print(f"Done: {result['saved_rows']} rows for {result['codes']} indices")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
