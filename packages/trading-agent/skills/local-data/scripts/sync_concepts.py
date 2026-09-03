#!/usr/bin/env python3
"""
同步概念股数据到本地SQLite数据库
优先: 东方财富HTTP API (不再依赖JoinQuant)
用法: python sync_concepts.py [--concept <概念名称>] [--all]
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

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}
_FETCH_TIMEOUT = 15


def _log(msg):
    """Log to stderr so stdout stays clean for JSON output."""
    print(msg, file=sys.stderr)


def _get_market_from_code(code):
    """1=SH, 0=SZ, 2=BJ"""
    return market_from_code(code) or 0


def _save_concept_stocks(concept_name, stocks):
    """Save concept stocks to SQLite."""
    conn = get_db()
    cur = conn.cursor()
    now = time.strftime('%Y-%m-%dT%H:%M:%S')

    # Delete old data for this concept
    cur.execute("DELETE FROM concept_stocks WHERE concept = ?", (concept_name,))

    for stock in stocks:
        code = stock.get("code", "")
        name = stock.get("name")
        cur.execute(
            "INSERT OR REPLACE INTO concept_stocks (concept, code, name, updated_at) VALUES (?, ?, ?, ?)",
            (concept_name, code, name, now)
        )

    conn.commit()
    conn.close()
    return len(stocks)


# ─── Eastmoney API helpers ──────────────────────────────────────────────────

def _fetch_eastmoney_concept_list():
    """Fetch all concept blocks from Eastmoney."""
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    all_concepts = []
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
            "fs": "m:90+t:2",
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
                    all_concepts.append({"code": code, "name": name})
            total = data.get("data", {}).get("total", 0)
            if page * 100 >= total:
                break
            page += 1
            time.sleep(0.1)
        except Exception as e:
            _log(f"Error fetching concept list page {page}: {e}")
            break
    return all_concepts


def _fetch_eastmoney_concept_stocks(concept_code):
    """Fetch all stocks in a concept block from Eastmoney."""
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
            "fs": f"b:{concept_code}",
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
            _log(f"Error fetching concept stocks for {concept_code}: {e}")
            break
    return all_stocks


# ─── Public API ─────────────────────────────────────────────────────────────

def sync_single_concept(concept_name):
    """Sync a single concept by name."""
    # Step 1: Search for concept by name (Eastmoney direct; akshare removed)
    concepts = None
    try:
        concepts = _fetch_eastmoney_concept_list()
        _log(f"Eastmoney concept list: {len(concepts)} concepts")
    except Exception as e:
        _log(f"Eastmoney concept list failed: {e}")
        print(json.dumps({"error": f"Concept list fetch failed: {e}"}, ensure_ascii=False))
        return 0

    matched = [c for c in concepts if c["name"] == concept_name]
    if not matched:
        matched = [c for c in concepts if concept_name in c["name"]]

    if not matched:
        print(json.dumps({"error": f"Concept '{concept_name}' not found"}, ensure_ascii=False))
        return 0

    concept = matched[0]
    actual_name = concept["name"]
    concept_code = concept["code"]

    # Step 2: Fetch stocks (Eastmoney direct)
    stocks = []
    try:
        stocks = _fetch_eastmoney_concept_stocks(concept_code)
    except Exception as e:
        _log(f"Eastmoney concept stocks failed: {e}")

    count = _save_concept_stocks(actual_name, stocks)
    print(json.dumps({"concept": actual_name, "count": count}, ensure_ascii=False))
    return count


def sync_all_concepts():
    """Sync all concepts."""
    concepts = None
    try:
        concepts = _fetch_eastmoney_concept_list()
        _log(f"[sync_concepts] Eastmoney concept list: {len(concepts)} concepts")
    except Exception as e:
        _log(f"[sync_concepts] Eastmoney concept list failed: {e}")
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return {"error": str(e)}

    if not concepts:
        print(json.dumps({"error": "No concepts found"}, ensure_ascii=False))
        return {"error": "No concepts found"}

    conn = get_db()
    cur = conn.cursor()
    now = time.strftime('%Y-%m-%dT%H:%M:%S')

    # Clear old data before full sync
    cur.execute("DELETE FROM concept_stocks")

    total_stocks = 0
    for idx, concept in enumerate(concepts):
        name = concept.get("name", "")
        code = concept.get("code", "")
        if not name or not code:
            continue

        stocks = []
        try:
            stocks = _fetch_eastmoney_concept_stocks(code)
        except Exception as e:
            _log(f"[sync_concepts] Eastmoney failed for {name}: {e}")

        for stock in stocks:
            cur.execute(
                "INSERT OR REPLACE INTO concept_stocks (concept, code, name, updated_at) VALUES (?, ?, ?, ?)",
                (name, stock.get("code", ""), stock.get("name"), now)
            )
            total_stocks += 1

        if (idx + 1) % 50 == 0:
            _log(f"[sync_concepts] Progress: {idx + 1}/{len(concepts)} concepts, {total_stocks} stocks synced")
            conn.commit()

        time.sleep(0.05)

    conn.commit()
    conn.close()

    _log(f"[sync_concepts] Done. {len(concepts)} concepts, {total_stocks} stocks synced.")
    result = {"total_concepts": len(concepts), "total_stocks": total_stocks}
    print(json.dumps(result, ensure_ascii=False))
    return result


def main():
    parser = argparse.ArgumentParser(description="Sync concept stocks (Eastmoney HTTP direct)")
    parser.add_argument("--concept", type=str, help="Sync single concept by name")
    parser.add_argument("--all", action="store_true", help="Sync all concepts")
    args = parser.parse_args()

    if args.all:
        sync_all_concepts()
    elif args.concept:
        sync_single_concept(args.concept)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
