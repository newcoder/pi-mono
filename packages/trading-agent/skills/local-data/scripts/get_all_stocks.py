#!/usr/bin/env python3
"""Get all A-share stock list.

Priority:
  1. mootdx stock_all (TCP direct, ~2 s, includes names)
  2. akshare stock_zh_a_spot_em fallback (slow but complete)

No JoinQuant dependency.
"""
import json
import sys
import io
import warnings

from local_data.market import market_from_code

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def _is_a_share(code: str) -> bool:
    """Strict A-share 6-digit code filter. Excludes funds, bonds, B-shares, indices."""
    if not code or len(code) != 6 or not code.isdigit():
        return False
    # Shanghai main board + STAR market
    if code.startswith(("600", "601", "602", "603", "605", "688", "689")):
        return True
    # Shenzhen main board + SME + ChiNext
    if code.startswith(("000", "001", "002", "003", "300", "301")):
        return True
    # Beijing Stock Exchange (6-digit); exclude Tonghuashun/TX sector indices (88xxxx)
    if code.startswith(("430", "830", "87", "89", "92")):
        return True
    return False


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
        if not _is_a_share(code):
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


def get_all_stocks_from_akshare():
    """Fetch all A-share stocks from akshare (Eastmoney spot data)."""
    import akshare as ak

    df = ak.stock_zh_a_spot_em()
    stocks = []
    for _, row in df.iterrows():
        code = str(row.get("代码", "")).strip()
        name = str(row.get("名称", "")).strip()
        if not _is_a_share(code):
            continue
        stocks.append({
            "code": code,
            "market": _get_market_from_code(code),
            "name": name,
        })
    return stocks


def main():
    # Primary: mootdx (fast)
    try:
        stocks = get_all_stocks_from_mootdx()
        if stocks and len(stocks) > 3000:
            print(json.dumps(stocks, ensure_ascii=False))
            sys.stdout.flush()
            return
    except Exception as e:
        print(json.dumps({"_mootdx_error": str(e)}, ensure_ascii=False), file=sys.stderr)

    # Fallback: akshare
    try:
        stocks = get_all_stocks_from_akshare()
        if stocks and len(stocks) > 3000:
            print(json.dumps(stocks, ensure_ascii=False))
            sys.stdout.flush()
            return
    except Exception as e:
        print(json.dumps({"error": f"akshare failed: {e}"}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps({"error": "All data sources failed"}, ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
