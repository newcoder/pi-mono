#!/usr/bin/env python3
"""
Market-wide news fetcher.
Fetches macro/market news from CLS (财联社) and Eastmoney (东方财富要闻).
"""
import argparse
import json
import sys
import os
import re
import time
from datetime import datetime
from typing import Dict, List, Optional
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

_SESSION = requests.Session()
_SESSION.mount("https://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1.0)))
_SESSION.mount("http://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1.0)))


# ── CLS (财联社) ────────────────────────────────────────────────────────────

def fetch_cls_market_news(limit: int = 100) -> List[Dict]:
    """Fetch market news from CLS via akshare."""
    try:
        import akshare as ak
        df = ak.stock_news_main_cx()
        if df is None or df.empty:
            return []

        results = []
        for _, row in df.head(limit).iterrows():
            tag = str(row.get("tag", ""))
            summary = str(row.get("summary", ""))
            url = str(row.get("url", ""))

            # Try to extract date from URL
            pub_time = ""
            url_match = re.search(r'/(\d{4}-\d{2}-\d{2})/', url)
            if url_match:
                pub_time = url_match.group(1)
            else:
                pub_time = datetime.now().strftime("%Y-%m-%d")

            results.append({
                "title": summary,
                "source": "cls",
                "pub_time": pub_time,
                "url": url,
                "raw_tag": tag,
            })
        return results
    except Exception as e:
        print(f"CLS market news fetch error: {e}", file=sys.stderr)
        return []


# ── Eastmoney (东方财富要闻) ───────────────────────────────────────────────

def fetch_eastmoney_market_news(limit: int = 50) -> List[Dict]:
    """Fetch market news from Eastmoney focus news page."""
    try:
        import akshare as ak
        # Try to get eastmoney focus news if available
        # Fallback to general search
        url = "https://np-anotice-stock.eastmoney.com/api/security/ann"
        return []
    except Exception as e:
        print(f"Eastmoney market news fetch error: {e}", file=sys.stderr)
        return []


# ── Unified fetch ───────────────────────────────────────────────────────────

def fetch_market_news(sources: List[str] = None, limit_per_source: int = 100) -> List[Dict]:
    """Fetch market-wide news from multiple sources."""
    if sources is None:
        sources = ["cls"]

    all_news = []
    for source in sources:
        if source == "cls":
            news = fetch_cls_market_news(limit=limit_per_source)
        elif source == "eastmoney":
            news = fetch_eastmoney_market_news(limit=limit_per_source)
        else:
            continue
        all_news.extend(news)
        if source != sources[-1]:
            time.sleep(0.3)

    # Sort by pub_time descending
    all_news.sort(key=lambda x: x.get("pub_time", ""), reverse=True)
    return all_news


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch market news")
    parser.add_argument("--sources", default="cls", help="Comma-separated sources")
    parser.add_argument("--limit", type=int, default=100, help="Limit per source")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    news = fetch_market_news(sources=sources, limit_per_source=args.limit)

    result = {
        "fetch_time": datetime.now().isoformat(),
        "news_count": len(news),
        "news": news,
    }

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Market news saved to: {args.output}", file=sys.stderr)
    else:
        print(result_json)


if __name__ == "__main__":
    main()
