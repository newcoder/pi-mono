#!/usr/bin/env python3
"""Get all A-share stock list from JoinQuant."""
import json
import sys
import io
import warnings

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from jq_data import get_all_stocks

def main():
    df = get_all_stocks()
    stocks = []
    for code, row in df.iterrows():
        code_str = str(code).split('.')[0]
        market = 1 if str(code).endswith('XSHG') else 0
        stocks.append({
            "code": code_str,
            "market": market,
            "name": row.get('display_name', '')
        })
    print(json.dumps(stocks, ensure_ascii=False))
    sys.stdout.flush()

if __name__ == "__main__":
    main()
