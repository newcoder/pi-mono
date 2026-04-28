#!/usr/bin/env python3
"""
Stock news sync.
Fetches news from multiple sources, classifies them, and saves to local SQLite DB.
Supports single stock sync and batch sync for market-wide scanning.
"""
import argparse
import json
import sys
import os
import sqlite3
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from news_fetcher import fetch_stock_news
from news_classifier import classify_news_batch

DB_PATH = os.path.join(os.path.expanduser("~"), ".trading-agent", "data", "market.db")


def ensure_news_table(conn: sqlite3.Connection):
    """Create stock_news table if not exists."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            pub_time TEXT NOT NULL,
            url TEXT,
            event_type TEXT,
            sentiment TEXT,
            impact_level TEXT
        )
    """)
    # Create indexes
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_code_time ON stock_news(code, pub_time)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_event_type ON stock_news(event_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_sentiment ON stock_news(sentiment)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_pub_time ON stock_news(pub_time)")
    conn.commit()


def get_db() -> sqlite3.Connection:
    """Get SQLite connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def cleanup_old_news(conn: sqlite3.Connection, days: int = 60):
    """Delete news older than N days to keep DB lean."""
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    cur = conn.execute("DELETE FROM stock_news WHERE pub_time < ?", (cutoff,))
    return cur.rowcount


def save_news(conn: sqlite3.Connection, news_list: List[Dict]) -> int:
    """Save classified news to DB, skipping duplicates."""
    if not news_list:
        return 0

    # Build set of existing keys for fast dedup
    codes = list({item.get("code") for item in news_list if item.get("code")})
    if not codes:
        return 0

    # Query existing (code, title, pub_time) tuples for relevant codes
    placeholders = ",".join("?" * len(codes))
    existing_rows = conn.execute(
        f"SELECT code, title, pub_time FROM stock_news WHERE code IN ({placeholders})",
        tuple(codes)
    ).fetchall()
    existing_set = {(r["code"], r["title"], r["pub_time"]) for r in existing_rows}

    to_insert_keys = set()
    to_insert_items = []
    for item in news_list:
        key = (item.get("code"), item.get("title"), item.get("pub_time"))
        if key in existing_set or key in to_insert_keys:
            continue
        to_insert_keys.add(key)
        to_insert_items.append(item)

    if not to_insert_items:
        return 0

    conn.executemany(
        """INSERT INTO stock_news
           (code, title, source, pub_time, url, event_type, sentiment, impact_level)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                item.get("code"),
                item.get("title", ""),
                item.get("source", ""),
                item.get("pub_time", ""),
                item.get("url", ""),
                item.get("event_type"),
                item.get("sentiment", "neutral"),
                item.get("impact_level", "low"),
            )
            for item in to_insert_items
        ]
    )
    conn.commit()
    return len(to_insert)


def sync_stock_news(code: str, name: str = "", sources: List[str] = None,
                    limit_per_source: int = 10, conn: sqlite3.Connection = None) -> Dict:
    """
    Sync news for a single stock.
    Returns {code, fetched, saved, events}.
    """
    close_conn = False
    if conn is None:
        conn = get_db()
        close_conn = True

    try:
        ensure_news_table(conn)

        # Fetch
        news = fetch_stock_news(code, name, sources=sources, limit_per_source=limit_per_source)
        fetched = len(news)

        # Classify
        classified = classify_news_batch(news)

        # Save
        saved = save_news(conn, classified)

        # Cleanup old news (keep last 60 days)
        deleted = cleanup_old_news(conn, days=60)
        if deleted > 0:
            print(f"  Cleaned up {deleted} old news items", file=sys.stderr)

        # Summarize events
        events = {}
        for item in classified:
            et = item.get("event_type")
            if et:
                if et not in events:
                    events[et] = {"count": 0, "sentiment": item.get("sentiment"), "latest": item.get("pub_time", "")}
                events[et]["count"] += 1

        return {
            "code": code,
            "fetched": fetched,
            "saved": saved,
            "events": events,
        }
    finally:
        if close_conn:
            conn.close()


def sync_batch(codes_names: List[Tuple[str, str]], sources: List[str] = None,
               limit_per_source: int = 10, progress_interval: int = 50) -> Dict:
    """
    Batch sync news for multiple stocks using concurrent fetching.
    Returns summary statistics.
    """
    from news_fetcher import fetch_news_concurrent

    conn = get_db()
    try:
        ensure_news_table(conn)

        total_stocks = len(codes_names)
        print(f"Batch syncing news for {total_stocks} stocks (concurrent mode)...", file=sys.stderr)

        # Phase 1: Concurrent fetch (single source for speed)
        fetch_start = datetime.now()
        all_news = fetch_news_concurrent(
            codes_names,
            limit=limit_per_source,
            max_workers=15,
            batch_size=200,
        )
        fetch_elapsed = (datetime.now() - fetch_start).total_seconds()
        print(f"  Fetched {len(all_news)} news items in {fetch_elapsed:.1f}s", file=sys.stderr)

        # Phase 2: Classify all news at once
        classify_start = datetime.now()
        classified = classify_news_batch(all_news)
        classify_elapsed = (datetime.now() - classify_start).total_seconds()
        print(f"  Classified {len(classified)} items in {classify_elapsed:.1f}s", file=sys.stderr)

        # Phase 3: Batch save
        save_start = datetime.now()
        total_saved = save_news(conn, classified)
        save_elapsed = (datetime.now() - save_start).total_seconds()
        print(f"  Saved {total_saved} new items in {save_elapsed:.1f}s", file=sys.stderr)

        # Cleanup old news
        deleted = cleanup_old_news(conn, days=60)
        if deleted > 0:
            print(f"  Cleaned up {deleted} old news items", file=sys.stderr)

        return {
            "total_stocks": total_stocks,
            "total_fetched": len(all_news),
            "total_saved": total_saved,
            "fetch_time": fetch_elapsed,
            "classify_time": classify_elapsed,
            "save_time": save_elapsed,
            "sync_time": datetime.now().isoformat(),
        }
    finally:
        conn.close()


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sync stock news to local DB")
    parser.add_argument("--code", help="Single stock code")
    parser.add_argument("--name", default="", help="Stock name")
    parser.add_argument("--sources", default="eastmoney", help="Comma-separated sources")
    parser.add_argument("--limit", type=int, default=10, help="Limit per source")
    parser.add_argument("--batch", action="store_true", help="Sync all stocks in DB")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]

    if args.batch:
        # Get all stocks from DB
        conn = get_db()
        rows = conn.execute("SELECT code, name FROM stocks ORDER BY code").fetchall()
        conn.close()
        codes_names = [(r["code"], r["name"] or "") for r in rows]
        print(f"Batch syncing news for {len(codes_names)} stocks...", file=sys.stderr)
        result = sync_batch(codes_names, sources=sources, limit_per_source=args.limit)
    elif args.code:
        result = sync_stock_news(args.code, args.name, sources=sources, limit_per_source=args.limit)
    else:
        print("Error: Specify --code or --batch", file=sys.stderr)
        sys.exit(1)

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Sync result saved to: {args.output}", file=sys.stderr)
    else:
        print(result_json)


if __name__ == "__main__":
    main()
