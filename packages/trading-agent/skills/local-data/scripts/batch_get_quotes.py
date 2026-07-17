#!/usr/bin/env python3
"""
Batch fetch real-time stock quotes from Sina HTTP API.
Falls back to local SQLite for codes that fail or outside trading hours.
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
import re
import sqlite3
import io
from urllib.parse import quote

import requests
import logging

from local_data.db import get_db, get_db_path
from local_data.market import market_prefix

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://finance.sina.com.cn",
}


def _to_float(val):
    try:
        if val is None or val == "":
            return None
        return float(val)
    except (ValueError, TypeError):
        return None


def _query_local_db(sql: str, params: tuple = ()) -> list:
    if not os.path.exists(get_db_path()):
        return []
    try:
        conn = get_db()
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception:
        logger.warning("Local DB query failed", exc_info=True)
        return []


def _get_local_quote(code: str, market: int) -> dict | None:
    rows = _query_local_db(
        "SELECT * FROM quotes WHERE code = ? AND market = ? ORDER BY snapshot_date DESC LIMIT 1",
        (code, market),
    )
    if rows:
        r = rows[0]
        return {
            "name": r.get("name"),
            "code": code,
            "market": market,
            "latest": _to_float(r.get("latest")),
            "open": _to_float(r.get("open")),
            "high": _to_float(r.get("high")),
            "low": _to_float(r.get("low")),
            "prev_close": _to_float(r.get("prev_close")),
            "volume": _to_float(r.get("volume")),
            "turnover": _to_float(r.get("turnover")),
            "change_pct": _to_float(r.get("change_pct")),
            "pe": _to_float(r.get("pe")),
            "pb": _to_float(r.get("pb")),
            "total_cap": _to_float(r.get("total_cap")),
            "float_cap": _to_float(r.get("float_cap")),
            "_source": "local_quotes",
        }

    rows = _query_local_db(
        "SELECT * FROM klines WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq' ORDER BY date DESC LIMIT 1",
        (code, market),
    )
    if rows:
        r = rows[0]
        close_p = _to_float(r.get("close"))
        pre_close = _to_float(r.get("pre_close"))
        change_pct = None
        if close_p is not None and pre_close and pre_close != 0:
            change_pct = round((close_p - pre_close) / pre_close * 100, 4)
        return {
            "name": None,
            "code": code,
            "market": market,
            "latest": close_p,
            "open": _to_float(r.get("open")),
            "high": _to_float(r.get("high")),
            "low": _to_float(r.get("low")),
            "prev_close": pre_close,
            "volume": _to_float(r.get("volume")),
            "turnover": _to_float(r.get("turnover")),
            "change_pct": change_pct,
            "pe": None,
            "pb": None,
            "total_cap": None,
            "float_cap": None,
            "_source": "local_klines",
        }
    return None


def _market_prefix(code: str, market: int) -> str:
    prefix = market_prefix(code, "lower")
    if prefix:
        return prefix
    return {1: "sh", 2: "bj", 0: "sz"}.get(market, "sz")


def _sina_symbol(code: str, market: int) -> str:
    return f"{_market_prefix(code, market)}{code}"


def fetch_sina_batch_quotes(items: list[dict]) -> list[dict]:
    """Fetch quotes for multiple stocks from Sina in one HTTP request."""
    if not items:
        return []

    symbols = [_sina_symbol(i["code"], i.get("market", 1)) for i in items]
    url = "https://hq.sinajs.cn/list=" + ",".join(quote(s) for s in symbols)

    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
        r.encoding = "gbk"
        text = r.text
    except Exception:
        logger.warning("Sina batch request failed", exc_info=True)
        return []

    results = []
    for line in text.split(";"):
        line = line.strip()
        if not line.startswith("var hq_str_"):
            continue
        m = re.match(r'var hq_str_(sh|sz|bj)(\d{6})="(.*?)";?', line)
        if not m:
            continue
        prefix, code, data = m.groups()
        fields = data.split(",")
        if len(fields) < 4:
            continue

        # Sina A-share format:
        # 0:name, 1:today_open, 2:prev_close, 3:latest, 4:high, 5:low, ...
        name = fields[0]
        latest = _to_float(fields[3])
        prev_close = _to_float(fields[2])
        change_pct = None
        if latest is not None and prev_close:
            change_pct = round((latest - prev_close) / prev_close * 100, 4)

        results.append({
            "name": name,
            "code": code,
            "market": 1 if prefix == "sh" else (0 if prefix == "sz" else 2),
            "latest": latest,
            "open": _to_float(fields[1]),
            "high": _to_float(fields[4]),
            "low": _to_float(fields[5]),
            "prev_close": prev_close,
            "volume": _to_float(fields[8]) if len(fields) > 8 else None,
            "turnover": _to_float(fields[9]) if len(fields) > 9 else None,
            "change_pct": change_pct,
            "pe": None,
            "pb": None,
            "total_cap": None,
            "float_cap": None,
            "_source": "sina_batch",
        })

    return results


def batch_get_quotes(items: list[dict]) -> list[dict]:
    """Get quotes for a list of {code, market} items. Use Sina batch + local fallback."""
    if not items:
        return []

    # Deduplicate by code:market
    seen = set()
    unique_items = []
    for i in items:
        key = (i["code"], i.get("market", 1))
        if key not in seen:
            seen.add(key)
            unique_items.append({"code": i["code"], "market": i.get("market", 1)})

    sina_results = fetch_sina_batch_quotes(unique_items)
    result_map = {(r["code"], r["market"]): r for r in sina_results if r.get("latest") is not None}

    # Fallback to local DB for missing items
    for item in unique_items:
        key = (item["code"], item["market"])
        if key not in result_map:
            local = _get_local_quote(item["code"], item["market"])
            if local:
                result_map[key] = local

    return list(result_map.values())


def main():
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except ValueError:
        pass

    parser = argparse.ArgumentParser(description="Batch fetch A-share quotes")
    parser.add_argument("--items", required=True, help='JSON array of {"code": "600519", "market": 1}')
    args = parser.parse_args()

    items = json.loads(args.items)
    if not isinstance(items, list):
        raise ValueError("--items must be a JSON array")

    results = batch_get_quotes(items)
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
