#!/usr/bin/env python3
"""
Market-wide news fetcher.
Fetches macro/market news from a-stock-data sources:
- CLS telegraph (财联社电报)
- Eastmoney global 7x24 (东方财富全球资讯)
"""
import argparse
import json
import sys
import os
import time
from datetime import datetime
from typing import Dict, List

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_A_STOCK_DATA_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, "..", "..", "a-stock-data", "scripts"))
if _A_STOCK_DATA_DIR not in sys.path:
    sys.path.insert(0, _A_STOCK_DATA_DIR)

from news_fetcher import fetch_news


def _map_time(item: Dict) -> str:
    """Normalize a-stock-data 'time' field to pub_time format."""
    t = item.get("time", "")
    if not t:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if len(t) == 10 and t[4] == "-":
        return f"{t} 00:00:00"
    return t


def fetch_market_news(sources: List[str] = None, limit_per_source: int = 100) -> List[Dict]:
    """Fetch market-wide news from multiple sources."""
    if sources is None:
        sources = ["cls_telegraph", "eastmoney_global"]

    valid_sources = [s for s in sources if s in ("cls_telegraph", "eastmoney_global")]
    if not valid_sources:
        return []

    result = fetch_news(code="", sources=valid_sources, limit_per_source=limit_per_source)
    items = result.get("items", []) if result.get("success") else []

    news = []
    for item in items:
        news.append({
            "title": item.get("title", ""),
            "content": item.get("content", ""),
            "source": item.get("source", ""),
            "source_type": item.get("source_type", ""),
            "pub_time": _map_time(item),
            "url": item.get("url", ""),
        })

    # Sort by pub_time descending
    news.sort(key=lambda x: x.get("pub_time", ""), reverse=True)
    return news


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch market news")
    parser.add_argument("--sources", default="cls_telegraph,eastmoney_global", help="Comma-separated sources")
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
