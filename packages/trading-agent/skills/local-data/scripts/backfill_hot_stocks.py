#!/usr/bin/env python3
"""
Backfill historical hot_stocks from Tonghuashun into the local DB.
Fetches every trading day in [start_date, end_date] that is not already present.
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
from local_data.db import get_db, get_db_path, db_exists
from local_data.schema import ensure_tables
from local_data.market import market_from_code
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from typing import Dict, List, Set

from hot_stocks_fetcher import fetch_hot_stocks


def _market_from_code(code: str) -> int:
    return market_from_code(code) or 0


def _safe_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def get_trade_dates(start: date, end: date) -> List[date]:
    """Get A-share trade dates between start and end (inclusive) using akshare."""
    try:
        import akshare as ak
        df = ak.tool_trade_date_hist_sina()
        dates = []
        for d in df["trade_date"]:
            if isinstance(d, str):
                d = datetime.strptime(d, "%Y-%m-%d").date()
            if start <= d <= end:
                dates.append(d)
        return dates
    except Exception as e:
        print(f"Failed to load trade calendar: {e}", file=sys.stderr)
        # Fallback: weekdays only
        dates = []
        d = start
        while d <= end:
            if d.weekday() < 5:
                dates.append(d)
            d += timedelta(days=1)
        return dates


def get_existing_dates(conn: sqlite3.Connection) -> Set[str]:
    rows = conn.execute("SELECT DISTINCT date FROM hot_stocks").fetchall()
    return {r[0] for r in rows}


def fetch_for_day(d: date):
    date_str = d.isoformat()
    try:
        data = fetch_hot_stocks(date_str)
        return date_str, data.get("rows", []) or data.get("data", [])
    except Exception as e:
        print(f"  {date_str}: fetch failed - {e}", file=sys.stderr)
        return date_str, []


def save_day(conn: sqlite3.Connection, date_str: str, rows: List[Dict]) -> int:
    if not rows:
        return 0
    now = datetime.now().isoformat()
    inserted = 0
    cur = conn.cursor()
    for row in rows:
        code = str(row.get("code", "")).strip()
        if not code or not code.isdigit() or len(code) != 6:
            continue
        market = _market_from_code(code)
        cur.execute(
            """INSERT OR REPLACE INTO hot_stocks
               (date, code, market, name, reason, price, change_pct, turnover_pct, amount,
                pe_ttm, pb, mcap_yi, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                date_str,
                code,
                market,
                row.get("name", ""),
                row.get("reason", ""),
                _safe_float(row.get("price")),
                _safe_float(row.get("change_pct")),
                _safe_float(row.get("turnover_pct")),
                _safe_float(row.get("amount_wan")),
                _safe_float(row.get("pe_ttm")),
                _safe_float(row.get("pb")),
                _safe_float(row.get("mcap_yi")),
                now,
            ),
        )
        inserted += 1
    conn.commit()
    return inserted


def main():
    parser = argparse.ArgumentParser(description="Backfill historical hot_stocks")
    parser.add_argument("--start-date", default="2024-01-01", help="Start date YYYY-MM-DD")
    parser.add_argument("--end-date", default=date.today().isoformat(), help="End date YYYY-MM-DD")
    parser.add_argument("--workers", type=int, default=3, help="Concurrent fetch workers")
    parser.add_argument("--dry-run", action="store_true", help="Do not write to DB")
    args = parser.parse_args()

    start = datetime.strptime(args.start_date, "%Y-%m-%d").date()
    end = datetime.strptime(args.end_date, "%Y-%m-%d").date()

    conn = get_db()
    ensure_tables()
    existing = get_existing_dates(conn)
    conn.close()

    trade_dates = get_trade_dates(start, end)
    missing = [d for d in trade_dates if d.isoformat() not in existing]
    total_days = len(missing)
    print(f"Backfilling hot_stocks from {start} to {end}")
    print(f"Trade days in range: {len(trade_dates)}, already synced: {len(existing & {d.isoformat() for d in trade_dates})}, missing: {total_days}")

    if total_days == 0:
        print("Nothing to backfill.")
        return

    fetched_results = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(fetch_for_day, d): d for d in missing}
        for i, future in enumerate(as_completed(futures)):
            d = futures[future]
            date_str, rows = future.result()
            fetched_results[date_str] = rows
            elapsed = time.time() - t0
            eta = elapsed / (i + 1) * (total_days - i - 1) if i > 0 else 0
            print(f"  [{i+1}/{total_days}] {date_str}: {len(rows)} rows, ETA {eta/60:.1f}m")

    if args.dry_run:
        total_rows = sum(len(rows) for rows in fetched_results.values())
        print(f"Dry run complete. Would insert {total_rows} rows across {len(fetched_results)} days.")
        return

    conn = get_db()
    try:
        ensure_tables()
        total_inserted = 0
        days_inserted = 0
        for d in sorted(fetched_results):
            rows = fetched_results[d]
            inserted = save_day(conn, d, rows)
            if inserted > 0:
                total_inserted += inserted
                days_inserted += 1
        print(f"Backfill complete. Inserted/updated {total_inserted} rows across {days_inserted} days.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
