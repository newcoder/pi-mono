import argparse
import json
import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}


def get_stock_real_quote_eastmoney(stock_code: str, market: int = 1) -> dict:
    """Fetch real-time stock quote from Eastmoney."""
    secid = f"{market}.{stock_code}"
    api_url = (
        "https://push2.eastmoney.com/api/qt/stock/get"
        "?ut=bd1d9ddb04089700cf9c27f6f7426281"
        "&fltt=2&invt=2&volt=2"
        "&fields=f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f57,f58,f60,f61,f116,f117,f162,f163,f164,f170,f171,f173,f177,f183,f184,f185,f186,f187,f188,f189,f190"
        f"&secid={secid}&_="
    )
    r = requests.get(api_url, headers=HEADERS, timeout=20)
    r.encoding = "utf-8"
    data = r.json()
    d = data.get("data", {})

    return {
        "name": d.get("f58"),
        "code": d.get("f57") or stock_code,
        "latest": d.get("f43"),
        "open": d.get("f46"),
        "high": d.get("f44"),
        "low": d.get("f45"),
        "prev_close": d.get("f60"),
        "volume": d.get("f47"),
        "turnover": d.get("f48"),
        "change_pct": d.get("f170"),
        "total_cap": d.get("f116"),
        "float_cap": d.get("f117"),
        "pe": d.get("f162"),
        "52w_high": d.get("f51"),
        "52w_low": d.get("f52"),
        "_source": "eastmoney",
        "raw": d,
    }


def get_stock_real_quote_sina(stock_code: str, _market: int = 1) -> dict:
    """Fetch real-time stock quote from Sina via akshare as fallback."""
    import akshare as ak

    df = ak.stock_zh_a_spot()
    if df is None or df.empty:
        raise RuntimeError("Sina spot data empty")

    # Find code column
    code_col = None
    for col in df.columns:
        if str(col) in ("代码", "code"):
            code_col = col
            break
    if code_col is None:
        code_col = df.columns[0]

    # Sina codes have sh/sz prefix (e.g. sh600519)
    prefix = "sh" if _market == 1 else "sz"
    sina_code = prefix + stock_code
    row = df[df[code_col].astype(str).str.strip() == sina_code]
    if row.empty:
        raise RuntimeError(f"Stock {stock_code} ({sina_code}) not found in Sina data")

    r = row.iloc[0]

    # Column mapping (Sina Chinese column names)
    def get_col(candidates):
        for c in df.columns:
            if str(c) in candidates:
                return c
        return None

    name_col = get_col(["名称", "name"])
    latest_col = get_col(["最新价", "price", "latest"])
    open_col = get_col(["今开", "open"])
    high_col = get_col(["最高", "high"])
    low_col = get_col(["最低", "low"])
    prev_close_col = get_col(["昨收", "prev_close", "previous_close"])
    volume_col = get_col(["成交量", "volume"])
    turnover_col = get_col(["成交额", "turnover"])
    change_pct_col = get_col(["涨跌幅", "change_pct"])

    def to_float(val):
        try:
            return float(val)
        except (ValueError, TypeError):
            return None

    return {
        "name": str(r[name_col]) if name_col else None,
        "code": stock_code,
        "latest": to_float(r[latest_col]) if latest_col else None,
        "open": to_float(r[open_col]) if open_col else None,
        "high": to_float(r[high_col]) if high_col else None,
        "low": to_float(r[low_col]) if low_col else None,
        "prev_close": to_float(r[prev_close_col]) if prev_close_col else None,
        "volume": to_float(r[volume_col]) if volume_col else None,
        "turnover": to_float(r[turnover_col]) if turnover_col else None,
        "change_pct": to_float(r[change_pct_col]) if change_pct_col else None,
        "total_cap": None,
        "float_cap": None,
        "pe": None,
        "52w_high": None,
        "52w_low": None,
        "_source": "sina",
    }


def get_stock_real_quote(stock_code: str, market: int = 1) -> dict:
    """
    Fetch real-time stock quote.
    Tries Eastmoney first, falls back to Sina if Eastmoney fails.
    """
    try:
        return get_stock_real_quote_eastmoney(stock_code, market)
    except Exception as e:
        print(f"[warn] Eastmoney quote failed for {stock_code}: {e}", file=sys.stderr)
        print(f"[info] Falling back to Sina source...", file=sys.stderr)
        return get_stock_real_quote_sina(stock_code, market)


if __name__ == "__main__":
    import sys
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    parser = argparse.ArgumentParser(description="Fetch real-time A-share quote")
    parser.add_argument("stock_code", help="6-digit stock code, e.g. 600875")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1], help="1=Shanghai (default), 0=Shenzhen")
    args = parser.parse_args()

    result = get_stock_real_quote(args.stock_code, market=args.market)
    print(json.dumps(result, ensure_ascii=False, indent=2))
