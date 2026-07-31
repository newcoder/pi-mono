#!/usr/bin/env python3
"""
同步行业分类数据到本地SQLite数据库
优先: 东方财富HTTP API -> akshare fallback -> 同花顺 fallback (不再依赖JoinQuant)
支持标准: em (Eastmoney行业分类), ths (同花顺行业分类)
用法: python sync_industries.py [--standard em] [--all]
"""

import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import argparse
import json
import sqlite3
from local_data.db import get_db
from local_data.market import market_from_code
import time

import requests

# Avoid unstable local HTTP proxies breaking requests to Eastmoney.
for _proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(_proxy_key, None)
os.environ.setdefault("NO_PROXY", "*")

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}
_FETCH_TIMEOUT = 15


def _log(msg):
    print(msg, file=sys.stderr)


def _get_market_from_code(code):
    """1=SH, 0=SZ, 2=BJ"""
    return market_from_code(code) or 0


# ─── Eastmoney API helpers ──────────────────────────────────────────────────

def _fetch_eastmoney_industry_list():
    """Fetch all industry blocks from Eastmoney."""
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    all_industries = []
    page = 1
    while True:
        params = {
            "pn": str(page),
            "pz": "100",
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fid": "f12",
            "fs": "m:90+t:3",
            "fields": "f12,f13,f14",
        }
        try:
            r = requests.get(url, params=params, headers=_HEADERS, timeout=_FETCH_TIMEOUT)
            data = r.json()
            diff = data.get("data", {}).get("diff", [])
            if not diff:
                break
            for item in diff:
                code = item.get("f12", "")
                name = item.get("f14", "")
                if code and name:
                    all_industries.append({"code": code, "name": name})
            total = data.get("data", {}).get("total", 0)
            if page * 100 >= total:
                break
            page += 1
            time.sleep(0.1)
        except Exception as e:
            _log(f"Error fetching industry list page {page}: {e}")
            break
    return all_industries


def _fetch_eastmoney_industry_stocks(industry_code):
    """Fetch all stocks in an industry block from Eastmoney."""
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    all_stocks = []
    page = 1
    while True:
        params = {
            "pn": str(page),
            "pz": "100",
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fid": "f12",
            "fs": f"b:{industry_code}",
            "fields": "f12,f14",
        }
        try:
            r = requests.get(url, params=params, headers=_HEADERS, timeout=_FETCH_TIMEOUT)
            data = r.json()
            diff = data.get("data", {}).get("diff", [])
            if not diff:
                break
            for item in diff:
                code = item.get("f12", "")
                name = item.get("f14", "")
                if code:
                    all_stocks.append({"code": code, "name": name})
            total = data.get("data", {}).get("total", 0)
            if page * 100 >= total:
                break
            page += 1
            time.sleep(0.05)
        except Exception as e:
            _log(f"Error fetching industry stocks for {industry_code}: {e}")
            break
    return all_stocks


# ─── akshare fallback helpers ───────────────────────────────────────────────

def _fetch_akshare_industry_list():
    """Fetch all industry blocks from akshare."""
    import akshare as ak
    df = ak.stock_board_industry_name_em()
    industries = []
    for _, row in df.iterrows():
        code = str(row.get("板块代码", "")).strip()
        name = str(row.get("板块名称", "")).strip()
        if code and name:
            industries.append({"code": code, "name": name})
    return industries


def _fetch_akshare_industry_stocks(industry_code):
    """Fetch all stocks in an industry block from akshare."""
    import akshare as ak
    df = ak.stock_board_industry_cons_em(symbol=industry_code)
    stocks = []
    for _, row in df.iterrows():
        code = str(row.get("代码", "")).strip()
        name = str(row.get("名称", "")).strip()
        code = code.split('.')[0]
        if code:
            stocks.append({"code": code, "name": name})
    return stocks


# ─── Public API ─────────────────────────────────────────────────────────────

