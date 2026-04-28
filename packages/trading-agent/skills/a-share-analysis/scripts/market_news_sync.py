#!/usr/bin/env python3
"""
Market news sync.
Fetches market-wide news, classifies them, and saves to local SQLite DB.
"""
import argparse
import json
import sys
import os
import sqlite3
from datetime import datetime, timedelta
from typing import Dict, List

from market_news_fetcher import fetch_market_news
from market_news_classifier import classify_market_news_batch

DB_PATH = os.path.join(os.path.expanduser("~"), ".trading-agent", "data", "market.db")


def ensure_market_news_table(conn: sqlite3.Connection):
    """Create market_news table if not exists."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS market_news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            pub_time TEXT,
            url TEXT,
            news_type TEXT,
            sentiment TEXT,
            impact_scope TEXT,
            affected_sectors TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mnews_type ON market_news(news_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mnews_sentiment ON market_news(sentiment)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mnews_time ON market_news(pub_time)")
    conn.commit()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def cleanup_old_market_news(conn: sqlite3.Connection, days: int = 60):
    """Delete market news older than N days to keep DB lean."""
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    cur = conn.execute("DELETE FROM market_news WHERE pub_time < ?", (cutoff,))
    return cur.rowcount


def save_market_news(conn: sqlite3.Connection, news_list: List[Dict]) -> int:
    """Save classified market news to DB, skipping duplicates."""
    if not news_list:
        return 0

    saved = 0
    for item in news_list:
        # Deduplicate by title + source
        existing = conn.execute(
            "SELECT id FROM market_news WHERE title = ? AND source = ?",
            (item.get("title"), item.get("source"))
        ).fetchone()
        if existing:
            continue

        affected = item.get("affected_sectors", {})
        conn.execute(
            """INSERT INTO market_news
               (title, source, pub_time, url, news_type, sentiment, impact_scope, affected_sectors)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                item.get("title", ""),
                item.get("source", ""),
                item.get("pub_time", ""),
                item.get("url", ""),
                item.get("news_type"),
                item.get("sentiment", "neutral"),
                item.get("impact_scope", "mixed"),
                json.dumps(affected, ensure_ascii=False),
            )
        )
        saved += 1

    conn.commit()
    return saved


def sync_market_news(sources: List[str] = None, limit: int = 100) -> Dict:
    """Sync market news to DB."""
    conn = get_db()
    try:
        ensure_market_news_table(conn)

        news = fetch_market_news(sources=sources, limit_per_source=limit)
        fetched = len(news)

        classified = classify_market_news_batch(news)
        saved = save_market_news(conn, classified)

        # Cleanup old news (keep last 60 days)
        deleted = cleanup_old_market_news(conn, days=60)
        if deleted > 0:
            print(f"  Cleaned up {deleted} old market news items", file=sys.stderr)

        # Stats
        type_stats = {}
        for item in classified:
            nt = item.get("news_type", "其他")
            if nt not in type_stats:
                type_stats[nt] = {"count": 0, "positive": 0, "negative": 0, "neutral": 0}
            type_stats[nt]["count"] += 1
            type_stats[nt][item.get("sentiment", "neutral")] += 1

        return {
            "fetched": fetched,
            "saved": saved,
            "type_stats": type_stats,
            "sync_time": datetime.now().isoformat(),
        }
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Sync market news to DB")
    parser.add_argument("--sources", default="cls", help="Comma-separated sources")
    parser.add_argument("--limit", type=int, default=100, help="Limit per source")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    result = sync_market_news(sources=sources, limit=args.limit)

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Sync result saved to: {args.output}", file=sys.stderr)
    else:
        print(result_json)


if __name__ == "__main__":
    main()
