#!/usr/bin/env python3
"""
Sync Tonghuashun (THS) industry classification to local SQLite DB.
Falls back to THS when Eastmoney API is unavailable.
"""
import os
import sys
import time
import json
import sqlite3
import logging
import warnings

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import requests
from bs4 import BeautifulSoup
from local_data.db import get_db, get_db_path
from local_data.market import market_from_code

warnings.filterwarnings('ignore')

# Avoid unstable local HTTP proxies breaking requests to THS.
for _proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(_proxy_key, None)
os.environ.setdefault("NO_PROXY", "*")

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "http://q.10jqka.com.cn/thshy/",
}

_AKSHARE_AVAILABLE = False
try:
    from akshare.datasets import get_ths_js
    import py_mini_racer
    _AKSHARE_AVAILABLE = True
except Exception as _e:
    logger.warning(f"akshare/py_mini_racer not available: {_e}")


def _get_hexin_v() -> str:
    """Generate hexin-v cookie used by THS anti-bot."""
    if not _AKSHARE_AVAILABLE:
        raise RuntimeError("akshare/py_mini_racer required for THS cookie generation")
    js_code = py_mini_racer.MiniRacer()
    with open(get_ths_js("ths.js"), encoding="utf-8") as f:
        js_content = f.read()
    js_code.eval(js_content)
    return js_code.call("v")


def _get_ths_headers() -> dict:
    v = _get_hexin_v()
    headers = dict(_HEADERS)
    headers["Cookie"] = f"v={v}"
    return headers


def _market_from_code(code: str) -> int:
    """1=SH, 0=SZ, 2=BJ"""
    return market_from_code(code) or 0


def fetch_ths_industry_list() -> list:
    """Fetch THS industry list via akshare."""
    import akshare as ak
    df = ak.stock_board_industry_name_ths()
    industries = []
    for _, row in df.iterrows():
        code = str(row.get("code", "")).strip()
        name = str(row.get("name", "")).strip()
        if code and name:
            industries.append({"code": code, "name": name})
    logger.info(f"Fetched {len(industries)} THS industries from akshare")
    return industries


def fetch_ths_industry_stocks(industry_code: str, headers: dict) -> list:
    """Fetch all stocks in a THS industry block by paginating the detail page."""
    stocks = []
    for page in range(1, 100):
        url = f"http://q.10jqka.com.cn/thshy/detail/code/{industry_code}/order/desc/page/{page}"
        try:
            r = requests.get(url, headers=headers, timeout=15)
            if r.status_code != 200:
                logger.warning(f"THS page {page} for {industry_code} status {r.status_code}")
                break
            text = r.content.decode("gb18030", errors="ignore")
            soup = BeautifulSoup(text, "lxml")
            table = soup.find("table", class_="m-table")
            if not table:
                break
            rows = table.find_all("tr")[1:]  # skip header
            if not rows:
                break
            for row in rows:
                cells = row.find_all("td")
                if len(cells) >= 3:
                    stock_code = cells[1].text.strip()
                    stock_name = cells[2].text.strip()
                    if stock_code and stock_code.isdigit():
                        stocks.append({"code": stock_code, "name": stock_name})
            if len(rows) < 20:
                break
            time.sleep(0.2)
        except Exception as e:
            logger.warning(f"THS fetch failed for {industry_code} page {page}: {e}")
            break
    return stocks


def sync_ths_industries() -> dict:
    """Sync THS industry classifications to local DB."""
    now = time.strftime('%Y-%m-%dT%H:%M:%S')
    conn = get_db()
    cur = conn.cursor()

    industries = fetch_ths_industry_list()
    if not industries:
        return {"standard": "ths", "error": "No industries found"}

    headers = _get_ths_headers()
    mapping_count = 0
    valid_stocks_count = 0

    for idx, ind in enumerate(industries):
        code = ind["code"]
        name = ind["name"]

        cur.execute(
            """INSERT OR REPLACE INTO industries
               (industry_code, name, standard, level, parent_code, start_date, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (code, name, "ths", 1, None, None, now)
        )

        stocks = fetch_ths_industry_stocks(code, headers)
        default_industry_map = {}
        for stock in stocks:
            stock_code = stock["code"]
            stock_name = stock["name"]
            market = _market_from_code(stock_code)
            cur.execute(
                """INSERT OR REPLACE INTO stock_industries
                   (code, market, industry_code, standard, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (stock_code, market, code, "ths", now)
            )
            default_industry_map[stock_code] = name
            mapping_count += 1

        # Update stocks.industry default for mapped stocks
        for stock_code, industry_name in default_industry_map.items():
            market = _market_from_code(stock_code)
            cur.execute(
                "UPDATE stocks SET industry = ?, updated_at = ? WHERE code = ? AND market = ?",
                (industry_name, now, stock_code, market)
            )

        valid_stocks_count += len(stocks)

        if (idx + 1) % 10 == 0 or idx + 1 == len(industries):
            logger.info(
                f"[sync_industries_ths] Progress: {idx + 1}/{len(industries)} industries, "
                f"{mapping_count} mappings, {valid_stocks_count} stocks"
            )
            conn.commit()
        time.sleep(0.3)

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM industries WHERE standard = ?", ("ths",))
    industry_count = cur.fetchone()[0]
    conn.close()

    result = {
        "standard": "ths",
        "industries": industry_count,
        "mappings": mapping_count,
        "stocks": valid_stocks_count,
    }
    logger.info(f"[sync_industries_ths] Done: {result}")
    return result


def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
    )
    result = sync_ths_industries()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
