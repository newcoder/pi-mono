#!/usr/bin/env python3
"""
Compare two methods for selecting main-theme constituent stocks:
  A: static concept_stocks membership
  B: dynamic hot_stocks reason mentions (rolling window)
Rolling monthly validation over 2024-2026.
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Set, Tuple

import pandas as pd
import numpy as np

from classify_themes import CONCEPT_MERGE_MAP

# Themes to test: parent → child concepts used for concept_stocks lookup and hot_stocks reason search
TEST_THEMES = {
    "人形机器人": ["人形机器人", "机器人", "机器人概念", "灵巧手", "减速器", "电子皮肤", "具身智能", "谐波减速器", "滚珠丝杠"],
    "半导体": ["半导体", "半导体设备", "先进封装", "存储芯片", "半导体封测", "半导体硅片", "功率半导体", "半导体材料", "半导体洁净室", "半导体封装", "光刻机", "光刻胶", "芯片"],
    "新能源": ["新能源", "光伏", "风电", "锂电池", "固态电池", "钠离子电池", "钙钛矿", "盐湖提锂", "充电桩", "储能"],
    "国企改革": ["国企改革", "央企改革", "国企", "国资"],
}


def month_end_dates(conn: sqlite3.Connection) -> List[str]:
    """Get last trading day of each month where hot_stocks data exists."""
    rows = conn.execute("""
        SELECT MAX(date) FROM hot_stocks
        WHERE date >= '2024-01-01' AND date <= '2026-07-05'
        GROUP BY strftime('%Y-%m', date)
        ORDER BY date
    """).fetchall()
    return [r[0] for r in rows if r[0]]


def get_trading_dates_before(conn: sqlite3.Connection, end_date: str, n: int) -> List[str]:
    rows = conn.execute(
        "SELECT DISTINCT date FROM hot_stocks WHERE date <= ? ORDER BY date DESC LIMIT ?",
        (end_date, n),
    ).fetchall()
    return [r[0] for r in rows]


def method_a_concept_stocks(conn: sqlite3.Connection, theme: str, keywords: List[str]) -> Set[str]:
    """Get stocks from concept_stocks matching any of the keywords."""
    placeholders = ",".join("?" for _ in keywords)
    rows = conn.execute(
        f"SELECT DISTINCT code FROM concept_stocks WHERE concept IN ({placeholders})",
        keywords,
    ).fetchall()
    return {r[0] for r in rows}


def method_b_hot_stocks(conn: sqlite3.Connection, keywords: List[str], dates: List[str]) -> Set[str]:
    """Get stocks from hot_stocks whose reasons mention any keyword, within given dates."""
    date_placeholders = ",".join("?" for _ in dates)
    stocks = set()
    for kw in keywords:
        rows = conn.execute(
            f"SELECT DISTINCT code FROM hot_stocks WHERE date IN ({date_placeholders}) AND reason LIKE ?",
            [*dates, f"%{kw}%"],
        ).fetchall()
        stocks.update(r[0] for r in rows)
    return stocks


def load_klines_matrix(
    conn: sqlite3.Connection, codes: List[str], start: str, end: str
) -> pd.DataFrame:
    """Load daily close prices for a set of stocks, return wide matrix indexed by date."""
    if not codes:
        return pd.DataFrame()
    placeholders = ",".join("?" for _ in codes)
    sql = f"""
        SELECT date, code, close FROM klines
        WHERE code IN ({placeholders})
          AND period = 'daily' AND adjust = 'bfq'
          AND close IS NOT NULL AND open IS NOT NULL
          AND date >= ? AND date <= ?
        ORDER BY date
    """
    df = pd.read_sql_query(sql, conn, params=[*codes, start, end])
    if df.empty:
        return pd.DataFrame()
    return df.pivot_table(index="date", columns="code", values="close", aggfunc="last")


def equal_weight_return(close_matrix: pd.DataFrame) -> pd.Series:
    """Compute daily equal-weight portfolio return."""
    if close_matrix.empty or close_matrix.shape[1] == 0:
        return pd.Series(dtype=float)
    returns = close_matrix.pct_change(fill_method=None).dropna(how="all")
    return returns.mean(axis=1, skipna=True)


def cross_sectional_dispersion(close_matrix: pd.DataFrame, lookback: int = 20) -> float:
    """Median daily cross-sectional std dev of returns over lookback."""
    if close_matrix.empty or close_matrix.shape[1] < 3:
        return float("nan")
    returns = close_matrix.pct_change(fill_method=None).dropna(how="all")
    if returns.empty:
        return float("nan")
    cs_std = returns.std(axis=1)
    recent = cs_std.iloc[-lookback:] if len(cs_std) > lookback else cs_std
    return float(recent.median())


def tracking_error(portfolio_returns: pd.Series, benchmark_returns: pd.Series) -> float:
    """Annualized tracking error between portfolio and benchmark."""
    combined = pd.concat([portfolio_returns, benchmark_returns], axis=1, join="inner").dropna()
    if len(combined) < 10:
        return float("nan")
    diff = combined.iloc[:, 0] - combined.iloc[:, 1]
    return float(diff.std() * np.sqrt(252))


def load_concept_benchmark(conn: sqlite3.Connection, concept: str, start: str, end: str) -> pd.Series:
    """Load concept synthetic kline as benchmark for tracking error."""
    rows = conn.execute(
        "SELECT date, close FROM concept_synthetic_klines WHERE concept = ? AND date >= ? AND date <= ? ORDER BY date",
        (concept, start, end),
    ).fetchall()
    if not rows:
        return pd.Series(dtype=float)
    df = pd.DataFrame(rows, columns=["date", "close"]).set_index("date")
    return df["close"].pct_change(fill_method=None).dropna()


def run_comparison(conn: sqlite3.Connection) -> pd.DataFrame:
    """Run rolling monthly comparison for all themes."""
    snapshots = month_end_dates(conn)
    print(f"Testing {len(snapshots)} monthly snapshots from {snapshots[0]} to {snapshots[-1]}")

    results = []

    for i, snapshot in enumerate(snapshots):
        if (i + 1) % 6 == 0:
            print(f"  [{i+1}/{len(snapshots)}] {snapshot}")

        # Lookback: 20 trading days before snapshot for method B
        lookback_dates = get_trading_dates_before(conn, snapshot, 20)
        # Forward: next month's dates for forward return
        next_month_start = snapshot
        next_month_end = snapshots[i + 1] if i + 1 < len(snapshots) else snapshot

        for theme, keywords in TEST_THEMES.items():
            # Method A: static concept stocks
            codes_a = method_a_concept_stocks(conn, theme, keywords)
            # Method B: dynamic hot stocks
            codes_b = method_b_hot_stocks(conn, keywords, lookback_dates)

            for method, codes in [("concept", codes_a), ("hot_stock", codes_b)]:
                if len(codes) < 3:
                    continue

                # Load klines for the snapshot month
                klines = load_klines_matrix(conn, list(codes), snapshot, next_month_end)
                if klines.empty or klines.shape[1] < 3:
                    continue

                # Equal-weight return over forward period
                eq_ret = equal_weight_return(klines)
                forward_ret = float((1 + eq_ret).prod() - 1) if not eq_ret.empty else float("nan")

                # Cross-sectional dispersion (on last day of snapshot window)
                snapshot_klines = load_klines_matrix(conn, list(codes), lookback_dates[0], snapshot)
                cs_disp = cross_sectional_dispersion(snapshot_klines) if not snapshot_klines.empty else float("nan")

                # Tracking error vs concept synthetic kline (use the first keyword as benchmark)
                bench_ret = load_concept_benchmark(conn, theme, lookback_dates[0], snapshot)
                te = tracking_error(eq_ret, bench_ret) if not eq_ret.empty and not bench_ret.empty else float("nan")

                # Overlap
                overlap = len(codes_a & codes_b) / max(len(codes_a | codes_b), 1) if method == "concept" else float("nan")

                results.append({
                    "snapshot": snapshot,
                    "theme": theme,
                    "method": method,
                    "pool_size": len(codes),
                    "forward_return": forward_ret,
                    "dispersion": cs_disp,
                    "tracking_error": te,
                    "overlap": overlap if method == "concept" else float("nan"),
                })

    return pd.DataFrame(results)


def summarize(df: pd.DataFrame):
    """Print summary table."""
    print("\n" + "=" * 110)
    print("Constituent Selection Method Comparison (2024-2026 monthly rolling)")
    print("=" * 110)

    summary = df.groupby(["theme", "method"]).agg(
        avg_size=("pool_size", "mean"),
        avg_forward_ret=("forward_return", "mean"),
        avg_dispersion=("dispersion", "mean"),
        avg_tracking_err=("tracking_error", "mean"),
        avg_overlap=("overlap", "mean"),
        snapshots=("snapshot", "count"),
    ).round(4)

    print(summary.to_string())
    print()

    # Winner per theme per metric
    metrics = {
        "avg_forward_ret": "higher",
        "avg_dispersion": "higher",
        "avg_tracking_err": "lower",
    }
    for metric, direction in metrics.items():
        print(f"--- {metric} ({direction} is better) ---")
        for theme in TEST_THEMES:
            subset = summary.loc[theme] if theme in summary.index else None
            if subset is None or len(subset) < 2:
                continue
            a_val = subset.loc["concept", metric] if "concept" in subset.index else None
            b_val = subset.loc["hot_stock", metric] if "hot_stock" in subset.index else None
            if a_val is None or b_val is None:
                continue
            if direction == "higher":
                winner = "hot_stock" if b_val > a_val else "concept"
            else:
                winner = "hot_stock" if b_val < a_val else "concept"
            print(f"  {theme}: concept={a_val:.4f}, hot_stock={b_val:.4f} → {winner}")

    return summary


def main():
    db_path = os.path.expanduser("~/.trading-agent/data/market.db")
    conn = sqlite3.connect(db_path)
    try:
        df = run_comparison(conn)
        summarize(df)
        # Save raw results
        out = os.path.join(os.path.dirname(__file__), "constituent_comparison.csv")
        df.to_csv(out, index=False)
        print(f"\nRaw data saved to {out}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
