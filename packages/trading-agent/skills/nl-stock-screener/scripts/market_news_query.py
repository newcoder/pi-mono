#!/usr/bin/env python3
"""
Market news query tool.
Queries market_news table for macro news analysis.
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


def query_market_news(
    news_types: List[str] = None,
    sentiment: str = None,
    impact_scope: str = None,
    days: int = 7,
    limit: int = 50
) -> Dict:
    """Query market news with filters."""
    conn = get_db()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

        where_clauses = ["(pub_time >= ? OR pub_time IS NULL)"]
        params = [cutoff]

        if news_types:
            placeholders = ",".join(["?"] * len(news_types))
            where_clauses.append(f"news_type IN ({placeholders})")
            params.extend(news_types)

        if sentiment:
            where_clauses.append("sentiment = ?")
            params.append(sentiment)

        if impact_scope:
            where_clauses.append("impact_scope = ?")
            params.append(impact_scope)

        where_sql = " AND ".join(where_clauses)

        rows = conn.execute(
            f"SELECT * FROM market_news WHERE {where_sql} ORDER BY pub_time DESC, id DESC LIMIT ?",
            params + [limit]
        ).fetchall()

        news_list = []
        for row in rows:
            affected = {}
            if row["affected_sectors"]:
                try:
                    affected = json.loads(row["affected_sectors"])
                except:
                    pass

            news_list.append({
                "title": row["title"],
                "source": row["source"],
                "pub_time": row["pub_time"],
                "url": row["url"],
                "news_type": row["news_type"],
                "sentiment": row["sentiment"],
                "impact_scope": row["impact_scope"],
                "affected_sectors": affected,
            })

        return {
            "query_time": datetime.now().isoformat(),
            "parameters": {
                "news_types": news_types,
                "sentiment": sentiment,
                "impact_scope": impact_scope,
                "days": days,
            },
            "total": len(news_list),
            "news": news_list,
        }
    finally:
        conn.close()


def get_market_news_stats(days: int = 7) -> Dict:
    """Get market news statistics."""
    conn = get_db()
    try:
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

        # Type distribution
        type_rows = conn.execute(
            "SELECT news_type, sentiment, COUNT(*) as count FROM market_news WHERE pub_time >= ? GROUP BY news_type, sentiment",
            (cutoff,)
        ).fetchall()

        types = {}
        for row in type_rows:
            nt = row["news_type"] or "其他"
            if nt not in types:
                types[nt] = {"total": 0, "positive": 0, "negative": 0, "neutral": 0}
            types[nt]["total"] += row["count"]
            if row["sentiment"] == "positive":
                types[nt]["positive"] += row["count"]
            elif row["sentiment"] == "negative":
                types[nt]["negative"] += row["count"]
            else:
                types[nt]["neutral"] += row["count"]

        # Sector impact summary
        sector_rows = conn.execute(
            "SELECT affected_sectors FROM market_news WHERE pub_time >= ? AND affected_sectors IS NOT NULL",
            (cutoff,)
        ).fetchall()

        benefit_sectors = {}
        harm_sectors = {}
        for row in sector_rows:
            try:
                affected = json.loads(row["affected_sectors"])
                for s in affected.get("benefit", []):
                    benefit_sectors[s] = benefit_sectors.get(s, 0) + 1
                for s in affected.get("harm", []):
                    harm_sectors[s] = harm_sectors.get(s, 0) + 1
            except:
                pass

        return {
            "days": days,
            "type_distribution": types,
            "top_benefit_sectors": sorted(benefit_sectors.items(), key=lambda x: x[1], reverse=True)[:10],
            "top_harm_sectors": sorted(harm_sectors.items(), key=lambda x: x[1], reverse=True)[:10],
        }
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Market news query")
    subparsers = parser.add_subparsers(dest="command", help="Command")

    query_parser = subparsers.add_parser("query", help="Query market news")
    query_parser.add_argument("--news-types", help="Comma-separated news types")
    query_parser.add_argument("--sentiment", choices=["positive", "negative", "neutral"])
    query_parser.add_argument("--impact-scope", choices=["market_wide", "sector_specific", "mixed"])
    query_parser.add_argument("--days", type=int, default=7)
    query_parser.add_argument("--limit", type=int, default=50)
    query_parser.add_argument("--output", help="Output JSON file")

    stats_parser = subparsers.add_parser("stats", help="Get market news stats")
    stats_parser.add_argument("--days", type=int, default=7)
    stats_parser.add_argument("--output", help="Output JSON file")

    args = parser.parse_args()

    if args.command == "query":
        news_types = [t.strip() for t in args.news_types.split(",")] if args.news_types else None
        result = query_market_news(
            news_types=news_types,
            sentiment=args.sentiment,
            impact_scope=args.impact_scope,
            days=args.days,
            limit=args.limit,
        )
    elif args.command == "stats":
        result = get_market_news_stats(days=args.days)
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
