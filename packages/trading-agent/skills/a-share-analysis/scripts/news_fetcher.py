#!/usr/bin/env python3
"""
Stock news fetcher.
Fetches news from Eastmoney (东方财富), Securities Times (证券时报), and CLS (财联社).
Supports both individual stock news and market-wide news scanning.
"""
import argparse
import json
import sys
import os
import re
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

# Retry-enabled session
_SESSION = requests.Session()
_SESSION.mount("https://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1.0)))
_SESSION.mount("http://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1.0)))


# ── Eastmoney (akshare) ──────────────────────────────────────────────────────

def fetch_eastmoney_news(code: str, limit: int = 20) -> List[Dict]:
    """Fetch news for a single stock from Eastmoney via akshare."""
    try:
        import akshare as ak
        df = ak.stock_news_em(symbol=code)
        if df is None or df.empty:
            return []

        results = []
        # Column order: 关键词, 股票代码, 新闻标题, 发布时间, 新闻来源, 新闻链接
        cols = df.columns.tolist()
        for _, row in df.head(limit).iterrows():
            try:
                pub_time = str(row.iloc[3]) if len(cols) > 3 else ""
                results.append({
                    "code": code,
                    "title": str(row.iloc[2]) if len(cols) > 2 else "",
                    "content": "",  # akshare 只返回标题
                    "source": "eastmoney",
                    "pub_time": pub_time,
                    "url": str(row.iloc[5]) if len(cols) > 5 else "",
                    "raw_source_name": str(row.iloc[4]) if len(cols) > 4 else "",
                })
            except Exception:
                continue
        return results
    except Exception as e:
        print(f"Eastmoney fetch error for {code}: {e}", file=sys.stderr)
        return []


# ── Securities Times (证券时报) ─────────────────────────────────────────────

STCN_SEARCH_URL = "https://search.stcn.com/api/search"


def fetch_stcn_news(code: str, name: str, limit: int = 10) -> List[Dict]:
    """Fetch news from Securities Times search API."""
    try:
        keyword = f"{name} {code}" if name else code
        params = {
            "q": keyword,
            "page": 1,
            "per_page": limit,
        }
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        }
        resp = _SESSION.get(STCN_SEARCH_URL, params=params, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        results = []
        items = data.get("data", {}).get("list", []) if isinstance(data, dict) else []
        for item in items[:limit]:
            pub_time = item.get("pub_time") or item.get("pubTime") or item.get("publish_time", "")
            if pub_time and len(pub_time) == 10:  # YYYY-MM-DD
                pub_time += " 00:00:00"
            results.append({
                "code": code,
                "title": item.get("title", ""),
                "content": item.get("summary", item.get("description", "")),
                "source": "stcn",
                "pub_time": pub_time,
                "url": item.get("url", ""),
                "raw_source_name": "证券时报",
            })
        return results
    except Exception as e:
        print(f"STCN fetch error for {code}: {e}", file=sys.stderr)
        return []


# ── CLS (财联社) ────────────────────────────────────────────────────────────

CLS_SEARCH_URL = "https://www.cls.cn/searchPage"
CLS_API_URL = "https://www.cls.cn/v3/searches/home"


def fetch_cls_news(code: str, name: str, limit: int = 10) -> List[Dict]:
    """Fetch news from CLS (财联社) via their API."""
    try:
        keyword = name if name else code
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Referer": "https://www.cls.cn/",
        }
        params = {
            "keyword": keyword,
            "page": 0,
            "rn": limit,
        }
        resp = _SESSION.get(CLS_API_URL, params=params, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        results = []
        items = data.get("data", {}).get("roll_data", []) if isinstance(data, dict) else []
        for item in items[:limit]:
            ctime = item.get("ctime", 0)
            pub_time = datetime.fromtimestamp(ctime).strftime("%Y-%m-%d %H:%M:%S") if ctime else ""
            results.append({
                "code": code,
                "title": item.get("title", ""),
                "content": item.get("brief", ""),
                "source": "cls",
                "pub_time": pub_time,
                "url": f"https://www.cls.cn/detail/{item.get('id', '')}",
                "raw_source_name": "财联社",
            })
        return results
    except Exception as e:
        print(f"CLS fetch error for {code}: {e}", file=sys.stderr)
        return []


# ── Unified fetch ───────────────────────────────────────────────────────────

def fetch_stock_news(code: str, name: str = "", sources: List[str] = None, limit_per_source: int = 10) -> List[Dict]:
    """
    Fetch news for a single stock from multiple sources.
    Returns list of news dicts.
    """
    if sources is None:
        sources = ["eastmoney", "stcn", "cls"]

    all_news = []
    for source in sources:
        if source == "eastmoney":
            news = fetch_eastmoney_news(code, limit=limit_per_source)
        elif source == "stcn":
            news = fetch_stcn_news(code, name, limit=limit_per_source)
        elif source == "cls":
            news = fetch_cls_news(code, name, limit=limit_per_source)
        else:
            continue
        all_news.extend(news)
        if source != sources[-1]:
            time.sleep(0.3)  # Be polite to APIs

    # Sort by pub_time descending
    all_news.sort(key=lambda x: x.get("pub_time", ""), reverse=True)
    return all_news


# ── Batch fetch for multiple stocks ─────────────────────────────────────────

def fetch_news_batch(codes_names: List[Tuple[str, str]], sources: List[str] = None,
                     limit_per_source: int = 10, progress_interval: int = 50) -> Dict[str, List[Dict]]:
    """
    Fetch news for multiple stocks.
    codes_names: list of (code, name) tuples
    Returns dict: code -> list of news
    """
    results = {}
    total = len(codes_names)
    for i, (code, name) in enumerate(codes_names):
        news = fetch_stock_news(code, name, sources=sources, limit_per_source=limit_per_source)
        results[code] = news
        if (i + 1) % progress_interval == 0 or i == 0:
            print(f"  Fetched news for {i + 1}/{total} stocks", file=sys.stderr)
        time.sleep(0.2)  # Rate limiting
    return results


def fetch_stock_news_fast(code: str, name: str = "", limit: int = 10) -> List[Dict]:
    """Fast single-source fetch using only Eastmoney (fastest, no HTTP overhead)."""
    return fetch_eastmoney_news(code, limit=limit)


def fetch_news_concurrent(codes_names: List[Tuple[str, str]], limit: int = 10,
                          max_workers: int = 10, batch_size: int = 100) -> List[Dict]:
    """
    Concurrently fetch news for many stocks using thread pool.
    Returns flat list of news dicts (each includes 'code' key).
    Processes in batches to avoid overwhelming the API.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    all_news = []
    total = len(codes_names)

    for batch_start in range(0, total, batch_size):
        batch = codes_names[batch_start:batch_start + batch_size]
        batch_news = []

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_code = {
                executor.submit(fetch_stock_news_fast, code, name, limit): code
                for code, name in batch
            }
            for future in as_completed(future_to_code):
                code = future_to_code[future]
                try:
                    news = future.result(timeout=30)
                    for item in news:
                        item["code"] = code
                    batch_news.extend(news)
                except Exception as e:
                    print(f"  Fetch error for {code}: {e}", file=sys.stderr)

        all_news.extend(batch_news)
        processed = min(batch_start + batch_size, total)
        print(f"  Fetched {processed}/{total} stocks ({len(batch_news)} news items)", file=sys.stderr)

        # Small delay between batches to be polite
        if batch_start + batch_size < total:
            time.sleep(0.5)

    return all_news


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch stock news")
    parser.add_argument("--code", help="Single stock code")
    parser.add_argument("--name", default="", help="Stock name")
    parser.add_argument("--sources", default="eastmoney,stcn,cls", help="Comma-separated sources")
    parser.add_argument("--limit", type=int, default=10, help="Limit per source")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]

    if args.code:
        news = fetch_stock_news(args.code, args.name, sources=sources, limit_per_source=args.limit)
        result = {"code": args.code, "news_count": len(news), "news": news}
    else:
        result = {"error": "Please specify --code"}

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"News saved to: {args.output}", file=sys.stderr)
    else:
        print(result_json)


if __name__ == "__main__":
    main()
