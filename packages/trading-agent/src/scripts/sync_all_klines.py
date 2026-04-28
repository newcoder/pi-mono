#!/usr/bin/env python3
"""
Batch sync all A-share daily klines from JoinQuant to local SQLite DB.
Supports resumable sync with progress tracking.
"""
import os
import sys
import sqlite3
import time
from datetime import datetime

import pandas as pd
import numpy as np

# Add jq_data to path
sys.path.insert(0, os.path.expanduser("~/.claude/skills/stock_data/scripts"))
import jq_data
import jqdatasdk as jq

DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")
START_DATE = "2023-01-01"
END_DATE = datetime.now().strftime("%Y-%m-%d")
BATCH_SIZE = 100  # stocks per API call
INSERT_CHUNK = 50000  # rows per SQLite commit


def init_db():
    """Ensure klines table exists."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS klines (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            period TEXT NOT NULL,
            adjust TEXT NOT NULL DEFAULT 'bfq',
            date TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume REAL,
            turnover REAL,
            change_pct REAL,
            change_amount REAL,
            amplitude REAL,
            pre_close REAL,
            PRIMARY KEY (code, market, period, adjust, date)
        )
    """)
    conn.commit()
    conn.close()


def get_synced_codes() -> set:
    """Get set of (code, market) already synced for daily/bfq."""
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            "SELECT DISTINCT code, market FROM klines WHERE period='daily' AND adjust='bfq'"
        ).fetchall()
        return set(rows)
    except:
        return set()
    finally:
        conn.close()


def normalize_jq_code(jq_code: str) -> tuple:
    """Convert '000001.XSHE' -> ('000001', 0) or '600000.XSHG' -> ('600000', 1)."""
    parts = jq_code.split(".")
    code = parts[0]
    market = 1 if parts[1] == "XSHG" else 0
    return code, market


def process_batch(df: pd.DataFrame) -> list:
    """Convert jq.get_price DataFrame to kline rows for SQLite."""
    if df is None or len(df) == 0:
        return []

    rows = []
    for _, row in df.iterrows():
        code, market = normalize_jq_code(row["code"])
        date_str = str(row["time"]).split(" ")[0] if pd.notna(row.get("time")) else None
        open_p = float(row["open"]) if pd.notna(row.get("open")) else None
        close_p = float(row["close"]) if pd.notna(row.get("close")) else None
        high_p = float(row["high"]) if pd.notna(row.get("high")) else None
        low_p = float(row["low"]) if pd.notna(row.get("low")) else None
        volume = float(row["volume"]) if pd.notna(row.get("volume")) else None
        money = float(row["money"]) if pd.notna(row.get("money")) else None
        pre_close = float(row["pre_close"]) if pd.notna(row.get("pre_close")) else None

        change_pct = None
        change_amount = None
        amplitude = None
        if close_p is not None and pre_close is not None and pre_close != 0:
            change_pct = round((close_p - pre_close) / pre_close * 100, 4)
            change_amount = round(close_p - pre_close, 4)
            if high_p is not None and low_p is not None:
                amplitude = round((high_p - low_p) / pre_close * 100, 4)

        rows.append((
            code, market, "daily", "bfq", date_str,
            open_p, high_p, low_p, close_p, volume, money,
            change_pct, change_amount, amplitude, pre_close
        ))
    return rows


def insert_rows(conn, rows):
    """Insert rows with executemany."""
    conn.executemany(
        """INSERT OR REPLACE INTO klines
           (code, market, period, adjust, date, open, high, low, close, volume, turnover, change_pct, change_amount, amplitude, pre_close)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows
    )


def main():
    print(f"=== Sync All A-Share Klines ===")
    print(f"DB: {DB_PATH}")
    print(f"Period: {START_DATE} ~ {END_DATE}")
    print()

    init_db()
    jq_data.login()

    # Get all stocks
    all_stocks = jq.get_all_securities(types=["stock"])
    all_codes = all_stocks.index.tolist()
    total = len(all_codes)
    print(f"Total stocks from JoinQuant: {total}")

    # Check already synced
    synced = get_synced_codes()
    print(f"Already synced: {len(synced)}")

    # Filter out already synced
    pending = []
    for code in all_codes:
        c, m = normalize_jq_code(code)
        if (c, m) not in synced:
            pending.append(code)

    print(f"Pending: {len(pending)}")
    if not pending:
        print("All stocks already synced!")
        return

    # Process in batches
    conn = sqlite3.connect(DB_PATH)
    total_inserted = 0
    t0 = time.time()
    buffer_rows = []

    for i in range(0, len(pending), BATCH_SIZE):
        batch = pending[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(pending) + BATCH_SIZE - 1) // BATCH_SIZE

        try:
            t1 = time.time()
            df = jq.get_price(
                batch,
                start_date=START_DATE,
                end_date=END_DATE,
                frequency="daily",
                fq=None,
                panel=False,
                fields=["open", "close", "low", "high", "volume", "money", "pre_close", "avg"],
                skip_paused=False,
            )
            t_fetch = time.time() - t1

            if df is not None and len(df) > 0:
                rows = process_batch(df)
                buffer_rows.extend(rows)
                total_inserted += len(rows)

                # Commit in chunks
                if len(buffer_rows) >= INSERT_CHUNK:
                    t2 = time.time()
                    insert_rows(conn, buffer_rows)
                    conn.commit()
                    t_insert = time.time() - t2
                    buffer_rows = []
                    print(f"  Batch {batch_num}/{total_batches}: {len(batch)} stocks, {len(rows)} rows | fetch={t_fetch:.1f}s insert={t_insert:.1f}s | total={total_inserted}")
                else:
                    print(f"  Batch {batch_num}/{total_batches}: {len(batch)} stocks, {len(rows)} rows | fetch={t_fetch:.1f}s | total={total_inserted}")
            else:
                print(f"  Batch {batch_num}/{total_batches}: {len(batch)} stocks, NO DATA")

        except Exception as e:
            print(f"  Batch {batch_num}/{total_batches}: ERROR - {e}")
            # Continue with next batch

    # Final commit
    if buffer_rows:
        insert_rows(conn, buffer_rows)
        conn.commit()
        print(f"  Final commit: {len(buffer_rows)} rows")

    conn.close()

    elapsed = time.time() - t0
    print()
    print(f"=== Done ===")
    print(f"Total rows inserted: {total_inserted}")
    print(f"Elapsed: {elapsed:.1f}s ({elapsed/60:.1f} min)")


if __name__ == "__main__":
    main()
