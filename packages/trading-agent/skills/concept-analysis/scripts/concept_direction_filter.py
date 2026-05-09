#!/usr/bin/env python3
"""
概念股方向一致率筛选 - 在概念与市场走势相反的日子里，统计股票与概念同向的比例
核心逻辑：
1. 找出概念指数与上证指数涨跌方向相反的日子（概念走出独立行情）
2. 在这些独立日里，统计每只股票与概念指数涨跌方向一致的比例
3. 比例越高，说明股票越跟随概念而非市场

用法: python concept_direction_filter.py --concept "存储芯片" [--days 120] [--min-days 5] [--output result.json]
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


def find_independence_days(concept_df: pd.DataFrame, market_df: pd.DataFrame) -> pd.DataFrame:
    """
    Find days where concept and market move in opposite directions.
    Returns DataFrame with columns: date, concept_dir, market_dir
    """
    merged = pd.merge(concept_df, market_df, on="date", how="inner", suffixes=("_c", "_m")).dropna()
    if merged.empty:
        return pd.DataFrame()

    merged = merged.sort_values("date").reset_index(drop=True)

    # Direction: +1 for up, -1 for down, 0 for flat
    merged["concept_dir"] = np.where(merged["change_c"] > 0, 1, np.where(merged["change_c"] < 0, -1, 0))
    merged["market_dir"] = np.where(merged["change_m"] > 0, 1, np.where(merged["change_m"] < 0, -1, 0))

    # Independence day: concept and market move in opposite directions
    merged["is_independent"] = merged["concept_dir"] * merged["market_dir"] < 0

    return merged[merged["is_independent"]][["date", "change_c", "change_m", "concept_dir", "market_dir"]]


def filter_concept_stocks_by_direction(concept: str, days: int = 120, min_days: int = 5) -> dict:
    db_path = _get_db_path()

    # 1. Get concept stocks
    stocks = _fetch_concept_stocks_from_db(concept, db_path)
    if not stocks:
        stocks = _fetch_concept_stocks_from_akshare(concept)
    if not stocks:
        return {
            "concept": concept,
            "lookback_days": days,
            "min_days": min_days,
            "total_stocks": 0,
            "real_concept_stocks": 0,
            "independence_days": 0,
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
            "min_days": min_days,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "independence_days": 0,
            "stocks": [],
            "error": f"Failed to fetch concept index kline for {concept}",
            "fetch_time": _now_iso(),
        }

    market_df = _fetch_index_kline("000001", days)
    if market_df.empty:
        return {
            "concept": concept,
            "lookback_days": days,
            "min_days": min_days,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "independence_days": 0,
            "stocks": [],
            "error": "Failed to fetch market index (000001) kline",
            "fetch_time": _now_iso(),
        }

    # 3. Find independence days
    indep_days = find_independence_days(concept_df, market_df)
    if len(indep_days) < min_days:
        return {
            "concept": concept,
            "lookback_days": days,
            "min_days": min_days,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "independence_days": len(indep_days),
            "stocks": [],
            "error": f"Found only {len(indep_days)} independence days (need >= {min_days}). Concept and market move together too often.",
            "fetch_time": _now_iso(),
        }

    # 4. For each stock, calculate direction agreement rate on independence days
    results = []
    for stock in stocks:
        code = stock.get("code", "")
        name = stock.get("name", "")

        stock_df = _fetch_stock_kline(code, days)
        if stock_df.empty:
            results.append({
                "code": code,
                "name": name,
                "agreement_rate": 0.0,
                "indep_days": 0,
                "same_dir_days": 0,
                "opposite_dir_days": 0,
                "flat_days": 0,
                "is_real": False,
            })
            continue

        # Merge stock data with independence days
        merged = pd.merge(indep_days, stock_df, on="date", how="inner").dropna()
        if merged.empty:
            results.append({
                "code": code,
                "name": name,
                "agreement_rate": 0.0,
                "indep_days": 0,
                "same_dir_days": 0,
                "opposite_dir_days": 0,
                "flat_days": 0,
                "is_real": False,
            })
            continue

        # Stock direction
        merged["stock_dir"] = np.where(merged["change"] > 0, 1, np.where(merged["change"] < 0, -1, 0))

        # Agreement: stock and concept move in same direction
        merged["agreement"] = merged["stock_dir"] * merged["concept_dir"]

        same_dir = int((merged["agreement"] > 0).sum())
        opposite_dir = int((merged["agreement"] < 0).sum())
        flat_days = int((merged["stock_dir"] == 0).sum())
        total_valid = same_dir + opposite_dir  # exclude flat days

        agreement_rate = same_dir / total_valid if total_valid > 0 else 0.0

        # A stock is "real" if agreement rate > 50% (better than random) and has enough valid days
        is_real = agreement_rate > 0.5 and total_valid >= min_days

        results.append({
            "code": code,
            "name": name,
            "agreement_rate": round(agreement_rate, 4),
            "indep_days": len(merged),
            "same_dir_days": same_dir,
            "opposite_dir_days": opposite_dir,
            "flat_days": flat_days,
            "is_real": is_real,
        })

    # Sort by agreement_rate desc
    results.sort(key=lambda x: -x["agreement_rate"])

    real_count = sum(1 for r in results if r["is_real"])

    return clean_nan({
        "concept": concept,
        "lookback_days": days,
        "min_days": min_days,
        "total_stocks": len(results),
        "real_concept_stocks": real_count,
        "fake_concept_stocks": len(results) - real_count,
        "independence_days": len(indep_days),
        "stocks": results,
        "fetch_time": _now_iso(),
    })


def main():
    parser = argparse.ArgumentParser(description="概念股方向一致率筛选 - 在独立行情日找出真概念股")
    parser.add_argument("--concept", required=True, help="概念名称，如 存储芯片、华为昇腾")
    parser.add_argument("--days", type=int, default=120, help="回溯天数，默认120")
    parser.add_argument("--min-days", type=int, default=5, help="最少独立日数，默认5")
    parser.add_argument("--output", help="输出文件路径")
    args = parser.parse_args()

    result = filter_concept_stocks_by_direction(args.concept, args.days, args.min_days)
    output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Result saved to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
