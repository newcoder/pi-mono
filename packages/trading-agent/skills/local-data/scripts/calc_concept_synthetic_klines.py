#!/usr/bin/env python3
"""
Build equal-weight, qfq-adjusted synthetic concept indices from constituent stock klines.
Mirrors calc_sw_industry_momentum.py build_equal_weight_index pattern.
Usage: python calc_concept_synthetic_klines.py [--since 2020-01-01] [--min-constituents 3]
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
from local_data.db import get_db
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import pandas as pd


def ensure_tables(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS concept_synthetic_klines (
            concept TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL,
            constituent_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (concept, date)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_concept_synthetic_klines_lookup
        ON concept_synthetic_klines(concept, date)
    """)
    conn.commit()


def load_concepts(conn: sqlite3.Connection) -> List[str]:
    rows = conn.execute("SELECT DISTINCT concept FROM concept_stocks ORDER BY concept").fetchall()
    return [r[0] for r in rows]


def load_constituents(conn: sqlite3.Connection, concept: str) -> List[Tuple[str, int]]:
    rows = conn.execute(
        """SELECT cs.code,
                  CASE WHEN cs.code LIKE '6%' OR cs.code LIKE '9%' THEN 1 ELSE 0 END as market
           FROM concept_stocks cs
           JOIN stocks s ON cs.code = s.code
           WHERE cs.concept = ? AND s.name NOT LIKE '%退%'
           ORDER BY cs.code""",
        (concept,),
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def _chunked(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _load_stock_prices(
    conn: sqlite3.Connection,
    constituents: List[Tuple[str, int]],
    chunk_size: int = 300,
) -> pd.DataFrame:
    frames = []
    for chunk in _chunked(constituents, chunk_size):
        codes = [c[0] for c in chunk]
        markets = [str(c[1]) for c in chunk]
        code_list = ",".join(f"'{c}'" for c in codes)
        market_list = ",".join(markets)
        sql = f"""
            SELECT k.date, k.code || '_' || k.market as ck, k.close * COALESCE(a.qfq_factor, 1.0) as qfq_close
            FROM klines k
            LEFT JOIN adjust_factors a ON k.code = a.code AND k.market = a.market AND k.date = a.date
            WHERE k.code IN ({code_list})
              AND k.market IN ({market_list})
              AND k.period = 'daily'
              AND k.adjust = 'bfq'
              AND k.close IS NOT NULL
            ORDER BY k.date
        """
        df = pd.read_sql_query(sql, conn)
        if not df.empty:
            frames.append(df)
    if not frames:
        return pd.DataFrame(columns=["date", "ck", "qfq_close"])
    return pd.concat(frames, ignore_index=True)


def build_equal_weight_index(
    conn: sqlite3.Connection,
    concept: str,
    min_constituents: int = 3,
) -> Optional[pd.DataFrame]:
    constituents = load_constituents(conn, concept)
    if len(constituents) < min_constituents:
        return None

    df = _load_stock_prices(conn, constituents)
    if df.empty:
        return None

    wide = df.pivot_table(index="date", columns="ck", values="qfq_close", aggfunc="last")
    if wide.empty or len(wide.columns) < min_constituents:
        return None

    returns = wide.pct_change()
    eq_return = returns.mean(axis=1, skipna=True)

    index_df = pd.DataFrame({"close": (1 + eq_return).cumprod()}, index=eq_return.index)
    index_df.index.name = "date"
    index_df["constituent_count"] = len(constituents)

    first_valid = index_df["close"].first_valid_index()
    if first_valid is not None:
        index_df = index_df.loc[first_valid:]
    return index_df


def save_synthetic_klines(
    conn: sqlite3.Connection,
    concept: str,
    index_df: pd.DataFrame,
    since: Optional[str] = None,
) -> int:
    now = datetime.now().isoformat()
    rows = []
    for date_val, row in index_df.iterrows():
        date_str = str(date_val)[:10]
        if since and date_str < since:
            continue
        if pd.isna(row.get("close")):
            continue
        rows.append((concept, date_str, float(row["close"]), int(row.get("constituent_count", 0)), now))

    if rows:
        conn.executemany(
            """INSERT OR REPLACE INTO concept_synthetic_klines
               (concept, date, close, constituent_count, updated_at) VALUES (?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()
    return len(rows)


def calc_all(conn: sqlite3.Connection, min_constituents: int = 3, since: Optional[str] = None) -> dict:
    ensure_tables(conn)
    concepts = load_concepts(conn)
    print(f"Total concepts: {len(concepts)}")

    total_klines = 0
    valid = 0
    for i, concept in enumerate(concepts):
        if (i + 1) % 25 == 0:
            print(f"  [{i+1}/{len(concepts)}] {concept}...")
        try:
            index_df = build_equal_weight_index(conn, concept, min_constituents=min_constituents)
            if index_df is None or index_df.empty:
                continue
            n = save_synthetic_klines(conn, concept, index_df, since=since)
            if n > 0:
                total_klines += n
                valid += 1
        except Exception as e:
            print(f"  Error building {concept}: {e}")

    return {"total_concepts": len(concepts), "valid_concepts": valid, "synthetic_klines": total_klines}


def main():
    parser = argparse.ArgumentParser(description="Build concept synthetic klines")
    parser.add_argument("--since", help="Only save bars on or after this date YYYY-MM-DD")
    parser.add_argument("--min-constituents", type=int, default=3, help="Min stocks per concept")
    args = parser.parse_args()

    conn = get_db()
    try:
        result = calc_all(conn, min_constituents=args.min_constituents, since=args.since)
        print(f"Done: {result}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
