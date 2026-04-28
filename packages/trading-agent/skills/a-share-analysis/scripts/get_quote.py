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


def get_stock_real_quote(stock_code: str, market: int = 1) -> dict:
    """
    Fetch real-time stock quote from Eastmoney.
    market: 1 = Shanghai, 0 = Shenzhen
    """
    secid = f"{market}.{stock_code}"
    api_url = (
        "https://push2.eastmoney.com/api/qt/stock/get"
        "?ut=bd1d9ddb04089700cf9c27f6f7426281"
        "&fltt=2&invt=2&volt=2"
        "&fields=f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f57,f58,f60,f61,f116,f117,f162,f163,f164,f170,f171,f173,f177,f183,f184,f185,f186,f187,f188,f189,f190"
        f"&secid={secid}&_="
    )
    r = requests.get(api_url, headers=HEADERS, timeout=20)
    # Eastmoney returns GBK for this endpoint
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
        "raw": d,
    }


if __name__ == "__main__":
    import sys
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    parser = argparse.ArgumentParser(description="Fetch real-time A-share quote from Eastmoney")
    parser.add_argument("stock_code", help="6-digit stock code, e.g. 600875")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1], help="1=Shanghai (default), 0=Shenzhen")
    args = parser.parse_args()

    result = get_stock_real_quote(args.stock_code, market=args.market)
    print(json.dumps(result, ensure_ascii=False, indent=2))
