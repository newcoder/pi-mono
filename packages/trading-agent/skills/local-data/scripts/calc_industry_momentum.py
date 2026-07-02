#!/usr/bin/env python3
"""
Industry Momentum Factor Calculator
====================================
Reads `industry_klines`, computes per-industry momentum returns and ranks, then
calculates the cross-sectional Spearman IC between momentum and forward returns.

Results are written to:
  - `industry_indicators` (per industry / date / lookback window)
  - `factor_ic` (aggregate factor effectiveness, reusable for other factors)

Usage:
  python calc_industry_momentum.py --all
  python calc_industry_momentum.py --since 2024-01-01 --periods 20 --forwards 5
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
import json
import sqlite3
from local_data.db import get_db, get_db_path, db_exists
from datetime import datetime
from typing import Dict, List, Optional, Sequence, Tuple

import pandas as pd

def ensure_tables(conn: sqlite3.Connection):
    """Create industry_indicators and factor_ic tables if not exists."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS industry_indicators (
            code TEXT NOT NULL,
            date TEXT NOT NULL,
            period_days INTEGER NOT NULL,
            momentum_return REAL,
            momentum_rank INTEGER,
            has_momentum INTEGER,
            updated_at TEXT,
            PRIMARY KEY (code, date, period_days)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_indicators_date
        ON industry_indicators(date, period_days)
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS factor_ic (
            date TEXT NOT NULL,
            factor_name TEXT NOT NULL,
            ic_value REAL,
            sample_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (date, factor_name)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_factor_ic_lookup
        ON factor_ic(factor_name, date)
    """)
    conn.commit()


def load_klines(conn: sqlite3.Connection) -> pd.DataFrame:
    """Load all daily industry klines into a DataFrame."""
    sql = """
        SELECT code, date, close
        FROM industry_klines
        WHERE period = 'daily'
        ORDER BY code, date
    """
    df = pd.read_sql_query(sql, conn)
    df["date"] = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    return df


def build_close_matrix(df: pd.DataFrame) -> pd.DataFrame:
    """Pivot to a wide matrix: index=date, columns=code, values=close."""
    matrix = df.pivot(index="date", columns="code", values="close").sort_index()
    return matrix


def compute_momentum(close: pd.DataFrame, periods: Sequence[int]) -> Dict[int, pd.DataFrame]:
    """Compute momentum returns for each lookback window."""
    return {p: close / close.shift(p) - 1 for p in periods}


def compute_forward_returns(close: pd.DataFrame, forwards: Sequence[int]) -> Dict[int, pd.DataFrame]:
    """Compute forward returns for each forward window."""
    return {f: close.shift(-f) / close - 1 for f in forwards}


def compute_ic(
    momentum: pd.DataFrame,
    forward: pd.DataFrame,
    min_samples: int = 5,
) -> pd.DataFrame:
    """
    Compute daily cross-sectional Spearman IC between momentum and forward return.
    Returns DataFrame with columns [date, ic_value, sample_count].
    """
    mom_stack = momentum.reset_index().melt(id_vars="date", var_name="code", value_name="mom")
    fwd_stack = forward.reset_index().melt(id_vars="date", var_name="code", value_name="fwd")
    merged = mom_stack.merge(fwd_stack, on=["date", "code"], how="inner")
    merged = merged.dropna(subset=["mom", "fwd"])

    def _spearman(group: pd.DataFrame) -> Optional[Tuple[float, int]]:
        if len(group) < min_samples:
            return None
        ic = group["mom"].corr(group["fwd"], method="spearman")
        if pd.isna(ic):
            return None
        return float(ic), len(group)

    results: List[Dict] = []
    for date, group in merged.groupby("date"):
        res = _spearman(group)
        if res:
            results.append({"date": date, "ic_value": res[0], "sample_count": res[1]})

    return pd.DataFrame(results)


def build_indicator_rows(
    momentum_dict: Dict[int, pd.DataFrame],
    since: Optional[str] = None,
) -> List[Dict]:
    """Flatten momentum matrices into rows for `industry_indicators`."""
    rows: List[Dict] = []
    since_dt = pd.to_datetime(since) if since else None

    for period, mat in momentum_dict.items():
        ranks = mat.rank(axis=1, ascending=False, method="min")
        has_momentum = (mat > 0).astype("Int64")

        for date in mat.index:
            if since_dt is not None and date < since_dt:
                continue
            for code in mat.columns:
                mom = mat.loc[date, code]
                if pd.isna(mom):
                    continue
                rows.append({
                    "code": code,
                    "date": date.strftime("%Y-%m-%d"),
                    "period_days": period,
                    "momentum_return": float(mom),
                    "momentum_rank": int(ranks.loc[date, code]) if not pd.isna(ranks.loc[date, code]) else None,
                    "has_momentum": int(has_momentum.loc[date, code]) if not pd.isna(has_momentum.loc[date, code]) else None,
                })
    return rows


def build_ic_rows(
    momentum_dict: Dict[int, pd.DataFrame],
    forward_dict: Dict[int, pd.DataFrame],
    since: Optional[str] = None,
) -> List[Dict]:
    """Flatten IC results into rows for `factor_ic`."""
    since_dt = pd.to_datetime(since) if since else None
    rows: List[Dict] = []
    for period in momentum_dict:
        for forward in forward_dict:
            factor_name = f"industry_momentum_{period}d_forward{forward}d"
            ic_df = compute_ic(momentum_dict[period], forward_dict[forward])
            for _, row in ic_df.iterrows():
                if since_dt is not None and row["date"] < since_dt:
                    continue
                rows.append({
                    "date": row["date"].strftime("%Y-%m-%d"),
                    "factor_name": factor_name,
                    "ic_value": float(row["ic_value"]),
                    "sample_count": int(row["sample_count"]),
                })
    return rows


def save_indicators(conn: sqlite3.Connection, indicators: List[Dict]) -> int:
    """Upsert per-industry momentum rows."""
    if not indicators:
        return 0
    now = datetime.now().isoformat()
    sql = """
        INSERT OR REPLACE INTO industry_indicators
        (code, date, period_days, momentum_return, momentum_rank, has_momentum, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    rows = [
        (
            r["code"], r["date"], r["period_days"],
            r["momentum_return"], r["momentum_rank"], r["has_momentum"], now,
        )
        for r in indicators
    ]
    conn.executemany(sql, rows)
    conn.commit()
    return len(rows)


def save_ic(conn: sqlite3.Connection, ic_rows: List[Dict]) -> int:
    """Upsert factor IC rows."""
    if not ic_rows:
        return 0
    now = datetime.now().isoformat()
    sql = """
        INSERT OR REPLACE INTO factor_ic
        (date, factor_name, ic_value, sample_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
    """
    rows = [
        (r["date"], r["factor_name"], r["ic_value"], r["sample_count"], now)
        for r in ic_rows
    ]
    conn.executemany(sql, rows)
    conn.commit()
    return len(rows)


def calc_all(
    conn: sqlite3.Connection,
    periods: Sequence[int] = (20,),
    forwards: Sequence[int] = (5,),
    since: Optional[str] = None,
) -> Dict:
    """Recalculate industry momentum and IC for all industries."""
    ensure_tables(conn)

    print("[calc_industry_momentum] Loading industry klines...", file=sys.stderr)
    df = load_klines(conn)
    if df.empty:
        return {"error": "No industry klines found"}

    print("[calc_industry_momentum] Building close price matrix...", file=sys.stderr)
    close = build_close_matrix(df)
    if close.shape[1] == 0:
        return {"error": "No industries with close prices"}

    print(f"[calc_industry_momentum] Matrix shape: {close.shape}", file=sys.stderr)

    momentum_dict = compute_momentum(close, periods)
    forward_dict = compute_forward_returns(close, forwards)

    print("[calc_industry_momentum] Building indicator rows...", file=sys.stderr)
    indicator_rows = build_indicator_rows(momentum_dict, since=since)
    inserted_indicators = save_indicators(conn, indicator_rows)
    print(f"[calc_industry_momentum] Saved {inserted_indicators} indicator rows", file=sys.stderr)

    print("[calc_industry_momentum] Computing IC...", file=sys.stderr)
    ic_rows = build_ic_rows(momentum_dict, forward_dict, since=since)
    inserted_ic = save_ic(conn, ic_rows)
    print(f"[calc_industry_momentum] Saved {inserted_ic} IC rows", file=sys.stderr)

    # Summary stats per factor
    summary: Dict[str, Dict] = {}
    if ic_rows:
        ic_df = pd.DataFrame(ic_rows)
        for factor_name, group in ic_df.groupby("factor_name"):
            summary[factor_name] = {
                "mean_ic": float(group["ic_value"].mean()),
                "std_ic": float(group["ic_value"].std()),
                "positive_ratio": float((group["ic_value"] > 0).mean()),
                "count": int(len(group)),
            }

    return {
        "industries": int(close.shape[1]),
        "trading_days": int(close.shape[0]),
        "indicator_rows": inserted_indicators,
        "ic_rows": inserted_ic,
        "summary": summary,
    }


def main():
    parser = argparse.ArgumentParser(description="Calculate industry momentum factor and IC")
    parser.add_argument("--all", action="store_true", help="Recalc all history")
    parser.add_argument("--since", help="Only process dates >= YYYY-MM-DD")
    parser.add_argument("--periods", default="20", help="Comma-separated lookback windows (default: 20)")
    parser.add_argument("--forwards", default="5", help="Comma-separated forward windows (default: 5)")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    if not args.all and not args.since:
        print("Error: specify --all or --since", file=sys.stderr)
        sys.exit(1)

    periods = [int(p.strip()) for p in args.periods.split(",") if p.strip()]
    forwards = [int(f.strip()) for f in args.forwards.split(",") if f.strip()]

    conn = get_db()
    try:
        result = calc_all(conn, periods=periods, forwards=forwards, since=args.since)
    finally:
        conn.close()

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    if args.output:
        out_dir = os.path.dirname(args.output)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Result saved to: {args.output}", file=sys.stderr)
    else:
        print(result_json)


if __name__ == "__main__":
    main()
