#!/usr/bin/env python3
"""
概念股相关性筛选 - 基于股价与概念指数的相关性（去除大盘beta影响）
用法: python concept_correlation_filter.py --concept "华为昇腾" [--days 60] [--min-excess-correlation 0.05] [--output result.json]
输出: JSON {concept, lookback_days, min_excess_correlation, total_stocks, real_concept_stocks, stocks: [{code, name, concept_corr, market_corr, excess_corr, is_real}]}

核心逻辑：
1. 获取概念指数的日线涨跌幅
2. 获取上证指数（000001）的日线涨跌幅作为市场基准
3. 对每只股票，计算与概念指数的相关性（concept_corr）和与上证指数的相关性（market_corr）
4. 超额相关性 = concept_corr - market_corr
5. 如果超额相关性 < min_excess_correlation，说明股票更跟随大盘而非概念，过滤掉
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


def _load_concept_klines_from_db(concept: str, db_path: str, days: int) -> pd.DataFrame:
    """Load concept index klines from local SQLite cache."""
    if not os.path.exists(db_path):
        return pd.DataFrame()
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        since = (datetime.now() - timedelta(days=days + 30)).strftime("%Y-%m-%d")
        cursor.execute(
            "SELECT date, change_pct FROM klines WHERE code = ? AND market = 99 AND period = 'daily' AND date >= ? ORDER BY date",
            (concept, since),
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
    return pd.DataFrame()


def _save_concept_klines_to_db(concept: str, df: pd.DataFrame, db_path: str) -> None:
    """Save concept index klines to local SQLite cache."""
    if df.empty or not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        for _, row in df.iterrows():
            cursor.execute(
                """
                INSERT OR REPLACE INTO klines
                (code, market, period, adjust, date, open, high, low, close, volume, turnover, change_pct, change_amount, amplitude, pre_close)
                VALUES (?, 99, 'daily', '', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)
                """,
                (concept, row["date"], row["change"]),
            )
        conn.commit()
        conn.close()
    except Exception:
        pass


def _fetch_concept_index_kline(concept: str, days: int) -> pd.DataFrame:
    """Fetch concept index daily kline from Eastmoney (with DB cache)."""
    db_path = _get_db_path()

    # Try cache first
    cached = _load_concept_klines_from_db(concept, db_path, days)
    if not cached.empty:
        return cached

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
    result = result.dropna()

    # Save to DB cache
    if not result.empty:
        _save_concept_klines_to_db(concept, result, db_path)

    return result


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
        # Column 8 = 涨跌幅 (pct change), column 9 = 涨跌额 (point change)
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


def _calculate_correlation(df_a: pd.DataFrame, df_b: pd.DataFrame, col_a: str = "change", col_b: str = "change") -> float:
    """Calculate Pearson correlation between two daily change series."""
    if df_a.empty or df_b.empty:
        return 0.0
    merged = pd.merge(df_a, df_b, on="date", how="inner", suffixes=("_a", "_b")).dropna()
    if len(merged) < 10:
        return 0.0
    corr = np.corrcoef(merged[f"{col_a}_a"], merged[f"{col_b}_b"])[0, 1]
    if math.isnan(corr) or math.isinf(corr):
        return 0.0
    return float(corr)


def _fetch_market_cap(code: str) -> float:
    """Fetch latest market cap (total, not free-float) for a stock."""
    try:
        info_df = ak.stock_individual_info_em(symbol=code)
        total_shares = None
        for _, row in info_df.iterrows():
            if '总股本' in str(row.iloc[0]):
                s = str(row.iloc[1])
                s = s.replace('亿股', '').replace('万手', '').replace(',', '')
                total_shares = float(s)
                if '亿' in str(row.iloc[1]):
                    total_shares *= 100000000
                elif '万' in str(row.iloc[1]):
                    total_shares *= 10000
                break

        df = ak.stock_zh_a_hist(symbol=code, period="daily", start_date="20260505", end_date="20260506", adjust="")
        close = float(df.iloc[-1].iloc[2]) if df is not None and not df.empty else 0
        return close * total_shares if total_shares else 0
    except Exception:
        return 0.0


# ─── Main Logic ───────────────────────────────────────────────


def filter_concept_stocks_by_correlation(concept: str, days: int = 60, min_excess_correlation: float = 0.05) -> dict:
    db_path = _get_db_path()

    # 1. Get concept stocks (DB first, then akshare fallback)
    stocks = _fetch_concept_stocks_from_db(concept, db_path)
    if not stocks:
        stocks = _fetch_concept_stocks_from_akshare(concept)
    if not stocks:
        return {
            "concept": concept,
            "lookback_days": days,
            "min_excess_correlation": min_excess_correlation,
            "total_stocks": 0,
            "real_concept_stocks": 0,
            "stocks": [],
            "error": "No stocks found for this concept",
            "fetch_time": _now_iso(),
        }

    # 2. Get concept index kline and market index kline
    concept_df = _fetch_concept_index_kline(concept, days)
    if concept_df.empty:
        return {
            "concept": concept,
            "lookback_days": days,
            "min_excess_correlation": min_excess_correlation,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "stocks": [],
            "error": f"Failed to fetch concept index kline for {concept}",
            "fetch_time": _now_iso(),
        }

    market_df = _fetch_index_kline("000001", days)
    if market_df.empty:
        return {
            "concept": concept,
            "lookback_days": days,
            "min_excess_correlation": min_excess_correlation,
            "total_stocks": len(stocks),
            "real_concept_stocks": 0,
            "stocks": [],
            "error": "Failed to fetch market index (000001) kline",
            "fetch_time": _now_iso(),
        }

    # 3. Calculate correlation for each stock
    results = []
    for stock in stocks:
        code = stock.get("code", "")
        name = stock.get("name", "")

        stock_df = _fetch_stock_kline(code, days)
        if stock_df.empty:
            results.append({
                "code": code,
                "name": name,
                "concept_corr": 0.0,
                "market_corr": 0.0,
                "excess_corr": 0.0,
                "is_real": False,
                "trading_days": 0,
            })
            continue

        concept_corr = _calculate_correlation(concept_df, stock_df)
        market_corr = _calculate_correlation(market_df, stock_df)
        excess_corr = concept_corr - market_corr
        is_real = excess_corr >= min_excess_correlation

        results.append({
            "code": code,
            "name": name,
            "concept_corr": round(concept_corr, 4),
            "market_corr": round(market_corr, 4),
            "excess_corr": round(excess_corr, 4),
            "is_real": is_real,
            "trading_days": len(stock_df),
        })

    # Sort by excess_corr desc
    results.sort(key=lambda x: -x["excess_corr"])

    real_count = sum(1 for r in results if r["is_real"])

    return clean_nan({
        "concept": concept,
        "lookback_days": days,
        "min_excess_correlation": min_excess_correlation,
        "total_stocks": len(results),
        "real_concept_stocks": real_count,
        "fake_concept_stocks": len(results) - real_count,
        "stocks": results,
        "fetch_time": _now_iso(),
    })


def find_concept_leaders(concept: str, days: int = 120, top_n: int = 10) -> dict:
    """
    找出概念的龙头股。
    综合得分 = 与概念指数的相关性 × ln(市值亿 + 1)
    既考察股票与概念的关联度，又考虑股票的市场分量，避免选出纯炒作的小票。
    """
    db_path = _get_db_path()

    # 1. Get concept stocks
    stocks = _fetch_concept_stocks_from_db(concept, db_path)
    if not stocks:
        stocks = _fetch_concept_stocks_from_akshare(concept)
    if not stocks:
        return {
            "concept": concept,
            "lookback_days": days,
            "top_n": top_n,
            "total_stocks": 0,
            "leaders": [],
            "error": "No stocks found for this concept",
            "fetch_time": _now_iso(),
        }

    # 2. Get concept index kline
    concept_df = _fetch_concept_index_kline(concept, days)
    if concept_df.empty:
        return {
            "concept": concept,
            "lookback_days": days,
            "top_n": top_n,
            "total_stocks": len(stocks),
            "leaders": [],
            "error": f"Failed to fetch concept index kline for {concept}",
            "fetch_time": _now_iso(),
        }

    # 3. For each stock, compute correlation and market cap
    results = []
    for stock in stocks:
        code = stock.get("code", "")
        name = stock.get("name", "")

        stock_df = _fetch_stock_kline(code, days)
        if stock_df.empty:
            continue

        concept_corr = _calculate_correlation(concept_df, stock_df)
        if math.isnan(concept_corr):
            continue

        market_cap = _fetch_market_cap(code)
        cap_yi = market_cap / 1e8 if market_cap else 0

        # Composite score: correlation weighted by log(market cap)
        score = concept_corr * np.log(cap_yi + 1) if cap_yi > 0 else 0.0

        results.append({
            "code": code,
            "name": name,
            "concept_corr": round(concept_corr, 4),
            "market_cap": round(market_cap, 2) if market_cap else 0,
            "market_cap_yi": round(cap_yi, 2),
            "score": round(score, 4),
        })

    # Sort by composite score desc
    results.sort(key=lambda x: -x["score"])

    # Pick top N
    leaders = results[:top_n]

    return clean_nan({
        "concept": concept,
        "lookback_days": days,
        "top_n": top_n,
        "total_stocks": len(results),
        "leaders": leaders,
        "fetch_time": _now_iso(),
    })


def main():
    parser = argparse.ArgumentParser(description="概念股相关性筛选与龙头识别")
    parser.add_argument("--concept", required=True, help="概念名称，如 华为昇腾、人工智能")
    parser.add_argument("--days", type=int, default=60, help="回溯天数，默认60")
    parser.add_argument("--min-excess-correlation", type=float, default=0.05, help="最低超额相关系数(概念相关-上证相关)，默认0.05")
    parser.add_argument("--find-leaders", action="store_true", help="启用龙头识别模式(综合得分=相关性×ln(市值亿+1))")
    parser.add_argument("--top-n", type=int, default=10, help="龙头识别时返回前N只，默认10")
    parser.add_argument("--output", help="输出文件路径")
    args = parser.parse_args()

    if args.find_leaders:
        result = find_concept_leaders(args.concept, args.days, args.top_n)
    else:
        result = filter_concept_stocks_by_correlation(args.concept, args.days, args.min_excess_correlation)

    output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Result saved to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
