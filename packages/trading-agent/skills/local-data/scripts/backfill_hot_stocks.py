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
import importlib.util
import sqlite3
from local_data.db import get_db, get_db_path, db_exists
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from typing import Dict, List, Set

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_A_STOCK_DATA_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, "..", "..", "a-stock-data", "scripts"))


def _load_hot_stocks_module():
    module_path = os.path.join(_A_STOCK_DATA_DIR, "get_hot_stocks.py")
    spec = importlib.util.spec_from_file_location("astockdata_get_hot_stocks", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _market_from_code(code: str) -> int:
    if code.startswith(("8", "4", "92", "43")):
        return 2
    return 1 if code.startswith(("60", "68", "90", "689")) else 0


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


def fetch_for_day(module, d: date):
    date_str = d.isoformat()
    try:
        data = module.fetch_hot_stocks(date_str)
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


def ensure_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS hot_stocks (
            date TEXT NOT NULL,
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            name TEXT,
            reason TEXT,
            price REAL,
            change_pct REAL,
            turnover_pct REAL,
            amount REAL,
            pe_ttm REAL,
            pb REAL,
            mcap_yi REAL,
            updated_at TEXT,
            PRIMARY KEY (date, code, market)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hot_stocks_date ON hot_stocks(date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hot_stocks_reason ON hot_stocks(reason)")
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description="Backfill historical hot_stocks")
    parser.add_argument("--start-date", default="2024-01-01", help="Start date YYYY-MM-DD")
    parser.add_argument("--end-date", default=date.today().isoformat(), help="End date YYYY-MM-DD")
    parser.add_argument("--workers", type=int, default=3, help="Concurrent fetch workers")
    parser.add_argument("--dry-run", action="store_true", help="Do not write to DB")
    args = parser.parse_args()

    start = datetime.strptime(args.start_date, "%Y-%m-%d").date()
    end = datetime.strptime(args.end_date, "%Y-%m-%d").date()

    module = _load_hot_stocks_module()

    conn = get_db()
    ensure_table(conn)
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
        futures = {executor.submit(fetch_for_day, module, d): d for d in missing}
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
        ensure_table(conn)
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
