#!/usr/bin/env python3
"""Sync benchmark index daily klines for independence filter.
Fetches 沪深300 (000300) and 中证500 (000905) from Tencent's kline API
(akshare was removed as a data source; its EM index endpoint went stale).
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
import requests
from local_data.db import get_db
from local_data.schema import ensure_tables

INDEX_CODES = ["000300", "000905"]  # 沪深300, 中证500
TENCENT_SYMBOL_MAP = {"000300": "sh000300", "000905": "sh000905"}


def _fetch_tencent_index(symbol: str, since: str) -> list:
    """Fetch index daily closes from Tencent kline API: (date, close) rows since `since`.

    Note: the API returns the most recent `count` bars; a large count combined with
    an early start date returns nothing, so we request 640 bars (about 2.5 years)
    and filter client-side.
    """
    from datetime import datetime

    today = datetime.now().strftime("%Y-%m-%d")
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,{since},{today},640,qfq"
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    data = r.json()
    quotes = ((data.get("data") or {}).get(symbol) or {})
    klines = quotes.get("qfqday") or quotes.get("day") or []
    rows = []
    for k in klines:
        date_str = str(k[0])[:10]
        try:
            close = float(k[2])
        except (TypeError, ValueError):
            continue
        if date_str >= since:
            rows.append((date_str, close))
    return rows


def sync_index_klines(conn: sqlite3.Connection, since: str = "2020-01-01") -> dict:
    """Fetch benchmark index klines from Tencent and upsert into index_klines."""
    ensure_tables()
    saved = 0

    for code in INDEX_CODES:
        symbol = TENCENT_SYMBOL_MAP[code]
        try:
            rows = _fetch_tencent_index(symbol, since)
            if not rows:
                print(f"  {code}: no data from Tencent")
                continue

            conn.executemany(
                "INSERT OR REPLACE INTO index_klines (code, date, close) VALUES (?, ?, ?)",
                [(code, date_str, close) for date_str, close in rows],
            )
            conn.commit()
            print(f"  {code}: saved {len(rows)} rows (since {since})")
            saved += len(rows)
        except Exception as e:
            print(f"  {code}: error - {e}")

    return {"saved_rows": saved, "codes": len(INDEX_CODES)}


def main():
    parser = argparse.ArgumentParser(description="Sync benchmark index klines from Tencent")
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
