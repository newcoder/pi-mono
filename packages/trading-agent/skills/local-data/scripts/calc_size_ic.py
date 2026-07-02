#!/usr/bin/env python3
"""
Size Factor IC Calculator
=========================
Computes the cross-sectional Spearman IC between market-cap (size) factor
and forward stock returns, saved to `factor_ic`.

Usage:
  python calc_size_ic.py --all
  python calc_size_ic.py --since 2024-01-01 --forwards 5,10,20
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
from typing import Dict, List, Optional, Sequence

import pandas as pd

from calc_industry_momentum import compute_ic

def ensure_tables(conn: sqlite3.Connection):
    """Ensure required tables exist."""
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_indicators (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            date TEXT NOT NULL,
            indicator_name TEXT NOT NULL,
            indicator_value REAL,
            indicator_rank INTEGER,
            has_signal INTEGER,
            updated_at TEXT,
            PRIMARY KEY (code, market, date, indicator_name)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_stock_indicators_lookup
        ON stock_indicators(code, market, date, indicator_name)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_stock_indicators_name_date
        ON stock_indicators(indicator_name, date)
    """)
    conn.commit()


def load_stock_universe(conn: sqlite3.Connection) -> pd.DataFrame:
    """Load all (code, market) pairs from stocks table."""
    df = pd.read_sql_query(
        "SELECT code, market FROM stocks ORDER BY code, market",
        conn,
    )
    df["code_market"] = df["code"] + "_" + df["market"].astype(str)
    return df