def sync_standard(standard, now):
    """Sync a single industry standard. Supports 'em' (Eastmoney)."""
    _log(f"[sync_industries] Syncing standard: {standard}...")

    if standard != "em":
        _log(f"[sync_industries] Standard '{standard}' not supported by this sync path. Use 'em' (Eastmoney) or run sync_industries_ths.py for 'ths'.")
        return {"standard": standard, "error": f"Standard '{standard}' not supported by sync_standard"}

    industries = None
    try:
        industries = _fetch_eastmoney_industry_list()
        _log(f"[sync_industries] Eastmoney industry list: {len(industries)} industries")
    except Exception as e:
        _log(f"[sync_industries] Eastmoney industry list failed: {e}")
        try:
            industries = _fetch_akshare_industry_list()
            _log(f"[sync_industries] Fallback to akshare: {len(industries)} industries")
        except Exception as e2:
            _log(f"[sync_industries] akshare fallback also failed: {e2}")
            return {"standard": standard, "error": str(e2)}

    if not industries:
        return {"standard": standard, "error": "No industries found"}

    conn = get_db()
    cur = conn.cursor()

    # Save industry definitions
    for ind in industries:
        cur.execute(
            """INSERT OR REPLACE INTO industries
               (industry_code, name, standard, level, parent_code, start_date, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (ind["code"], ind["name"], standard, 1, None, None, now)
        )

    # Save stock-industry mappings and update stocks.industry default
    default_industry_map = {}
    mapping_count = 0

    for idx, ind in enumerate(industries):
        code = ind.get("code", "")
        name = ind.get("name", "")
        if not code or not name:
            continue

        stocks = []
        try:
            stocks = _fetch_eastmoney_industry_stocks(code)
        except Exception as e:
            _log(f"[sync_industries] Eastmoney failed for {name}: {e}")
            try:
                stocks = _fetch_akshare_industry_stocks(code)
            except Exception as e2:
                _log(f"[sync_industries] akshare fallback failed for {name}: {e2}")

        for stock in stocks:
            stock_code = stock.get("code", "")
            stock_name = stock.get("name")
            if not stock_code:
                continue
            market = _get_market_from_code(stock_code)
            cur.execute(
                """INSERT OR REPLACE INTO stock_industries
                   (code, market, industry_code, standard, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (stock_code, market, code, standard, now)
            )
            default_industry_map[stock_code] = name
            mapping_count += 1

        if (idx + 1) % 20 == 0:
            _log(f"[sync_industries] Progress: {idx + 1}/{len(industries)} industries, {mapping_count} mappings")
            conn.commit()

        time.sleep(0.05)

    # Update stocks.industry default
    for stock_code, industry_name in default_industry_map.items():
        market = _get_market_from_code(stock_code)
        cur.execute(
            "UPDATE stocks SET industry = ?, updated_at = ? WHERE code = ? AND market = ?",
            (industry_name, now, stock_code, market)
        )

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM industries WHERE standard = ?", (standard,))
    industry_count = cur.fetchone()[0]

    conn.close()

    result = {
        "standard": standard,
        "industries": industry_count,
        "mappings": mapping_count,
    }
    _log(f"[sync_industries] {standard}: {industry_count} industries, {mapping_count} mappings")
    return result


def sync_all_standards():
    """Sync all supported industry standards. Falls back to THS if Eastmoney is blocked."""
    now = time.strftime('%Y-%m-%dT%H:%M:%S')

    results = []

    # Try Eastmoney first
    try:
        result = sync_standard("em", now)
        results.append(result)
        if "error" not in result and result.get("mappings", 0) >= 1000:
            output = {"results": results, "total_standards": 1}
            print(json.dumps(output, ensure_ascii=False))
            return output
        _log(f"[sync_industries] Eastmoney result looks incomplete ({result.get('mappings', 0)} mappings), trying THS fallback...")
    except Exception as e:
        _log(f"[sync_industries] Eastmoney sync failed: {e}")
        results.append({"standard": "em", "error": str(e)})

    # Fallback to Tonghuashun
    try:
        import sync_industries_ths
        ths_result = sync_industries_ths.sync_ths_industries()
        results.append(ths_result)
    except Exception as e:
        _log(f"[sync_industries] THS fallback also failed: {e}")
        results.append({"standard": "ths", "error": str(e)})

    output = {
        "results": results,
        "total_standards": len(results),
    }
    print(json.dumps(output, ensure_ascii=False))
    return output


def main():
    parser = argparse.ArgumentParser(description="Sync industry classifications (Eastmoney/akshare, no JoinQuant)")
    parser.add_argument("--standard", type=str, help="Sync single standard: em")
    parser.add_argument("--all", action="store_true", help="Sync all standards")
    args = parser.parse_args()

    if args.standard:
        now = time.strftime('%Y-%m-%dT%H:%M:%S')
        result = sync_standard(args.standard, now)
        print(json.dumps(result, ensure_ascii=False))
    else:
        sync_all_standards()


if __name__ == "__main__":
    main()
