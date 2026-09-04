#!/usr/bin/env python3
"""Get all A-share stock list from mootdx (TDX TCP)."""
import io
import json
import sys
import warnings

from local_data.market import is_a_share, market_from_code

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def _clean_name(name: str) -> str:
    """Strip null bytes and whitespace from mootdx names."""
    if not name:
        return "(unknown)"
    return name.replace("\x00", "").replace("\x01", "").strip() or "(unknown)"


def _get_market_from_code(code: str) -> int:
    """1=SH, 0=SZ, 2=BJ."""
    return market_from_code(code) or 0


def get_all_stocks_from_mootdx():
    """Fetch A-share stocks from mootdx stock_all (TCP direct)."""
    from mootdx.quotes import Quotes

    client = Quotes.factory(market="std")
    df = client.stock_all()
    stocks = []
    for _, row in df.iterrows():
        code = str(row.get("code", "")).strip()
        if not is_a_share(code):
            continue
        raw_name = str(row.get("name", "") or "").strip()
        name = _clean_name(raw_name)
        # Skip delisted / 退市 names when possible
        if "退市" in name or name.endswith("退"):
            continue
        stocks.append({
            "code": code,
            "market": _get_market_from_code(code),
            "name": name,
        })
    return stocks


def main():
    try:
        stocks = get_all_stocks_from_mootdx()
        if stocks and len(stocks) > 3000:
            print(json.dumps(stocks, ensure_ascii=False))
            sys.stdout.flush()
            return
        print(json.dumps({"error": "mootdx returned too few stocks"}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"_mootdx_error": str(e)}, ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