def _chunked(items: List[str], size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def load_qfq_close_matrix(
    conn: sqlite3.Connection,
    universe: pd.DataFrame,
    start: Optional[str],
    end: Optional[str],
    chunk_size: int = 500,
) -> pd.DataFrame:
    """Load qfq-adjusted close price matrix (date x code_market)."""
    code_markets = universe["code_market"].tolist()
    params_base: List[str] = []
    where_parts = ["k.adjust = 'bfq'", "k.period = 'daily'"]
    if start:
        where_parts.append("k.date >= ?")
        params_base.append(start)
    if end:
        where_parts.append("k.date <= ?")
        params_base.append(end)
    where_sql = " AND ".join(where_parts)

    frames: List[pd.DataFrame] = []
    for chunk in _chunked(code_markets, chunk_size):
        placeholders = ",".join(["?"] * len(chunk))
        sql = f"""
            SELECT k.code, k.market, k.date,
                   k.close * COALESCE(af.qfq_factor, 1.0) AS qfq_close
            FROM klines k
            LEFT JOIN adjust_factors af
                ON k.code = af.code AND k.market = af.market AND k.date = af.date
            WHERE k.code || '_' || k.market IN ({placeholders})
              AND {where_sql}
        """
        df = pd.read_sql_query(sql, conn, params=chunk + params_base)
        if df.empty:
            continue
        df["date"] = pd.to_datetime(df["date"])
        df["qfq_close"] = pd.to_numeric(df["qfq_close"], errors="coerce")
        df["code_market"] = df["code"] + "_" + df["market"].astype(str)
        df = df.drop_duplicates(subset=["date", "code_market"])
        frames.append(df[["date", "code_market", "qfq_close"]])

    if not frames:
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    matrix = combined.pivot(index="date", columns="code_market", values="qfq_close").sort_index()
    return matrix


def load_total_shares_matrix(
    conn: sqlite3.Connection,
    universe: pd.DataFrame,
    end: Optional[str],
) -> pd.DataFrame:
    """
    Load total_shares history and forward-fill to a daily matrix.
    Returns DataFrame indexed by report_date, columns code_market.
    """
    code_markets = universe["code_market"].tolist()
    params: List[str] = []
    where_parts = ["total_shares IS NOT NULL", "total_shares > 0"]
    if end:
        where_parts.append("report_date <= ?")
        params.append(end)

    where_sql = " AND ".join(where_parts)

    # Chunk by code_market string using IN clause
    frames: List[pd.DataFrame] = []
    for chunk in _chunked(code_markets, 500):
        placeholders = ",".join(["?"] * len(chunk))
        sql = f"""
            SELECT code, market, report_date, total_shares
            FROM fundamentals
            WHERE code || '_' || market IN ({placeholders})
              AND {where_sql}
        """
        df = pd.read_sql_query(sql, conn, params=chunk + params)
        if df.empty:
            continue
        df["report_date"] = pd.to_datetime(df["report_date"])
        df["total_shares"] = pd.to_numeric(df["total_shares"], errors="coerce")
        df["code_market"] = df["code"] + "_" + df["market"].astype(str)
        df = df.drop_duplicates(subset=["report_date", "code_market"])
        frames.append(df[["report_date", "code_market", "total_shares"]])

    if not frames:
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    matrix = combined.pivot(index="report_date", columns="code_market", values="total_shares").sort_index()
    return matrix


def build_market_cap_matrix(
    close: pd.DataFrame,
    shares: pd.DataFrame,
) -> pd.DataFrame:
    """
    Align shares to close dates by forward-filling, then multiply.
    Returns market-cap matrix (date x code_market).
    """
    if shares.empty:
        return pd.DataFrame()

    # Forward-fill shares to daily close dates
    shares_aligned = shares.reindex(close.index, method="ffill")
    # Align columns
    common_cols = close.columns.intersection(shares_aligned.columns)
    close_sub = close[common_cols]
    shares_sub = shares_aligned[common_cols]
    return close_sub * shares_sub


def compute_forward_returns(close: pd.DataFrame, forwards: Sequence[int]) -> Dict[int, pd.DataFrame]:
    return {f: close.shift(-f) / close - 1 for f in forwards}


def save_ic(conn: sqlite3.Connection, ic_rows: List[Dict]) -> int:
    if not ic_rows:
        return 0
    now = datetime.now().isoformat()
    sql = """
        INSERT OR REPLACE INTO factor_ic
        (date, factor_name, ic_value, sample_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
    """
    rows = [(r["date"], r["factor_name"], r["ic_value"], r["sample_count"], now) for r in ic_rows]
    conn.executemany(sql, rows)
    conn.commit()
    return len(rows)


def save_stock_indicators(
    conn: sqlite3.Connection,
    mcap: pd.DataFrame,
    indicator_name: str = "size_mcap",
    since: Optional[str] = None,
    chunk_size: int = 5000,
) -> int:
    """Upsert per-stock size ranks into stock_indicators."""
    since_dt = pd.to_datetime(since) if since else None
    now = datetime.now().isoformat()

    # Ascending rank: 1 = smallest market cap
    ranks = mcap.rank(axis=1, ascending=True, method="min")
    has_signal = mcap.notna().astype("Int64")

    # Parse code_market back to code/market
    col_meta: Dict[str, Tuple[str, int]] = {}
    for col in mcap.columns:
        parts = col.rsplit("_", 1)
        col_meta[col] = (parts[0], int(parts[1]))

    sql = """
        INSERT OR REPLACE INTO stock_indicators
        (code, market, date, indicator_name, indicator_value, indicator_rank, has_signal, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """

    batch: List[Tuple] = []
    total = 0
    for date in mcap.index:
        if since_dt is not None and date < since_dt:
            continue
        date_str = date.strftime("%Y-%m-%d")
        for col in mcap.columns:
            val = mcap.loc[date, col]
            if pd.isna(val):
                continue
            rank_val = ranks.loc[date, col]
            hs_val = has_signal.loc[date, col]
            code, market = col_meta[col]
            batch.append(
                (
                    code,
                    market,
                    date_str,
                    indicator_name,
                    float(val),
                    int(rank_val) if not pd.isna(rank_val) else None,
                    int(hs_val) if not pd.isna(hs_val) else None,
                    now,
                )
            )
            if len(batch) >= chunk_size:
                conn.executemany(sql, batch)
                total += len(batch)
                batch = []

    if batch:
        conn.executemany(sql, batch)
        total += len(batch)
    conn.commit()
    return total


def calc_all(
    conn: sqlite3.Connection,
    forwards: Sequence[int] = (5,),
    start: Optional[str] = None,
    end: Optional[str] = None,
    min_samples: int = 50,
) -> Dict:
    """Compute size factor IC for all available stocks."""
    ensure_tables(conn)

    universe = load_stock_universe(conn)
    print(f"[calc_size_ic] Universe: {len(universe)} stocks", file=sys.stderr)

    print("[calc_size_ic] Loading qfq close prices...", file=sys.stderr)
    close = load_qfq_close_matrix(conn, universe, start, end)
    if close.empty:
        return {"error": "No close prices loaded"}
    print(f"[calc_size_ic] Close matrix: {close.shape}", file=sys.stderr)

    print("[calc_size_ic] Loading total shares...", file=sys.stderr)
    shares = load_total_shares_matrix(conn, universe, end)
    if shares.empty:
        return {"error": "No total shares data"}
    print(f"[calc_size_ic] Shares matrix: {shares.shape}", file=sys.stderr)

    print("[calc_size_ic] Building market cap matrix...", file=sys.stderr)
    mcap = build_market_cap_matrix(close, shares)
    if mcap.empty:
        return {"error": "Market cap matrix empty"}
    print(f"[calc_size_ic] Market cap matrix: {mcap.shape}", file=sys.stderr)

    print("[calc_size_ic] Computing forward returns...", file=sys.stderr)
    forward_dict = compute_forward_returns(close, forwards)

    print("[calc_size_ic] Computing IC...", file=sys.stderr)
    ic_rows: List[Dict] = []
    for forward in forwards:
        factor_name = f"size_forward{forward}d"
        ic_df = compute_ic(mcap, forward_dict[forward], min_samples=min_samples)
        for _, row in ic_df.iterrows():
            dt = row["date"]
            if start and dt.strftime("%Y-%m-%d") < start:
                continue
            if end and dt.strftime("%Y-%m-%d") > end:
                continue
            ic_rows.append({
                "date": dt.strftime("%Y-%m-%d"),
                "factor_name": factor_name,
                "ic_value": float(row["ic_value"]),
                "sample_count": int(row["sample_count"]),
            })

    inserted = save_ic(conn, ic_rows)
    print(f"[calc_size_ic] Saved {inserted} IC rows", file=sys.stderr)

    print("[calc_size_ic] Saving stock size indicators...", file=sys.stderr)
    inserted_indicators = save_stock_indicators(conn, mcap, indicator_name="size_mcap", since=start)
    print(f"[calc_size_ic] Saved {inserted_indicators} stock indicator rows", file=sys.stderr)

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
        "stocks": len(universe),
        "close_dates": int(close.shape[0]),
        "stocks_with_data": int(close.shape[1]),
        "ic_rows": inserted,
        "indicator_rows": inserted_indicators,
        "summary": summary,
    }


def main():
    parser = argparse.ArgumentParser(description="Calculate size (market cap) factor IC")
    parser.add_argument("--all", action="store_true", help="Recalc all history")
    parser.add_argument("--since", help="Only process dates >= YYYY-MM-DD")
    parser.add_argument("--start", help="Start date YYYY-MM-DD (alias for --since)")
    parser.add_argument("--end", help="End date YYYY-MM-DD")
    parser.add_argument("--forwards", default="5", help="Comma-separated forward windows")
    parser.add_argument("--min-samples", type=int, default=50, help="Minimum stocks per day to compute IC")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    if not args.all and not args.since and not args.start:
        print("Error: specify --all or --since/--start", file=sys.stderr)
        sys.exit(1)

    forwards = [int(f.strip()) for f in args.forwards.split(",") if f.strip()]
    start = args.start or args.since

    conn = get_db()
    try:
        result = calc_all(
            conn,
            forwards=forwards,
            start=start,
            end=args.end,
            min_samples=args.min_samples,
        )
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
