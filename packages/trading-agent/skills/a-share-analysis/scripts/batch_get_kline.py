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

from jq_data import normalize_code, fetch

# Map our adjust codes to jq fq param
FQT_MAP = {
    "bfq": None,
    "qfq": "pre",
    "hfq": "post",
}

# Map our period codes to jq frequency
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
    """
    # Build jq security codes
    jq_codes = []
    code_map = {}  # jq_code -> (code, market)
    for item in stock_codes:
        code = item["code"]
        market = item.get("market", 0)
        jq_code = normalize_code(code)
        jq_codes.append(jq_code)
        code_map[jq_code] = (code, market)

    frequency = FREQ_MAP.get(period, "daily")
    fq = FQT_MAP.get(adjust)
    needs_resample = period in ('week', 'month', 'quarter', 'year')

    df = fetch(jq_codes, start_date=start_date, end_date=end_date,
               frequency=frequency, fq=fq)

    if df is None or len(df) == 0:
        return []

    df = _normalize_df(df)

    if needs_resample:
        df = _resample_df(df, period)

    klines = []
    for _, row in df.iterrows():
        jq_code = row.get('code')
        if pd.isna(jq_code):
            continue
        code, market = code_map.get(jq_code, (str(jq_code).split('.')[0], 0))

        time_val = row.get('time') if 'time' in row else row.get('date')
        date_str = str(time_val) if not pd.isna(time_val) else None
        if date_str and ' ' in date_str:
            date_str = date_str.split(' ')[0]

        open_p = float(row['open']) if pd.notna(row.get('open')) else None
        close_p = float(row['close']) if pd.notna(row.get('close')) else None
        low_p = float(row['low']) if pd.notna(row.get('low')) else None
        high_p = float(row['high']) if pd.notna(row.get('high')) else None
        volume = float(row['volume']) if pd.notna(row.get('volume')) else None
        money = float(row['money']) if pd.notna(row.get('money')) else None
        pre_close = float(row['pre_close']) if pd.notna(row.get('pre_close')) else None

        # Calculate derived fields
        change_amount = None
        change_pct = None
        amplitude = None
        if close_p is not None and pre_close is not None and pre_close != 0:
            change_amount = round(close_p - pre_close, 4)
            change_pct = round((close_p - pre_close) / pre_close * 100, 4)
            if high_p is not None and low_p is not None:
                amplitude = round((high_p - low_p) / pre_close * 100, 4)

        klines.append({
            "code": code,
            "market": market,
            "date": date_str,
            "open": open_p,
            "close": close_p,
            "low": low_p,
            "high": high_p,
            "volume": volume,
            "amount": money,
            "pre_close": pre_close,
            "change_amount": change_amount,
            "change_pct": change_pct,
            "amplitude": amplitude,
        })

    return klines


def main():
    parser = argparse.ArgumentParser(description="Batch fetch A-share K-line from JoinQuant")
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
