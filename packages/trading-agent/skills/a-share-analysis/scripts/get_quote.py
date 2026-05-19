#!/usr/bin/env python3
"""
Fetch real-time or latest-available stock quote.
- Trading hours: live Eastmoney API
- Non-trading hours: local SQLite (klines/quotes) fallback
"""
import argparse
import json
import os
import sqlite3
import sys
import io
from datetime import datetime

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}

_DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")


def _is_a_share_trading_hours() -> bool:
    """Check if current time is within A-share trading hours (Mon-Fri 09:30-11:30, 13:00-15:00)."""
    now = datetime.now()
    if now.weekday() >= 5:
        return False
    hm = now.hour * 100 + now.minute
    return (930 <= hm <= 1130) or (1300 <= hm <= 1500)


def _query_local_db(sql: str, params: tuple = ()) -> list:
    if not os.path.exists(_DB_PATH):
        return []
    try:
        conn = sqlite3.connect(_DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception:
        return []


def _get_quote_from_local(code: str, market: int) -> dict:
    """Try quotes table first, then klines table."""
    # 1. Try quotes table (latest snapshot)
    rows = _query_local_db(
        "SELECT * FROM quotes WHERE code = ? AND market = ? ORDER BY snapshot_date DESC LIMIT 1",
        (code, market),
    )
    if rows:
        r = rows[0]
        return {
            "name": r.get("name"),
            "code": code,
            "latest": r.get("latest"),
            "open": r.get("open"),
            "high": r.get("high"),
            "low": r.get("low"),
            "prev_close": r.get("prev_close"),
            "volume": r.get("volume"),
            "turnover": r.get("turnover"),
            "change_pct": r.get("change_pct"),
            "pe": r.get("pe"),
            "pb": r.get("pb"),
            "total_cap": r.get("total_cap"),
            "float_cap": r.get("float_cap"),
            "high_52w": r.get("high_52w"),
            "low_52w": r.get("low_52w"),
            "_source": "local_quotes",
            "_note": "Non-trading hours: using local DB snapshot",
        }

    # 2. Fallback to klines table (latest daily bar)
    rows = _query_local_db(
        "SELECT * FROM klines WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq' ORDER BY date DESC LIMIT 1",
        (code, market),
    )
    if rows:
        r = rows[0]
        close_p = r.get("close")
        pre_close = r.get("pre_close")
        change_pct = None
        if close_p is not None and pre_close is not None and pre_close != 0:
            change_pct = round((close_p - pre_close) / pre_close * 100, 4)
        return {
            "name": None,
            "code": code,
            "latest": close_p,
            "open": r.get("open"),
            "high": r.get("high"),
            "low": r.get("low"),
            "prev_close": pre_close,
            "volume": r.get("volume"),
            "turnover": r.get("turnover"),
            "change_pct": change_pct,
            "pe": None,
            "pb": None,
            "total_cap": None,
            "float_cap": None,
            "high_52w": None,
            "low_52w": None,
            "_source": "local_klines",
            "_note": "Non-trading hours: using local klines data",
        }

    return {"error": "No local data available"}


def get_stock_real_quote(stock_code: str, market: int = 1) -> dict:
    """
    Fetch stock quote.
    Priority: mootdx (TCP direct) -> Eastmoney HTTP -> local SQLite fallback.
    """
    is_trading = _is_a_share_trading_hours()

    # 1. Primary: mootdx TCP direct (fast, ~15ms)
    try:
        from mootdx_data import get_quote
        result = get_quote(stock_code, market)
        if result:
            return result
    except Exception:
        pass  # fallback to next source

    # 2. Fallback: Eastmoney HTTP API
    try:
        import requests
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
        if d:
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
            }
    except Exception as e:
        if not is_trading:
            # Non-trading + network fail -> return local fallback error
            return {"error": f"Non-trading hours, no local data: {e}"}
        return {"error": str(e)}

    # 3. Last resort: local SQLite (non-trading hours)
    if not is_trading:
        result = _get_quote_from_local(stock_code, market)
        if "error" not in result:
            return result

    # Should not reach here normally
    return {"error": "Unable to fetch quote"}


if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except ValueError:
        pass
    parser = argparse.ArgumentParser(description="Fetch A-share quote (live or local fallback)")
    parser.add_argument("stock_code", help="6-digit stock code, e.g. 600875")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1], help="1=Shanghai (default), 0=Shenzhen")
    args = parser.parse_args()

    result = get_stock_real_quote(args.stock_code, market=args.market)
    print(json.dumps(result, ensure_ascii=False, indent=2))
