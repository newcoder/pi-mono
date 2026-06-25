#!/usr/bin/env python3
"""
Shenwan Industry Equal-Weight Momentum IC Calculator
=====================================================
Builds equal-weight, qfq-adjusted synthetic industry indices from stock klines
and adjust_factors, then computes momentum-forward IC.

Usage:
  python calc_sw_industry_momentum.py --all
  python calc_sw_industry_momentum.py --since 2024-01-01 --periods 20 --forwards 5
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime
from typing import Dict, List, Optional, Sequence, Tuple

import pandas as pd

# Reuse IC computation from the BK-sector momentum script
from calc_industry_momentum import compute_ic

_DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_tables(conn: sqlite3.Connection):
    """Create required tables if not exists."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS industry_synthetic_klines (
            code TEXT NOT NULL,
            standard TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL,
            constituent_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (code, standard, date)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_synthetic_klines_lookup
        ON industry_synthetic_klines(code, standard, date)
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


def load_industries(conn: sqlite3.Connection, standard: str) -> List[Tuple[str, str]]:
    """Load (code, name) list for a given industry standard."""
    rows = conn.execute(
        "SELECT industry_code, name FROM industries WHERE standard = ? ORDER BY industry_code",
        (standard,),
    ).fetchall()
    return [(r["industry_code"], r["name"]) for r in rows]


def load_constituents(conn: sqlite3.Connection, industry_code: str, standard: str) -> List[Tuple[str, int]]:
    """Load (code, market) constituents for an industry."""
    rows = conn.execute(
        """
        SELECT code, market FROM stock_industries
        WHERE industry_code = ? AND standard = ?
        """,
        (industry_code, standard),
    ).fetchall()
    return [(r["code"], r["market"]) for r in rows]


def _chunked(items: List[Tuple[str, int]], size: int):
    """Yield chunks of (code, market) pairs."""
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _load_stock_prices(
    conn: sqlite3.Connection,
    constituents: List[Tuple[str, int]],
    chunk_size: int = 300,
) -> pd.DataFrame:
    """
    Load qfq-adjusted close prices for a list of (code, market) pairs.
    Returns DataFrame with columns [date, code_market, qfq_close].
    """
    frames: List[pd.DataFrame] = []
    for chunk in _chunked(constituents, chunk_size):
        placeholders = ",".join(["(?, ?)"] * len(chunk))
        params = [v for pair in chunk for v in pair]
        sql = f"""
            SELECT k.code, k.market, k.date, k.close, COALESCE(af.qfq_factor, 1.0) AS qfq_factor
            FROM klines k
            LEFT JOIN adjust_factors af
                ON k.code = af.code AND k.market = af.market AND k.date = af.date
            WHERE k.adjust = 'bfq'
              AND (k.code, k.market) IN ({placeholders})
        """
        df = pd.read_sql_query(sql, conn, params=params)
        if df.empty:
            continue
        df["date"] = pd.to_datetime(df["date"])
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df["qfq_factor"] = pd.to_numeric(df["qfq_factor"], errors="coerce").fillna(1.0)
        df["qfq_close"] = df["close"] * df["qfq_factor"]
        df["code_market"] = df["code"] + "_" + df["market"].astype(str)
        df = df.drop_duplicates(subset=["date", "code_market"])
        frames.append(df[["date", "code_market", "qfq_close"]])

    if not frames:
        return pd.DataFrame(columns=["date", "code_market", "qfq_close"])
    return pd.concat(frames, ignore_index=True)


def build_equal_weight_index(
    conn: sqlite3.Connection,
    industry_code: str,
    standard: str,
    min_constituents: int = 3,
) -> pd.DataFrame:
    """
    Build an equal-weighted, qfq-adjusted synthetic index for one industry.
    Returns DataFrame indexed by date with columns [close, constituent_count].
    """
    constituents = load_constituents(conn, industry_code, standard)
    if len(constituents) < min_constituents:
        return pd.DataFrame(columns=["close", "constituent_count"])

    df = _load_stock_prices(conn, constituents)
    if df.empty:
        return pd.DataFrame(columns=["close", "constituent_count"])

    prices = df.pivot(index="date", columns="code_market", values="qfq_close").sort_index()
    constituent_count = prices.notna().sum(axis=1)

    # Daily return = equal-weight average of individual stock returns
    returns = prices.pct_change(fill_method=None)
    avg_returns = returns.mean(axis=1, skipna=True)

    # Mask dates with too few constituents
    avg_returns = avg_returns.where(constituent_count >= min_constituents)

    # Compound to index level starting at 1.0
    index_values = (1 + avg_returns.fillna(0)).cumprod()
    index_values = index_values.to_frame(name="close")
    index_values["constituent_count"] = constituent_count
    return index_values


