import argparse
import json
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import pandas as pd

from jq_data import normalize_code, get_kline_data, get_kline_factors


KLT_MAP = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "60m": "60m",
    "120m": "120m",
    "daily": "daily",
    "week": "week",
    "month": "month",
    "quarter": "quarter",
    "year": "year",
}

FQT_MAP = {
    "bfq": None,
    "qfq": "pre",
    "hfq": "post",
}


def _format_date(date_val):
    """Format pandas Timestamp or datetime to string."""
    if isinstance(date_val, pd.Timestamp):
        if date_val.hour or date_val.minute:
            return date_val.strftime('%Y-%m-%d %H:%M:%S')
        return date_val.strftime('%Y-%m-%d')
    return str(date_val)


def _df_to_klines(df):
    """Convert DataFrame from jq_data to the expected kline dict format."""
    klines = []
    for _, row in df.iterrows():
        date_str = _format_date(row['date'])
        open_p = float(row['open']) if pd.notna(row['open']) else None
        close_p = float(row['close']) if pd.notna(row['close']) else None
        low_p = float(row['low']) if pd.notna(row['low']) else None
        high_p = float(row['high']) if pd.notna(row['high']) else None
        volume = float(row['volume']) if pd.notna(row['volume']) else None
        money = float(row['money']) if pd.notna(row['money']) else None
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
            "date": date_str,
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
            "pre_close": pre_close,
        })
    return klines


def _df_to_factors(df):
    """Convert factor DataFrame to dict format."""
    factors = []
    for _, row in df.iterrows():
        date_str = _format_date(row['date'])
        qfq = float(row['qfq_factor']) if pd.notna(row.get('qfq_factor')) else None
        hfq = float(row['hfq_factor']) if pd.notna(row.get('hfq_factor')) else None
        if qfq is not None or hfq is not None:
            factors.append({
                "date": date_str,
                "qfq_factor": qfq,
                "hfq_factor": hfq,
            })
    return factors


def get_stock_kline(
    stock_code: str,
    market: int = 1,
    period: str = "daily",
    adjust: str = "bfq",
    start_date: str = "19700101",
    end_date: str = "20500101",
) -> dict:
    """
    Fetch K-line (OHLCV) data from JoinQuant (jqdatasdk) via jq_data wrapper.

    - period: 1m,5m,15m,30m,60m,120m,daily,week,month,quarter,year
    - adjust: bfq (不复权), qfq (前复权), hfq (后复权)
    - start_date / end_date: YYYYMMDD
    """
    # normalize_code infers the exchange suffix from the code prefix,
    # so the explicit market arg is kept only for CLI compatibility.
    jq_code = normalize_code(stock_code)
    frequency = KLT_MAP.get(period, "daily")
    fq = FQT_MAP.get(adjust)

    try:
        df = get_kline_data(
            jq_code,
            start_date=start_date,
            end_date=end_date,
            frequency=frequency,
            fq=fq,
        )
    except Exception as e:
        return {
            "code": stock_code,
            "market": "SH" if market == 1 else "SZ",
            "period": period,
            "adjust": adjust,
            "start_date": start_date,
            "end_date": end_date,
            "count": 0,
            "klines": [],
            "factors": [],
            "error": str(e),
        }

    klines = _df_to_klines(df)

    # Fetch adjustment factors when storing unadjusted (bfq) data
    factors = []
    if adjust == "bfq":
        try:
            df_factors = get_kline_factors(jq_code, start_date=start_date, end_date=end_date)
            factors = _df_to_factors(df_factors)
        except Exception:
            pass  # Factors are optional; don't fail the whole sync

    return {
        "code": stock_code,
        "market": "SH" if market == 1 else "SZ",
        "period": period,
        "adjust": adjust,
        "start_date": start_date,
        "end_date": end_date,
        "count": len(klines),
        "klines": klines,
        "factors": factors,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch A-share K-line data from JoinQuant")
    parser.add_argument("stock_code", help="6-digit stock code, e.g. 600845")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1], help="1=Shanghai (default), 0=Shenzhen")
    parser.add_argument("--period", default="daily", choices=list(KLT_MAP.keys()), help="K-line period")
    parser.add_argument("--adjust", default="bfq", choices=list(FQT_MAP.keys()), help="Adjustment type")
    parser.add_argument("--start", default="19700101", help="Start date YYYYMMDD")
    parser.add_argument("--end", default="20500101", help="End date YYYYMMDD")
    args = parser.parse_args()

    result = get_stock_kline(
        args.stock_code,
        market=args.market,
        period=args.period,
        adjust=args.adjust,
        start_date=args.start,
        end_date=args.end,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
