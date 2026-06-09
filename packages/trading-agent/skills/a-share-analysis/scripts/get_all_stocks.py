#!/usr/bin/env python3
"""Get all A-share stock list via akshare (no JoinQuant dependency)."""
import json
import sys
import io
import warnings
import os

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def _get_market_from_code(code: str) -> int:
    """1=SH, 0=SZ, 2=BJ"""
    if code.startswith(("8", "4", "92")):
        return 2
    return 1 if code.startswith(("60", "68", "90")) else 0


def get_all_stocks_from_akshare():
    """Fetch all A-share stocks from akshare (Eastmoney spot data)."""
    import akshare as ak
    df = ak.stock_zh_a_spot_em()
    stocks = []
    for _, row in df.iterrows():
        code = str(row.get("代码", "")).strip()
        name = str(row.get("名称", "")).strip()
        if not code or not code.isdigit() or len(code) != 6:
            continue
        market = _get_market_from_code(code)
        stocks.append({
            "code": code,
            "market": market,
            "name": name,
        })
    return stocks


def main():
    # Use akshare only (no JoinQuant dependency)
    try:
        stocks = get_all_stocks_from_akshare()
        if stocks and len(stocks) > 3000:
            print(json.dumps(stocks, ensure_ascii=False))
            sys.stdout.flush()
            return
    except Exception as e:
        print(json.dumps({"error": f"akshare failed: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
