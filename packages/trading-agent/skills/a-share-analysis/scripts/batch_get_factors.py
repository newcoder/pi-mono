#!/usr/bin/env python3
"""Batch fetch adjustment factors for multiple stocks from JoinQuant."""
import argparse
import json
import sys
import io
import warnings
import pandas as pd

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from jq_data import normalize_code
import jqdatasdk as jq
jq.auth('13758103948', 'DingPanBao2021')


def batch_get_factors(stock_codes, start_date, end_date):
    """
    Fetch adjustment factors for multiple stocks in one call.
    stock_codes: list of dicts with {code, market}
    Returns: list of factor dicts with code, market, date, qfq_factor, hfq_factor
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

    # Fetch pre-adjustment factors (qfq)
    df_pre = jq.get_price(jq_codes, start_date=start_date, end_date=end_date,
                          frequency='daily', fq='pre', fields=['factor'],
                          panel=True, skip_paused=False)
    # Fetch post-adjustment factors (hfq)
    df_post = jq.get_price(jq_codes, start_date=start_date, end_date=end_date,
                           frequency='daily', fq='post', fields=['factor'],
                           panel=True, skip_paused=False)

    factors = []

    # Process pre-adjustment factors
    if df_pre is not None and len(df_pre) > 0:
        if 'time' in df_pre.columns and 'code' in df_pre.columns:
            for _, row in df_pre.iterrows():
                jq_code = row.get('code')
                if pd.isna(jq_code):
                    continue
                code, market = code_map.get(jq_code, (str(jq_code).split('.')[0], 0))
                date_str = str(row['time']).split(' ')[0] if not pd.isna(row.get('time')) else None
                qfq = float(row['factor']) if pd.notna(row.get('factor')) else None
                if date_str and qfq is not None:
                    factors.append({
                        "code": code,
                        "market": market,
                        "date": date_str,
                        "qfq_factor": qfq,
                        "hfq_factor": None,
                    })

    # Process post-adjustment factors and merge
    if df_post is not None and len(df_post) > 0:
        if 'time' in df_post.columns and 'code' in df_post.columns:
            # Build lookup from existing factors
            lookup = {}
            for i, f in enumerate(factors):
                key = (f["code"], f["date"])
                lookup[key] = i

            for _, row in df_post.iterrows():
                jq_code = row.get('code')
                if pd.isna(jq_code):
                    continue
                code, market = code_map.get(jq_code, (str(jq_code).split('.')[0], 0))
                date_str = str(row['time']).split(' ')[0] if not pd.isna(row.get('time')) else None
                hfq = float(row['factor']) if pd.notna(row.get('factor')) else None
                if date_str and hfq is not None:
                    key = (code, date_str)
                    if key in lookup:
                        factors[lookup[key]]["hfq_factor"] = hfq
                    else:
                        factors.append({
                            "code": code,
                            "market": market,
                            "date": date_str,
                            "qfq_factor": None,
                            "hfq_factor": hfq,
                        })

    return factors


def main():
    parser = argparse.ArgumentParser(description="Batch fetch adjustment factors from JoinQuant")
    parser.add_argument("--codes", required=True, help="Comma-separated 6-digit stock codes")
    parser.add_argument("--markets", default="", help="Comma-separated markets (1=SH,0=SZ), same order as codes")
    parser.add_argument("--start", default="20240101", help="Start date YYYYMMDD")
    parser.add_argument("--end", default="20500101", help="End date YYYYMMDD")
    args = parser.parse_args()

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    markets = [int(m.strip()) for m in args.markets.split(",") if m.strip()] if args.markets else []

    stock_codes = []
    for i, code in enumerate(codes):
        market = markets[i] if i < len(markets) else (1 if code.startswith("6") else 0)
        stock_codes.append({"code": code, "market": market})

    factors = batch_get_factors(stock_codes, args.start, args.end)
    print(json.dumps({"factors": factors, "count": len(factors)}, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