def save_synthetic_klines(
    conn: sqlite3.Connection,
    industry_code: str,
    standard: str,
    index_df: pd.DataFrame,
    since: Optional[str] = None,
) -> int:
    """Upsert synthetic index rows."""
    if index_df.empty:
        return 0

    since_dt = pd.to_datetime(since) if since else None
    now = datetime.now().isoformat()

    sql = """
        INSERT OR REPLACE INTO industry_synthetic_klines
        (code, standard, date, close, constituent_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """
    rows = []
    for date, row in index_df.iterrows():
        if since_dt is not None and date < since_dt:
            continue
        rows.append(
            (
                industry_code,
                standard,
                date.strftime("%Y-%m-%d"),
                float(row["close"]) if not pd.isna(row["close"]) else None,
                int(row["constituent_count"]) if not pd.isna(row["constituent_count"]) else None,
                now,
            )
        )

    if not rows:
        return 0
    conn.executemany(sql, rows)
    conn.commit()
    return len(rows)


def save_industry_indicators(
    conn: sqlite3.Connection,
    momentum_dict: Dict[int, pd.DataFrame],
    since: Optional[str] = None,
) -> int:
    """Upsert per-industry momentum rows into industry_indicators."""
    since_dt = pd.to_datetime(since) if since else None
    now = datetime.now().isoformat()

    sql = """
        INSERT OR REPLACE INTO industry_indicators
        (code, date, period_days, momentum_return, momentum_rank, has_momentum, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    rows: List[Tuple] = []
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
                rank_val = ranks.loc[date, code]
                hm_val = has_momentum.loc[date, code]
                rows.append(
                    (
                        code,
                        date.strftime("%Y-%m-%d"),
                        period,
                        float(mom),
                        int(rank_val) if not pd.isna(rank_val) else None,
                        int(hm_val) if not pd.isna(hm_val) else None,
                        now,
                    )
                )

    if not rows:
        return 0
    conn.executemany(sql, rows)
    conn.commit()
    return len(rows)


def build_close_matrix(
    conn: sqlite3.Connection,
    industries: List[Tuple[str, str]],
    standard: str,
) -> pd.DataFrame:
    """Load saved synthetic klines into a wide close-price matrix."""
    code_list = [code for code, _ in industries]
    if not code_list:
        return pd.DataFrame()

    # SQLite parameter limit workaround: chunk the IN clause
    chunks = [code_list[i : i + 300] for i in range(0, len(code_list), 300)]
    frames: List[pd.DataFrame] = []
    for chunk in chunks:
        placeholders = ",".join(["?"] * len(chunk))
        sql = f"""
            SELECT code, date, close
            FROM industry_synthetic_klines
            WHERE standard = ? AND code IN ({placeholders})
        """
        df = pd.read_sql_query(sql, conn, params=(standard, *chunk))
        if df.empty:
            continue
        df["date"] = pd.to_datetime(df["date"])
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        frames.append(df)

    if not frames:
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    matrix = combined.pivot(index="date", columns="code", values="close").sort_index()
    return matrix


def compute_momentum(close: pd.DataFrame, periods: Sequence[int]) -> Dict[int, pd.DataFrame]:
    return {p: close / close.shift(p) - 1 for p in periods}


def compute_forward_returns(close: pd.DataFrame, forwards: Sequence[int]) -> Dict[int, pd.DataFrame]:
    return {f: close.shift(-f) / close - 1 for f in forwards}


def build_ic_rows(
    momentum_dict: Dict[int, pd.DataFrame],
    forward_dict: Dict[int, pd.DataFrame],
    factor_prefix: str,
    since: Optional[str] = None,
) -> List[Dict]:
    """Flatten IC results into rows for `factor_ic`."""
    since_dt = pd.to_datetime(since) if since else None
    rows: List[Dict] = []
    for period in momentum_dict:
        for forward in forward_dict:
            factor_name = f"{factor_prefix}_{period}d_forward{forward}d"
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


def save_ic(conn: sqlite3.Connection, ic_rows: List[Dict]) -> int:
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
    standard: str = "sw_l1",
    periods: Sequence[int] = (20,),
    forwards: Sequence[int] = (5,),
    min_constituents: int = 3,
    since: Optional[str] = None,
) -> Dict:
    """Build synthetic indices and compute IC for a given industry standard."""
    ensure_tables(conn)

    industries = load_industries(conn, standard)
    if not industries:
        return {"error": f"No industries found for standard {standard}"}

    print(f"[calc_sw_industry_momentum] Found {len(industries)} industries for {standard}", file=sys.stderr)

    # Step 1: build and save synthetic indices
    total_klines = 0
    valid_industries: List[Tuple[str, str]] = []
    for code, name in industries:
        idx_df = build_equal_weight_index(conn, code, standard, min_constituents=min_constituents)
        if idx_df.empty:
            print(f"  {code}({name}): skipped (too few constituents)", file=sys.stderr)
            continue
        inserted = save_synthetic_klines(conn, code, standard, idx_df, since=since)
        total_klines += inserted
        valid_industries.append((code, name))
        print(f"  {code}({name}): {inserted} days, avg constituents {idx_df['constituent_count'].mean():.0f}", file=sys.stderr)

    print(f"[calc_sw_industry_momentum] Saved {total_klines} synthetic klines for {len(valid_industries)} industries", file=sys.stderr)

    # Step 2: compute momentum and IC
    close = build_close_matrix(conn, valid_industries, standard)
    if close.empty or close.shape[1] < 2:
        return {"error": "Not enough valid synthetic indices to compute IC"}

    momentum_dict = compute_momentum(close, periods)
    forward_dict = compute_forward_returns(close, forwards)

    print("[calc_sw_industry_momentum] Saving industry momentum indicators...", file=sys.stderr)
    inserted_indicators = save_industry_indicators(conn, momentum_dict, since=since)
    print(f"[calc_sw_industry_momentum] Saved {inserted_indicators} indicator rows", file=sys.stderr)

    factor_prefix = f"{standard}_eq_weight_momentum"
    ic_rows = build_ic_rows(momentum_dict, forward_dict, factor_prefix, since=since)
    inserted_ic = save_ic(conn, ic_rows)
    print(f"[calc_sw_industry_momentum] Saved {inserted_ic} IC rows", file=sys.stderr)

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
        "standard": standard,
        "industries_total": len(industries),
        "industries_valid": len(valid_industries),
        "synthetic_klines": total_klines,
        "indicator_rows": inserted_indicators,
        "ic_rows": inserted_ic,
        "summary": summary,
    }


def main():
    parser = argparse.ArgumentParser(description="Calculate SW L1 equal-weight industry momentum IC")
    parser.add_argument("--all", action="store_true", help="Recalc all history")
    parser.add_argument("--since", help="Only process dates >= YYYY-MM-DD")
    parser.add_argument("--standard", default="sw_l1", help="Industry standard (default: sw_l1)")
    parser.add_argument("--periods", default="20", help="Comma-separated lookback windows")
    parser.add_argument("--forwards", default="5", help="Comma-separated forward windows")
    parser.add_argument("--min-constituents", type=int, default=3, help="Minimum constituents per date")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    if not args.all and not args.since:
        print("Error: specify --all or --since", file=sys.stderr)
        sys.exit(1)

    periods = [int(p.strip()) for p in args.periods.split(",") if p.strip()]
    forwards = [int(f.strip()) for f in args.forwards.split(",") if f.strip()]

    conn = get_db()
    try:
        result = calc_all(
            conn,
            standard=args.standard,
            periods=periods,
            forwards=forwards,
            min_constituents=args.min_constituents,
            since=args.since,
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
