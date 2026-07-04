#!/usr/bin/env python3
"""
Compute concept momentum and forward IC from concept_synthetic_klines.
Reuses calc_industry_momentum.compute_ic for Spearman IC.
Only computes for concepts in tracked_themes with status='tracked'.
Usage: python calc_concept_momentum.py [--periods 20] [--forwards 5] [--since 2024-01-01]
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
from typing import Dict, List, Optional, Sequence

import pandas as pd
import numpy as np

from calc_industry_momentum import compute_ic


def ensure_tables(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS concept_indicators (
            concept TEXT NOT NULL,
            date TEXT NOT NULL,
            period_days INTEGER NOT NULL,
            momentum_return REAL,
            momentum_rank INTEGER,
            has_momentum INTEGER,
            updated_at TEXT,
            PRIMARY KEY (concept, date, period_days)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_concept_indicators_date ON concept_indicators(date, period_days)")
    conn.commit()


def get_tracked_concepts(conn: sqlite3.Connection) -> List[str]:
    rows = conn.execute(
        "SELECT concept FROM tracked_themes WHERE status = 'tracked' ORDER BY concept"
    ).fetchall()
    if not rows:
        # Fallback: use all concepts with synthetic klines
        rows = conn.execute("SELECT DISTINCT concept FROM concept_synthetic_klines ORDER BY concept").fetchall()
        print(f"  No tracked concepts found, using all {len(rows)} concepts with synthetic klines")
    return [r[0] for r in rows]


def load_synthetic_klines(conn: sqlite3.Connection, concepts: List[str]) -> pd.DataFrame:
    placeholders = ",".join("?" for _ in concepts)
    sql = f"""
        SELECT concept, date, close FROM concept_synthetic_klines
        WHERE concept IN ({placeholders}) AND close IS NOT NULL
        ORDER BY date
    """
    df = pd.read_sql_query(sql, conn, params=concepts)
    if df.empty:
        return pd.DataFrame()
    wide = df.pivot_table(index="date", columns="concept", values="close", aggfunc="last")
    return wide


def compute_momentum(close: pd.DataFrame, periods: Sequence[int]) -> Dict[int, pd.DataFrame]:
    result = {}
    for p in periods:
        mom = close / close.shift(p) - 1.0
        result[p] = mom
    return result


def compute_forward_returns(close: pd.DataFrame, forwards: Sequence[int]) -> Dict[int, pd.DataFrame]:
    result = {}
    for f in forwards:
        fwd = close.shift(-f) / close - 1.0
        result[f] = fwd
    return result


def save_indicators(
    conn: sqlite3.Connection,
    momentum_dict: Dict[int, pd.DataFrame],
    since: Optional[str] = None,
) -> int:
    now = datetime.now().isoformat()
    rows = []
    for period_days, mom_df in momentum_dict.items():
        for date_val in mom_df.index:
            date_str = str(date_val)[:10]
            if since and date_str < since:
                continue
            for concept in mom_df.columns:
                val = mom_df.at[date_val, concept]
                if pd.isna(val):
                    continue
                rows.append((concept, date_str, period_days, float(val), None, 1 if val > 0 else 0, now))

    if rows:
        conn.executemany(
            """INSERT OR REPLACE INTO concept_indicators
               (concept, date, period_days, momentum_return, momentum_rank, has_momentum, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()
    return len(rows)


def save_concept_ic(conn: sqlite3.Connection, ic_df: pd.DataFrame, period_days: int, forward_days: int) -> int:
    now = datetime.now().isoformat()
    rows = []
    factor_name = f"concept_momentum_{period_days}d_forward{forward_days}d"
    for date_val in ic_df.index:
        val = ic_df.loc[date_val]
        if pd.isna(val):
            continue
        rows.append((str(date_val)[:10], factor_name, float(val), None, now))

    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO factor_ic (date, factor_name, ic_value, sample_count, updated_at) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    return len(rows)


def calc_all(
    conn: sqlite3.Connection,
    concepts: Optional[List[str]] = None,
    periods: Sequence[int] = (20,),
    forwards: Sequence[int] = (5,),
    since: Optional[str] = None,
) -> dict:
    ensure_tables(conn)

    if concepts is None:
        concepts = get_tracked_concepts(conn)
    if not concepts:
        return {"error": "no concepts to compute"}

    print(f"Computing momentum for {len(concepts)} concepts...")

    close = load_synthetic_klines(conn, concepts)
    if close.empty:
        return {"error": "no synthetic kline data"}

    print(f"  Close matrix: {close.shape[0]} dates x {close.shape[1]} concepts")

    momentum_dict = compute_momentum(close, periods)
    forward_dict = compute_forward_returns(close, forwards)

    n_indicators = save_indicators(conn, momentum_dict, since=since)
    print(f"  Saved {n_indicators} indicator rows")

    # Compute IC
    total_ic = 0
    for p in periods:
        for f in forwards:
            mom = momentum_dict[p]
            fwd = forward_dict[f]
            ic = compute_ic(mom, fwd)
            if ic is not None and not ic.empty:
                mean_ic = ic.mean()
                n = save_concept_ic(conn, ic, p, f)
                total_ic += n
                print(f"  IC concept_momentum_{p}d_forward{f}d: mean={mean_ic:.4f}, rows={n}")

    return {
        "concepts": len(concepts),
        "date_range": f"{close.index[0]} ~ {close.index[-1]}",
        "indicators_saved": n_indicators,
        "ic_rows_saved": total_ic,
    }


def main():
    parser = argparse.ArgumentParser(description="Concept momentum & IC computation")
    parser.add_argument("--periods", default="20", help="Comma-separated momentum periods")
    parser.add_argument("--forwards", default="5", help="Comma-separated forward periods")
    parser.add_argument("--since", help="Only compute on or after YYYY-MM-DD")
    args = parser.parse_args()

    periods = tuple(int(x.strip()) for x in args.periods.split(","))
    forwards = tuple(int(x.strip()) for x in args.forwards.split(","))

    conn = get_db()
    try:
        result = calc_all(conn, periods=periods, forwards=forwards, since=args.since)
        print(f"Done: {result}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
