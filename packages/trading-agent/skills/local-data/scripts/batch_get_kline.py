#!/usr/bin/env python3
"""Batch fetch K-line data for multiple stocks from JoinQuant."""
import argparse
import json
import os
import sys
import io
import warnings

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import pandas as pd

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# Avoid unstable local HTTP proxies breaking akshare/requests fallbacks.
for _proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(_proxy_key, None)
os.environ.setdefault("NO_PROXY", "*")

# mootdx primary (TCP direct, no auth)
try:
    from mootdx_data import get_kline as mootdx_kline
except ImportError:
    mootdx_kline = None

# akshare fallback
try:
    import akshare as ak
except ImportError:
    ak = None

# Map our adjust codes to akshare param
AK_ADJUST_MAP = {
    "bfq": "",
    "qfq": "qfq",
    "hfq": "hfq",
}

# Map our adjust codes for argparse choices
FQT_MAP = {
    "bfq": "bfq",
    "qfq": "qfq",
    "hfq": "hfq",
}

# Map our period codes to mootdx/akshare frequency
FREQ_MAP = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "60m": "60m",
    "120m": "120m",
    "daily": "daily",
    "week": "daily",     # fetch daily then resample
    "month": "daily",    # fetch daily then resample
    "quarter": "daily",  # fetch daily then resample
    "year": "daily",     # fetch daily then resample
}


def _resample_df(df, period, code_col='code'):
    """Resample daily data to week/month/quarter/year per stock."""
    if df is None or len(df) == 0:
        return df

    agg_map = {
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last',
        'volume': 'sum',
        'money': 'sum',
        'pre_close': 'first',
    }
    freq = {
        'week': 'W-FRI',
        'month': 'ME',
        'quarter': 'QE',
        'year': 'YE',
    }.get(period)
    if freq is None:
        return df

    resampled = []
    for jq_code, group in df.groupby(code_col):
        g = group.copy()
        g['date'] = pd.to_datetime(g['date'])
        g = g.set_index('date').sort_index()
        # Only keep columns that exist
        cols = {k: v for k, v in agg_map.items() if k in g.columns}
        rg = g.resample(freq).agg(cols)
        rg[code_col] = jq_code
        rg = rg.reset_index()
        resampled.append(rg)

    return pd.concat(resampled, ignore_index=True)


def _normalize_df(df):
    """Ensure DataFrame is in long format with 'code' and 'date' columns."""
    if df is None or len(df) == 0:
        return df
    # If columns are MultiIndex (panel format), unstack
    if isinstance(df.columns, pd.MultiIndex):
        df = df.stack(level=1).reset_index()
        if 'level_1' in df.columns:
            df.rename(columns={'level_1': 'code'}, inplace=True)
        if 'level_0' in df.columns:
            df.rename(columns={'level_0': 'date'}, inplace=True)
    # Ensure code column exists
    if 'code' not in df.columns:
        df = df.reset_index()
        for col in list(df.columns):
            if col in ('level_1', 'minor') and 'code' not in df.columns:
                df.rename(columns={col: 'code'}, inplace=True)
    # Ensure date column exists
    if 'date' not in df.columns and 'time' in df.columns:
        df.rename(columns={'time': 'date'}, inplace=True)
    # Fallback: if date still missing, try first datetime-like column
    if 'date' not in df.columns:
        for col in df.columns:
            if col in ('date', 'time', 'datetime', 'level_0'):
                df.rename(columns={col: 'date'}, inplace=True)
                break
    return df


