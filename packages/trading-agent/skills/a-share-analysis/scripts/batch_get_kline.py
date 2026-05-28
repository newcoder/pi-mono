#!/usr/bin/env python3
"""Batch fetch K-line data for multiple stocks from JoinQuant."""
import argparse
import json
import sys
import io
import warnings
import pandas as pd

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

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
    Fetch K-line for multiple stocks in one call.
    stock_codes: list of dicts with {code, market}
    Returns: list of kline dicts with code, market, date, open, close, etc.

    Uses mootdx (TCP direct) for bfq data, akshare for qfq/hfq.
    No JoinQuant dependency.
    """
    needs_resample = period in ('week', 'month', 'quarter', 'year')
    all_klines = []

    # Primary: mootdx for bfq (TCP direct, fastest)
    if mootdx_kline is not None:
        for item in stock_codes:
            try:
                mk = mootdx_kline(
                    item["code"], item.get("market", 0),
                    period=period, adjust="bfq",
                    start=start_date, end=end_date,
                )
                if mk:
                    for k in mk:
                        all_klines.append({
                            "code": k["code"],
                            "market": k["market"],
                            "date": k["date"],
                            "open": k["open"],
                            "close": k["close"],
                            "low": k["low"],
                            "high": k["high"],
                            "volume": k["volume"],
                            "amount": k.get("turnover"),
                            "pre_close": k.get("pre_close"),
                            "change_amount": k.get("change_amount"),
                            "change_pct": k.get("change_pct"),
                            "amplitude": k.get("amplitude"),
                        })
            except Exception as mx_err:
                print(json.dumps({"_mootdx_error": str(mx_err), "code": item["code"]}, ensure_ascii=False), file=sys.stderr)

    # Fallback: akshare for qfq/hfq or if mootdx failed
    if len(all_klines) == 0 or adjust != "bfq":
        if ak is not None:
            ak_start = f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}" if len(start_date) == 8 else start_date
            ak_end = f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:8]}" if len(end_date) == 8 else end_date
            ak_adjust = AK_ADJUST_MAP.get(adjust, "")
            for item in stock_codes:
                code = item["code"]
                market = item.get("market", 0)
                try:
                    df = ak.stock_zh_a_hist(symbol=code, period="daily", start_date=ak_start, end_date=ak_end, adjust=ak_adjust)
                    if df is not None and not df.empty:
                        for _, row in df.iterrows():
                            dt = str(row.get("日期", ""))
                            open_p = float(row["开盘"]) if pd.notna(row.get("开盘")) else None
                            close_p = float(row["收盘"]) if pd.notna(row.get("收盘")) else None
                            low_p = float(row["最低"]) if pd.notna(row.get("最低")) else None
                            high_p = float(row["最高"]) if pd.notna(row.get("最高")) else None
                            volume = float(row["成交量"]) if pd.notna(row.get("成交量")) else None
                            money = float(row["成交额"]) if pd.notna(row.get("成交额")) else None
                            change_pct = float(row["涨跌幅"]) if pd.notna(row.get("涨跌幅")) else None
                            change_amount = float(row["涨跌额"]) if pd.notna(row.get("涨跌额")) else None
                            amplitude = float(row["振幅"]) if pd.notna(row.get("振幅")) else None
                            all_klines.append({
                                "code": code,
                                "market": market,
                                "date": dt,
                                "open": open_p,
                                "close": close_p,
                                "low": low_p,
                                "high": high_p,
                                "volume": volume,
                                "amount": money,
                                "amplitude": amplitude,
                                "change_pct": change_pct,
                                "change_amount": change_amount,
                                "turnover": None,
                                "pre_close": None,
                            })
                except Exception as ak_err:
                    print(json.dumps({"_akshare_error": str(ak_err), "code": code}, ensure_ascii=False), file=sys.stderr)

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
