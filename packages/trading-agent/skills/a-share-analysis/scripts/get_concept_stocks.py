#!/usr/bin/env python3
"""
获取概念股成分股（通过东方财富 API）
用法: python get_concept_stocks.py <概念名称>
输出: JSON {concept: str, stocks: [{code, name, price, change_pct}]}
"""

import argparse
import json
import sys
import time

try:
    import requests
except ImportError:
    print(json.dumps({"error": "requests not installed"}, ensure_ascii=False))
    sys.exit(1)

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}

_FETCH_TIMEOUT = 15


def fetch_concept_stocks(concept_name: str) -> dict:
    # Step 1: Search for concept code
    search_url = "https://searchapi.eastmoney.com/api/suggest/get"
    search_params = {
        "input": concept_name,
        "type": "14",
        "count": "5",
    }
    try:
        r = requests.get(search_url, params=search_params, headers=_HEADERS, timeout=_FETCH_TIMEOUT)
        r.raise_for_status()
        search_data = r.json()
    except Exception as e:
        return {"error": f"Concept search failed: {e}"}

    suggestions = search_data.get("QuotationCodeTable", {}).get("Data", [])
    if not suggestions:
        return {"concept": concept_name, "stocks": []}

    concept_code = suggestions[0].get("Code", "")
    concept_label = suggestions[0].get("Name", concept_name)

    if not concept_code:
        return {"concept": concept_name, "stocks": []}

    # Step 2: Fetch stocks in this concept
    list_url = "https://push2.eastmoney.com/api/qt/clist/get"
    list_params = {
        "pn": "1",
        "pz": "100",
        "po": "1",
        "np": "1",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": f"b:{concept_code}",
        "fields": "f12,f14,f2,f3",
    }
    try:
        r = requests.get(list_url, params=list_params, headers=_HEADERS, timeout=_FETCH_TIMEOUT)
        r.raise_for_status()
        list_data = r.json()
    except Exception as e:
        return {"error": f"Concept stocks fetch failed: {e}"}

    diff = list_data.get("data", {}).get("diff", [])
    stocks = []
    for item in diff:
        code = item.get("f12", "")
        name = item.get("f14", "")
        if not code or not name:
            continue
        price_raw = item.get("f2")
        change_raw = item.get("f3")
        stock = {
            "code": code,
            "name": name,
        }
        if price_raw is not None:
            try:
                stock["price"] = float(price_raw)
            except (ValueError, TypeError):
                pass
        if change_raw is not None:
            try:
                stock["change_pct"] = float(change_raw)
            except (ValueError, TypeError):
                pass
        stocks.append(stock)

    return {"concept": concept_label, "stocks": stocks}


def main():
    parser = argparse.ArgumentParser(description="获取概念股成分股")
    parser.add_argument("concept", type=str, help="概念名称，如 人工智能、新能源")
    args = parser.parse_args()

    result = fetch_concept_stocks(args.concept)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