def batch_get_kline(stock_codes, start_date, end_date, period="daily", adjust="bfq"):
    """
    Fetch K-line for multiple stocks.
    stock_codes: list of dicts with {code, market}
    Returns: list of kline dicts with code, market, date, open, close, etc.

    Per stock: try mootdx (TCP direct) first, then fall back to akshare.
    No JoinQuant dependency.
    """
    all_klines = []

    ak_start = f"{start_date[:4]}{start_date[5:7]}{start_date[8:10]}" if len(start_date) == 10 else start_date
    ak_end = f"{end_date[:4]}{end_date[5:7]}{end_date[8:10]}" if len(end_date) == 10 else end_date
    ak_adjust = AK_ADJUST_MAP.get(adjust, "")

    def _symbol_prefix(code: str) -> str:
        if code.startswith(("60", "68", "90")):
            return f"sh{code}"
        if code.startswith(("8", "4", "92")):
            return f"bj{code}"
        return f"sz{code}"

    def _from_mootdx(item):
        if mootdx_kline is None:
            return []
        try:
            return mootdx_kline(
                item["code"], item.get("market", 0),
                period=period, adjust="bfq",
                start=start_date, end=end_date,
            ) or []
        except Exception as mx_err:
            print(json.dumps({"_mootdx_error": str(mx_err), "code": item["code"]}, ensure_ascii=False), file=sys.stderr)
            return []

    def _from_akshare(item):
        if ak is None:
            return []
        code = item["code"]
        market = item.get("market", 0)
        try:
            df = ak.stock_zh_a_daily(
                symbol=_symbol_prefix(code),
                start_date=ak_start,
                end_date=ak_end,
                adjust=ak_adjust,
            )
            if df is None or df.empty:
                return []
            rows = []
            for _, row in df.iterrows():
                rows.append({
                    "code": code,
                    "market": market,
                    "date": str(row.get("date", "")),
                    "open": float(row["open"]) if pd.notna(row.get("open")) else None,
                    "close": float(row["close"]) if pd.notna(row.get("close")) else None,
                    "low": float(row["low"]) if pd.notna(row.get("low")) else None,
                    "high": float(row["high"]) if pd.notna(row.get("high")) else None,
                    "volume": float(row["volume"]) if pd.notna(row.get("volume")) else None,
                    "amount": float(row["amount"]) if pd.notna(row.get("amount")) else None,
                    "amplitude": None,
                    "change_pct": float(row["pct_change"]) if pd.notna(row.get("pct_change")) else None,
                    "change_amount": None,
                    "turnover": None,
                    "pre_close": None,
                })
            return rows
        except Exception as ak_err:
            print(json.dumps({"_akshare_error": str(ak_err), "code": code}, ensure_ascii=False), file=sys.stderr)
            return []

    def _is_bj(code: str) -> bool:
        return code.startswith(("8", "4", "92"))

    def _fetch_one(item):
        code = item["code"]
        # Use mootdx for SH/SZ; akshare does not reliably cover delisted/suspended stocks.
        # For Beijing stocks, mootdx std market does not support them, so use akshare directly.
        if _is_bj(code):
            return _from_akshare(item)
        return _from_mootdx(item)

    for item in stock_codes:
        all_klines.extend(_fetch_one(item))

    return all_klines


def main():
    parser = argparse.ArgumentParser(description="Batch fetch A-share K-line (mootdx/akshare, no JoinQuant)")
    parser.add_argument("--codes", required=True, help="Comma-separated 6-digit stock codes")
    parser.add_argument("--markets", default="", help="Comma-separated markets (1=SH,0=SZ), same order as codes")
    parser.add_argument("--start", default="20240101", help="Start date YYYYMMDD")
    parser.add_argument("--end", default="20500101", help="End date YYYYMMDD")
    parser.add_argument("--period", default="daily", choices=list(FREQ_MAP.keys()))
    parser.add_argument("--adjust", default="bfq", choices=list(FQT_MAP.keys()))
    args = parser.parse_args()

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    markets = [int(m.strip()) for m in args.markets.split(",") if m.strip()] if args.markets else []

    stock_codes = []
    for i, code in enumerate(codes):
        market = markets[i] if i < len(markets) else (1 if code.startswith("6") else 0)
        stock_codes.append({"code": code, "market": market})

    klines = batch_get_kline(stock_codes, args.start, args.end, args.period, args.adjust)
    print(json.dumps({"klines": klines, "count": len(klines)}, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
