#!/usr/bin/env python3
"""
Build combined theme constituent pool for backtesting.
- Base pool: concept_stocks (static membership, broad coverage)
- Dynamic weight: hot_stocks reason mentions (recency-boosted time signal)
Usage: python build_theme_pool.py [--lookback 20] [--target-date 2026-07-03]
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import argparse
import sqlite3
from datetime import datetime
from typing import Dict, List, Set

from local_data.db import get_db

# Import from sibling scripts
from classify_themes import CONCEPT_MERGE_MAP


def ensure_tables(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS theme_constituents (
            theme TEXT NOT NULL,
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            name TEXT,
            base_weight REAL DEFAULT 1.0,
            hot_mentions INTEGER DEFAULT 0,
            final_weight REAL DEFAULT 1.0,
            snapshot_date TEXT NOT NULL,
            updated_at TEXT,
            PRIMARY KEY (theme, code, snapshot_date)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_theme_constituents_theme ON theme_constituents(theme, snapshot_date)")
    conn.commit()


def get_trading_dates(conn: sqlite3.Connection, target_date: str, lookback: int) -> List[str]:
    rows = conn.execute(
        "SELECT DISTINCT date FROM hot_stocks WHERE date <= ? ORDER BY date DESC LIMIT ?",
        (target_date, lookback),
    ).fetchall()
    return [r[0] for r in rows]


def get_concept_stocks(conn: sqlite3.Connection, theme: str, children: List[str]) -> Dict[str, dict]:
    """Get union of stocks from concept_stocks for a theme and its child concepts."""
    all_concepts = [theme] + children
    stocks = {}
    for concept in all_concepts:
        rows = conn.execute(
            "SELECT cs.code, s.name, CASE WHEN cs.code LIKE '6%' OR cs.code LIKE '9%' THEN 1 ELSE 0 END as market "
            "FROM concept_stocks cs JOIN stocks s ON cs.code = s.code WHERE cs.concept = ?",
            (concept,),
        ).fetchall()
        for code, name, market in rows:
            if code not in stocks:
                stocks[code] = {"code": code, "name": name, "market": market}
    return stocks


def count_hot_mentions(conn: sqlite3.Connection, codes: Set[str], keywords: List[str], dates: List[str]) -> Dict[str, int]:
    """Count hot_stocks reason mentions for each stock within the date window."""
    mentions = {c: 0 for c in codes}
    date_placeholders = ",".join("?" for _ in dates)
    for kw in keywords:
        rows = conn.execute(
            f"SELECT code, COUNT(*) as cnt FROM hot_stocks WHERE date IN ({date_placeholders}) AND reason LIKE ? GROUP BY code",
            [*dates, f"%{kw}%"],
        ).fetchall()
        for code, cnt in rows:
            if code in mentions:
                mentions[code] += cnt
    return mentions


def build_pool(
    conn: sqlite3.Connection,
    target_date: str,
    lookback: int = 20,
    base_weight: float = 1.0,
    boost_per_mention: float = 0.5,
) -> dict:
    """Build theme constituent pool for a target date."""
    ensure_tables(conn)
    dates = get_trading_dates(conn, target_date, lookback)
    now = datetime.now().isoformat()

    total_stocks = 0
    theme_counts = {}

    for theme, children in CONCEPT_MERGE_MAP.items():
        # Step 1: Get base pool from concept_stocks
        base_stocks = get_concept_stocks(conn, theme, children)
        if len(base_stocks) < 5:
            continue

        # Step 2: Count hot_stocks mentions for keywords
        keywords = [theme] + children
        codes = set(base_stocks.keys())
        hot_mentions = count_hot_mentions(conn, codes, keywords, dates)

        # Step 3: Compute final weights and save
        rows = []
        for code, info in base_stocks.items():
            mentions = hot_mentions.get(code, 0)
            final_w = base_weight + boost_per_mention * mentions
            rows.append((
                theme, code, info["market"], info["name"],
                base_weight, mentions, round(final_w, 2),
                target_date, now,
            ))

        if rows:
            conn.executemany(
                """INSERT OR REPLACE INTO theme_constituents
                   (theme, code, market, name, base_weight, hot_mentions, final_weight, snapshot_date, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                rows,
            )
            conn.commit()
            theme_counts[theme] = len(rows)
            total_stocks += len(rows)

    return {
        "target_date": target_date,
        "lookback_days": lookback,
        "themes": len(theme_counts),
        "total_stocks": total_stocks,
        "theme_counts": theme_counts,
    }


def main():
    parser = argparse.ArgumentParser(description="Build theme constituent pool")
    parser.add_argument("--lookback", type=int, default=20, help="Trading days for hot_stocks lookback")
    parser.add_argument("--target-date", help="Target date YYYY-MM-DD (default: latest hot_stocks date)")
    parser.add_argument("--boost", type=float, default=0.5, help="Weight boost per hot_stocks mention")
    args = parser.parse_args()

    conn = get_db()
    try:
        if not args.target_date:
            row = conn.execute("SELECT MAX(date) FROM hot_stocks").fetchone()
            target_date = row[0] if row else datetime.now().strftime("%Y-%m-%d")
        else:
            target_date = args.target_date

        result = build_pool(conn, target_date, lookback=args.lookback, boost_per_mention=args.boost)
        print(f"Built pool for {target_date}: {result['themes']} themes, {result['total_stocks']} total stocks")
        for theme, cnt in sorted(result["theme_counts"].items(), key=lambda x: -x[1])[:10]:
            print(f"  {theme}: {cnt} stocks")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
