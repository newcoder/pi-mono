#!/usr/bin/env python3
"""
News-based stock screening.
Queries stock_news table to find stocks with specific news events.
Supports time-window filtering and event-type filtering.
"""
import argparse
import json
import os
import sqlite3
from datetime import datetime, timedelta
from typing import Dict, List, Optional

DB_PATH = os.path.join(os.path.expanduser("~"), ".trading-agent", "data", "market.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def query_stocks_by_news(
    event_types: List[str] = None,
    sentiment: str = None,
    impact_level: str = None,
    days: int = 7,
    scope: str = "all",
    limit: int = 100
) -> Dict:
    """
    Query stocks by news events.

    Args:
        event_types: List of event types (e.g., ["减持", "定增"])
        sentiment: "positive", "negative", or None for both
        impact_level: "high", "medium", "low", or None for all
        days: Time window in days
        scope: "all", "hs300", "zz500", etc.
        limit: Max results
    """
    conn = get_db()
    try:
        # Calculate cutoff date
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

        # Build query
        where_clauses = ["n.pub_time >= ?"]
        params = [cutoff]

        if event_types:
            placeholders = ",".join(["?"] * len(event_types))
            where_clauses.append(f"n.event_type IN ({placeholders})")
            params.extend(event_types)

        if sentiment:
            where_clauses.append("n.sentiment = ?")
            params.append(sentiment)

        if impact_level:
            where_clauses.append("n.impact_level = ?")
            params.append(impact_level)

        where_sql = " AND ".join(where_clauses)

        # Main query: group by stock, count events, get latest news
        query = f"""
            SELECT
                n.code,
                s.name,
                COUNT(*) as event_count,
                GROUP_CONCAT(DISTINCT n.event_type) as event_types,
                MAX(n.pub_time) as latest_time,
                (SELECT title FROM stock_news n2
                 WHERE n2.code = n.code AND n2.pub_time >= ?
                 ORDER BY n2.pub_time DESC LIMIT 1) as latest_title
            FROM stock_news n
            LEFT JOIN stocks s ON s.code = n.code
            WHERE {where_sql}
            GROUP BY n.code
            ORDER BY event_count DESC, latest_time DESC
            LIMIT ?
        """
        params.insert(0, cutoff)  # For the subquery
        params.append(limit)

        rows = conn.execute(query, params).fetchall()

        results = []
        for row in rows:
            results.append({
                "code": row["code"],
                "name": row["name"] or "",
                "event_count": row["event_count"],
                "event_types": row["event_types"],
                "latest_time": row["latest_time"],
                "latest_title": row["latest_title"],
            })

        return {
            "query_time": datetime.now().isoformat(),
            "parameters": {
                "event_types": event_types,
                "sentiment": sentiment,
                "impact_level": impact_level,
                "days": days,
                "scope": scope,
            },
            "total": len(results),
            "results": results,
        }
    finally:
        conn.close()


def get_stock_news_detail(code: str, days: int = 7, event_types: List[str] = None) -> Dict:
    """Get detailed news for a specific stock."""
    conn = get_db()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

        where_clauses = ["code = ?", "pub_time >= ?"]
        params = [code, cutoff]

        if event_types:
            placeholders = ",".join(["?"] * len(event_types))
            where_clauses.append(f"event_type IN ({placeholders})")
            params.extend(event_types)

        where_sql = " AND ".join(where_clauses)

        rows = conn.execute(
            f"SELECT * FROM stock_news WHERE {where_sql} ORDER BY pub_time DESC",
            params
        ).fetchall()

        news_list = []
        for row in rows:
            news_list.append({
                "title": row["title"],
                "source": row["source"],
                "pub_time": row["pub_time"],
                "event_type": row["event_type"],
                "sentiment": row["sentiment"],
                "impact_level": row["impact_level"],
                "url": row["url"],
            })

        return {
            "code": code,
            "days": days,
            "total": len(news_list),
            "news": news_list,
        }
    finally:
        conn.close()


def get_news_statistics(days: int = 7) -> Dict:
    """Get news statistics for the market."""
    conn = get_db()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

        # Event type distribution
        event_rows = conn.execute(
            """SELECT event_type, sentiment, COUNT(*) as count
               FROM stock_news
               WHERE pub_time >= ? AND event_type IS NOT NULL
               GROUP BY event_type, sentiment
               ORDER BY count DESC""",
            (cutoff,)
        ).fetchall()

        events = {}
        for row in event_rows:
            et = row["event_type"]
            if et not in events:
                events[et] = {"total": 0, "negative": 0, "positive": 0}
            events[et]["total"] += row["count"]
            if row["sentiment"] == "negative":
                events[et]["negative"] += row["count"]
            elif row["sentiment"] == "positive":
                events[et]["positive"] += row["count"]

        # Total counts
        total_row = conn.execute(
            "SELECT COUNT(*) as total FROM stock_news WHERE pub_time >= ?",
            (cutoff,)
        ).fetchone()

        return {
            "days": days,
            "total_news": total_row["total"],
            "event_distribution": events,
        }
    finally:
        conn.close()


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="News-based stock screening")
    subparsers = parser.add_subparsers(dest="command", help="Command")

    # screen command
    screen_parser = subparsers.add_parser("screen", help="Screen stocks by news")
    screen_parser.add_argument("--event-types", help="Comma-separated event types")
    screen_parser.add_argument("--sentiment", choices=["positive", "negative"])
    screen_parser.add_argument("--impact", choices=["high", "medium", "low"])
    screen_parser.add_argument("--days", type=int, default=7, help="Time window in days")
    screen_parser.add_argument("--limit", type=int, default=100)
    screen_parser.add_argument("--output", help="Output JSON file")

    # detail command
    detail_parser = subparsers.add_parser("detail", help="Get news detail for a stock")
    detail_parser.add_argument("--code", required=True)
    detail_parser.add_argument("--days", type=int, default=7)
    detail_parser.add_argument("--event-types", help="Comma-separated event types")
    detail_parser.add_argument("--output", help="Output JSON file")

    # stats command
    stats_parser = subparsers.add_parser("stats", help="Get news statistics")
    stats_parser.add_argument("--days", type=int, default=7)
    stats_parser.add_argument("--output", help="Output JSON file")

    args = parser.parse_args()

    if args.command == "screen":
        event_types = [t.strip() for t in args.event_types.split(",")] if args.event_types else None
        result = query_stocks_by_news(
            event_types=event_types,
            sentiment=args.sentiment,
            impact_level=args.impact,
            days=args.days,
            limit=args.limit,
        )
    elif args.command == "detail":
        event_types = [t.strip() for t in args.event_types.split(",")] if args.event_types else None
        result = get_stock_news_detail(args.code, days=args.days, event_types=event_types)
    elif args.command == "stats":
        result = get_news_statistics(days=args.days)
    else:
        parser.print_help()
        return

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Result saved to: {args.output}")
    else:
        print(result_json)


if __name__ == "__main__":
    main()
