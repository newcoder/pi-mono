#!/usr/bin/env python3
"""
概念股独立性筛选 - 在市场与概念负相关的时段中，找出真正跟随概念的股票
核心逻辑：
1. 找出概念指数与上证指数负相关的短期窗口（概念走出独立行情）
2. 在每个独立窗口内，计算成分股与概念指数的相关性
3. 综合多个窗口，按平均相关性和出现频率排序

用法: python concept_independence_filter.py --concept "存储芯片" [--window 3] [--min-windows 3] [--output result.json]
"""

import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

try:
    import akshare as ak
    import numpy as np
    import pandas as pd
except ImportError:
    print("Error: akshare, numpy, pandas required. pip install akshare numpy pandas")
    sys.exit(1)


# ─── Helpers ──────────────────────────────────────────────────


def _get_db_path() -> str:
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "."
    return os.path.join(home, ".trading-agent", "data", "market.db")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_nan(obj):
    if isinstance(obj, dict):
        return {k: clean_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean_nan(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
    return obj


def _fetch_concept_stocks_from_db(concept: str, db_path: str) -> list:
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT code, name FROM concept_stocks WHERE concept = ? ORDER BY code",
        (concept,),
    )
    rows = cursor.fetchall()
    conn.close()
    return [{"code": r[0], "name": r[1] or ""} for r in rows]


def _fetch_concept_stocks_from_akshare(concept: str) -> list:
    """Fallback: fetch concept constituent stocks directly from akshare."""
    try:
        df = ak.stock_board_concept_cons_em(symbol=concept)
        if df is None or df.empty:
            return []
        stocks = []
        for _, row in df.iterrows():
            code = str(row.iloc[1]) if len(row) > 1 else ""
            name = str(row.iloc[2]) if len(row) > 2 else ""
            if code:
                stocks.append({"code": code, "name": name})
        return stocks
    except Exception:
        return []


def _fetch_concept_index_kline(concept: str, days: int) -> pd.DataFrame:
    """Fetch concept index daily kline from Eastmoney."""
    end = datetime.now()
    start = end - timedelta(days=days + 30)
    start_str = start.strftime("%Y%m%d")
    end_str = end.strftime("%Y%m%d")

    df = ak.stock_board_concept_hist_em(
        symbol=concept, period="daily", start_date=start_str, end_date=end_str, adjust=""
    )
    if df is None or df.empty:
        return pd.DataFrame()

    result = pd.DataFrame({
        "date": pd.to_datetime(df.iloc[:, 0]).dt.strftime("%Y-%m-%d"),
        "change": pd.to_numeric(df.iloc[:, 10], errors="coerce"),
    })
    return result.dropna()


def _fetch_index_kline(index_code: str, days: int) -> pd.DataFrame:
    """Fetch broad market index daily kline (e.g., 000001 SH composite)."""
    end = datetime.now()
    start = end - timedelta(days=days + 30)
    start_str = start.strftime("%Y%m%d")
    end_str = end.strftime("%Y%m%d")

    try:
        df = ak.index_zh_a_hist(symbol=index_code, period="daily", start_date=start_str, end_date=end_str)
        if df is None or df.empty:
            return pd.DataFrame()
        # Column 8 = 涨跌幅 (pct change)
        return pd.DataFrame({
            "date": pd.to_datetime(df.iloc[:, 0]).dt.strftime("%Y-%m-%d"),
            "change": pd.to_numeric(df.iloc[:, 8], errors="coerce"),
        }).dropna()
    except Exception:
        return pd.DataFrame()


def _fetch_stock_kline(code: str, days: int) -> pd.DataFrame:
    """Fetch stock daily kline from akshare or local DB."""
    db_path = _get_db_path()
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            since = (datetime.now() - timedelta(days=days + 30)).strftime("%Y-%m-%d")
            cursor.execute(
                "SELECT date, change_pct FROM klines WHERE code = ? AND period = 'daily' AND date >= ? ORDER BY date",
                (code, since),
            )
            rows = cursor.fetchall()
            conn.close()
            if len(rows) >= days // 3:
                return pd.DataFrame({
                    "date": [r[0] for r in rows],
                    "change": [r[1] if r[1] is not None else 0.0 for r in rows],
                })
        except Exception:
            pass

    end = datetime.now()
    start = end - timedelta(days=days + 30)
    try:
        df = ak.stock_zh_a_hist(
            symbol=code, period="daily", start_date=start.strftime("%Y%m%d"),
            end_date=end.strftime("%Y%m%d"), adjust="qfq"
        )
        if df is None or df.empty:
            return pd.DataFrame()
        return pd.DataFrame({
            "date": pd.to_datetime(df.iloc[:, 0]).dt.strftime("%Y-%m-%d"),
            "change": pd.to_numeric(df.iloc[:, 10], errors="coerce"),
        }).dropna()
    except Exception:
        return pd.DataFrame()


def _calculate_correlation(df_a: pd.DataFrame, df_b: pd.DataFrame, col_a: str = "change", col_b: str = "change", min_points: int = 3) -> float:
    """Calculate Pearson correlation between two daily change series."""
    if df_a.empty or df_b.empty:
        return 0.0
    merged = pd.merge(df_a, df_b, on="date", how="inner", suffixes=("_a", "_b")).dropna()
    if len(merged) < min_points:
        return 0.0
    corr = np.corrcoef(merged[f"{col_a}_a"], merged[f"{col_b}_b"])[0, 1]
    if math.isnan(corr) or math.isinf(corr):
        return 0.0
    return float(corr)


def find_independence_windows(concept_df: pd.DataFrame, market_df: pd.DataFrame, window: int = 3) -> list:
    """
    Find short time windows where concept and market are negatively correlated.
    Returns list of (start_date, end_date, concept_market_corr).
    Does NOT merge overlapping windows - keeps them separate for short-term analysis.
    """
    merged = pd.merge(concept_df, market_df, on="date", how="inner", suffixes=("_c", "_m")).dropna()
    if len(merged) < window * 2:
        return []

    merged = merged.sort_values("date").reset_index(drop=True)

    windows = []
    for i in range(len(merged) - window + 1):
        window_data = merged.iloc[i:i + window]
        corr = np.corrcoef(window_data["change_c"], window_data["change_m"])[0, 1]
        if math.isnan(corr) or math.isinf(corr):
            continue
        # We want strong negative correlation: concept moves independently from market
        if corr < -0.5:
            windows.append({
                "start": window_data["date"].iloc[0],
                "end": window_data["date"].iloc[-1],
                "concept_market_corr": round(float(corr), 4),
                "trading_days": len(window_data),
            })

    return windows


def filter_concept_stocks_by_independence(concept: str, days: int = 120, window: int = 3, min_windows: int = 2) -> dict:
    db_path = _get_db_path()

    # 1. Get concept stocks
    stocks = _fetch_concept_stocks_from_db(concept, db_path)
    if not stocks:
        stocks = _fetch_concept_stocks_from_akshare(concept)
    if not stocks:
        return {
            "concept": concept,
            "lookback_days": days,
            "window_size": window,
            "min_windows": min_windows,
            "total_stocks": 0,
            "real_concept_stocks": 0,
            "independence_windows": [],
            "stocks": [],
            "error": "No stocks found for this concept",
            "fetch_time": _now_iso(),
        }

    # 2. Get concept index and market index klines
    concept_df = _fetch_concept_index_kline(concept, days)
    if concept_df.empty:
        return {
            "concept": concept,
            "lookback_days": days,
            "window_size": window,
            "min_windows": min_windows,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "independence_windows": [],
            "stocks": [],
            "error": f"Failed to fetch concept index kline for {concept}",
            "fetch_time": _now_iso(),
        }

    market_df = _fetch_index_kline("000001", days)
    if market_df.empty:
        return {
            "concept": concept,
            "lookback_days": days,
            "window_size": window,
            "min_windows": min_windows,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "independence_windows": [],
            "stocks": [],
            "error": "Failed to fetch market index (000001) kline",
            "fetch_time": _now_iso(),
        }

    # 3. Find independence windows
    windows = find_independence_windows(concept_df, market_df, window)
    if len(windows) < min_windows:
        return {
            "concept": concept,
            "lookback_days": days,
            "window_size": window,
            "min_windows": min_windows,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "independence_windows": windows,
            "stocks": [],
            "error": f"Found only {len(windows)} independence windows (need >= {min_windows}). Concept and market are too correlated.",
            "fetch_time": _now_iso(),
        }

    # 4. For each stock, calculate correlation with concept in each independence window
    results = []
    for stock in stocks:
        code = stock.get("code", "")
        name = stock.get("name", "")

        stock_df = _fetch_stock_kline(code, days)
        if stock_df.empty:
            results.append({
                "code": code,
                "name": name,
                "avg_concept_corr": 0.0,
                "window_count": 0,
                "window_corrs": [],
                "is_real": False,
            })
            continue

        window_corrs = []
        for w in windows:
            window_concept = concept_df[(concept_df["date"] >= w["start"]) & (concept_df["date"] <= w["end"])]
            window_stock = stock_df[(stock_df["date"] >= w["start"]) & (stock_df["date"] <= w["end"])]
            corr = _calculate_correlation(window_concept, window_stock)
            window_corrs.append({
                "start": w["start"],
                "end": w["end"],
                "corr": round(corr, 4),
            })

        valid_corrs = [wc["corr"] for wc in window_corrs if not math.isnan(wc["corr"])]
        avg_corr = sum(valid_corrs) / len(valid_corrs) if valid_corrs else 0.0
        # A stock is "real" if it has positive correlation with concept in independence windows
        is_real = avg_corr > 0.1 and len(valid_corrs) >= min_windows

        results.append({
            "code": code,
            "name": name,
            "avg_concept_corr": round(avg_corr, 4),
            "window_count": len(valid_corrs),
            "window_corrs": window_corrs,
            "is_real": is_real,
        })

    # Sort by avg_concept_corr desc
    results.sort(key=lambda x: -x["avg_concept_corr"])

    real_count = sum(1 for r in results if r["is_real"])

    return clean_nan({
        "concept": concept,
        "lookback_days": days,
        "window_size": window,
        "min_windows": min_windows,
        "total_stocks": len(results),
        "real_concept_stocks": real_count,
        "fake_concept_stocks": len(results) - real_count,
        "independence_windows": windows,
        "stocks": results,
        "fetch_time": _now_iso(),
    })


def main():
    parser = argparse.ArgumentParser(description="概念股独立性筛选 - 在市场-概念脱钩时段找出真概念股")
    parser.add_argument("--concept", required=True, help="概念名称，如 存储芯片、华为昇腾")
    parser.add_argument("--days", type=int, default=120, help="回溯天数，默认120")
    parser.add_argument("--window", type=int, default=3, help="独立窗口大小（交易日），默认3")
    parser.add_argument("--min-windows", type=int, default=2, help="最少独立窗口数，默认2")
    parser.add_argument("--output", help="输出文件路径")
    args = parser.parse_args()

    result = filter_concept_stocks_by_independence(args.concept, args.days, args.window, args.min_windows)
    output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Result saved to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
