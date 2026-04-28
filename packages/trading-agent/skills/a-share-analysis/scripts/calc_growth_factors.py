#!/usr/bin/env python3
"""
计算并保存年度财务增长率因子到本地 SQLite。
支持: 营收增长率(rev_growth)、归母净利润增长率(profit_growth)。
用法: python calc_growth_factors.py [--year 2025] [--top 10] [--save]
"""

import argparse
import json
import os
import sqlite3
import sys
import time


def _get_db_path():
    return os.path.expanduser("~/.trading-agent/data/market.db")


def _log(msg):
    print(msg, file=sys.stderr)


def calc_growth_factors(year: int, save: bool = False):
    """Calculate YoY revenue and profit growth for the given fiscal year."""
    db_path = _get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    prev_year = year - 1

    _log(f"[calc_growth_factors] Calculating {year} annual report growth vs {prev_year}...")

    # Ensure factors table exists
    if save:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS growth_factors (
                code TEXT NOT NULL,
                market INTEGER NOT NULL,
                year INTEGER NOT NULL,
                rev_prev REAL,
                rev_curr REAL,
                rev_growth_pct REAL,
                profit_prev REAL,
                profit_curr REAL,
                profit_growth_pct REAL,
                updated_at TEXT,
                PRIMARY KEY (code, market, year)
            )
        """)
        conn.commit()

    sql = """
    WITH prev AS (
        SELECT code, market, total_revenue, parent_net_profit
        FROM fundamentals
        WHERE report_date = ? AND report_type = '年报'
          AND total_revenue IS NOT NULL AND total_revenue > 0
          AND parent_net_profit IS NOT NULL
    ),
    curr AS (
        SELECT code, market, total_revenue, parent_net_profit
        FROM fundamentals
        WHERE report_date = ? AND report_type = '年报'
          AND total_revenue IS NOT NULL AND total_revenue > 0
          AND parent_net_profit IS NOT NULL
    )
    SELECT
        c.code,
        c.market,
        s.name,
        p.total_revenue AS rev_prev,
        c.total_revenue AS rev_curr,
        ROUND((c.total_revenue - p.total_revenue) / p.total_revenue * 100, 2) AS rev_growth_pct,
        p.parent_net_profit AS profit_prev,
        c.parent_net_profit AS profit_curr,
        ROUND((c.parent_net_profit - p.parent_net_profit) / ABS(p.parent_net_profit) * 100, 2) AS profit_growth_pct
    FROM curr c
    JOIN prev p ON c.code = p.code AND c.market = p.market
    LEFT JOIN stocks s ON c.code = s.code AND c.market = s.market
    WHERE c.total_revenue > p.total_revenue
      AND c.parent_net_profit > p.parent_net_profit
      AND p.parent_net_profit != 0
      AND p.total_revenue >= 100000000
    ORDER BY rev_growth_pct DESC
    """

    cur.execute(sql, (f"{prev_year}-12-31", f"{year}-12-31"))
    rows = cur.fetchall()

    results = []
    for r in rows:
        results.append({
            "code": r["code"],
            "market": r["market"],
            "name": r["name"] or r["code"],
            "rev_prev": r["rev_prev"],
            "rev_curr": r["rev_curr"],
            "rev_growth_pct": r["rev_growth_pct"],
            "profit_prev": r["profit_prev"],
            "profit_curr": r["profit_curr"],
            "profit_growth_pct": r["profit_growth_pct"],
        })

    if save:
        now = time.strftime('%Y-%m-%dT%H:%M:%S')
        saved = 0
        for item in results:
            cur.execute("""
                INSERT OR REPLACE INTO growth_factors
                (code, market, year, rev_prev, rev_curr, rev_growth_pct,
                 profit_prev, profit_curr, profit_growth_pct, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                item["code"], item["market"], year,
                item["rev_prev"], item["rev_curr"], item["rev_growth_pct"],
                item["profit_prev"], item["profit_curr"], item["profit_growth_pct"],
                now
            ))
            saved += 1
        conn.commit()
        _log(f"[calc_growth_factors] Saved {saved} growth factor rows to DB.")

    conn.close()
    return results


def main():
    parser = argparse.ArgumentParser(description="Calculate annual financial growth factors")
    parser.add_argument("--year", type=int, default=2025, help="Fiscal year to compare (default: 2025)")
    parser.add_argument("--top", type=int, default=10, help="Return top N results (default: 10)")
    parser.add_argument("--save", action="store_true", help="Save factors to growth_factors table")
    args = parser.parse_args()

    results = calc_growth_factors(args.year, save=args.save)

    output = {
        "year": args.year,
        "total_matched": len(results),
        "top_results": results[:args.top],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
