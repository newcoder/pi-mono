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

import ths_client


def _market_from_code(code: str) -> int:
    """1=SH, 0=SZ, 2=BJ"""
    return market_from_code(code) or 0


def fetch_ths_industry_list() -> list:
    """Fetch THS industry list via direct requests (ths_client)."""
    industries = ths_client.fetch_industry_list()
    logger.info(f"Fetched {len(industries)} THS industries from direct THS API")
    return industries


def fetch_ths_industry_stocks(industry_code: str, headers: dict) -> list:
    """Fetch all stocks in a THS industry block by paginating the detail page."""
    return ths_client.fetch_board_stocks(industry_code)


def sync_ths_industries() -> dict:
    """Sync THS industry classifications to local DB."""
    now = time.strftime('%Y-%m-%dT%H:%M:%S')
    conn = get_db()
    cur = conn.cursor()

    industries = fetch_ths_industry_list()
    if not industries:
        return {"standard": "ths", "error": "No industries found"}

    headers = ths_client.get_ths_headers()
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
