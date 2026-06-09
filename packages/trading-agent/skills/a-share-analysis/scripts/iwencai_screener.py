#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iWencai screener wrapper for trading-agent integration.
Calls iWencai OpenAPI and returns JSON results.
"""

import argparse
import json
import os
import secrets
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = "https://openapi.iwencai.com"
API_KEY = os.environ.get("IWENCAI_API_KEY")
DEFAULT_TIMEOUT = 30
MAX_RETRIES = 2

PRESETS = {
    "涨停股": "今日涨停的A股",
    "强势股": "今日涨幅超5%且成交量放大的A股",
    "主力流入": "今日主力净流入前20的A股",
    "MACD金叉": "MACD金叉且成交量放大的A股",
    "低价股": "股价低于10元且今日涨幅超3%的A股",
    "次新股": "上市不足一年且今日涨幅超5%的A股",
    "高ROE": "ROE大于15%且市盈率小于20的A股",
    "破净股": "市净率小于1的A股",
    "热门行业": "今日涨幅前10的行业板块",
    "行业资金": "今日主力净流入前10的行业板块",
    "热门概念": "今日涨幅前10的概念板块",
    "概念资金": "今日主力净流入前10的概念板块",
    "热门板块": "今日涨幅前10的板块",
    "板块资金": "今日主力净流入前10的板块",
}


def build_headers() -> dict:
    if not API_KEY:
        return {"error": "IWENCAI_API_KEY environment variable not set"}
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json; charset=utf-8",
        "X-Claw-Call-Type": "normal",
        "X-Claw-Skill-Id": "hithink-astock-selector",
        "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": secrets.token_hex(32),
    }


def query_iwencai(query: str, page: str = "1", limit: str = "20") -> dict:
    payload = {
        "query": query,
        "page": page,
        "limit": limit,
        "is_cache": "1",
        "expand_index": "true",
    }
    headers = build_headers()
    if "error" in headers:
        return {"success": False, "error": headers["error"]}

    req = Request(
        f"{BASE_URL}/v1/query2data",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            last_error = e
            if e.code == 401:
                return {"success": False, "error": "Authentication failed: invalid API key"}
            if attempt < MAX_RETRIES:
                time.sleep(0.5 * (attempt + 1))
                req = Request(
                    f"{BASE_URL}/v1/query2data",
                    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    headers=build_headers(),
                    method="POST",
                )
        except (URLError, Exception) as e:
            last_error = e
            if attempt < MAX_RETRIES:
                time.sleep(0.5 * (attempt + 1))

    return {"success": False, "error": f"Request failed after {MAX_RETRIES} retries: {last_error}"}


def query_all_pages(query: str, limit_per_page: int = 100, max_pages: int = 5) -> list[dict]:
    first_page = query_iwencai(query, "1", str(limit_per_page))
    if "error" in first_page and "datas" not in first_page:
        return []
    total_count = first_page.get("code_count", 0)
    all_datas = first_page.get("datas", [])

    if total_count <= limit_per_page:
        return all_datas

    total_pages = min((total_count + limit_per_page - 1) // limit_per_page, max_pages)
    if total_pages <= 1:
        return all_datas

    def fetch_page(page_num: int) -> list[dict]:
        result = query_iwencai(query, str(page_num), str(limit_per_page))
        return result.get("datas", [])

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fetch_page, p): p for p in range(2, total_pages + 1)}
        for future in as_completed(futures):
            page_datas = future.result()
            all_datas.extend(page_datas)

    return all_datas


def main():
    parser = argparse.ArgumentParser(description="iWencai screener for trading-agent")
    parser.add_argument("-q", "--query", type=str, help="Natural language query")
    parser.add_argument("-p", "--preset", type=str, help=f"Preset: {', '.join(PRESETS.keys())}")
    parser.add_argument("-m", "--mode", type=str, choices=["stock", "plate"], default="stock")
    parser.add_argument("-l", "--limit", type=int, default=20)
    parser.add_argument("-a", "--all", action="store_true", help="Fetch all pages (up to 5)")
    parser.add_argument("--max-pages", type=int, default=5)
    parser.add_argument("--max-components", type=int, default=None, help="[plate mode] filter out plates with too many components")
    args = parser.parse_args()

    if args.preset:
        if args.preset not in PRESETS:
            print(json.dumps({"success": False, "error": f"Unknown preset: {args.preset}"}, ensure_ascii=False))
            sys.exit(1)
        query = PRESETS[args.preset]
    elif args.query:
        query = args.query
    else:
        print(json.dumps({"success": False, "error": "Either --query or --preset is required"}, ensure_ascii=False))
        sys.exit(1)

    if args.mode == "plate" and "板块" not in query:
        query = query.replace("的A股", "的板块").replace("股票", "板块")

    if args.mode == "plate" and args.max_components is not None:
        if "成分股" not in query and "成份股" not in query:
            query += "，成分股家数"

    if not API_KEY:
        print(json.dumps({"success": False, "error": "IWENCAI_API_KEY not configured"}, ensure_ascii=False))
        sys.exit(1)

    t0 = time.time()
    if args.all:
        datas = query_all_pages(query, args.limit, args.max_pages)
        result = {"datas": datas, "code_count": len(datas), "columns": []}
    else:
        result = query_iwencai(query, "1", str(args.limit))

    elapsed = time.time() - t0

    if "error" in result and "datas" not in result:
        print(json.dumps({"success": False, "error": result["error"], "query": query}, ensure_ascii=False))
        sys.exit(1)

    datas = result.get("datas", [])
    code_count = result.get("code_count", len(datas))
    columns = result.get("columns", [])

    # Plate mode: filter by component count
    filtered_count = 0
    if args.mode == "plate" and args.max_components is not None and datas:
        possible_keys = ["成份股数量", "成分股数量", "成分股家数", "成份股家数", "股票数量", "个股数量"]
        comp_key = None
        for pk in possible_keys:
            if pk in datas[0]:
                comp_key = pk
                break
        if comp_key:
            original_len = len(datas)
            datas = [d for d in datas if d.get(comp_key, 99999) <= args.max_components]
            filtered_count = original_len - len(datas)
            code_count = len(datas)

    # Extract useful column info
    column_info = []
    if columns:
        for c in columns:
            column_info.append({"key": c.get("key"), "name": c.get("index_name", c.get("key"))})
    elif datas:
        # Auto-detect priority columns
        priority = ["股票代码", "股票简称", "最新价", "最新涨跌幅", "涨跌幅", "主力净流入", "成交量", "换手率", "板块名称", "板块涨跌幅"]
        for key in priority:
            if key in datas[0]:
                column_info.append({"key": key, "name": key})
        for key in datas[0].keys():
            if key not in [c["key"] for c in column_info] and not key.startswith("_"):
                column_info.append({"key": key, "name": key})

    output = {
        "success": True,
        "query": query,
        "mode": args.mode,
        "count": code_count,
        "filtered": filtered_count,
        "elapsed_ms": round(elapsed * 1000, 1),
        "columns": column_info[:12],
        "results": datas,
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
