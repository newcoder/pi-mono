#!/usr/bin/env python3
"""
Build dynamic stock pool from top industry momentum leaders.
Leader selection: composite score = market_cap + stock_momentum + hot_popularity.
Usage: python build_momentum_pool.py [--top-industries 3] [--min-score 0.3] [--period-days 20]
"""
import os, sys
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path: sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path: sys.path.insert(0, _SKILL_ROOT)

import argparse, sqlite3, math
from datetime import datetime
from collections import defaultdict

from local_data.db import get_db

def load_quotes_map(conn):
    """Load latest quote data keyed by code."""
    rows = conn.execute("""
        SELECT q.code, q.total_cap
        FROM quotes q
        WHERE q.snapshot_date = (SELECT MAX(snapshot_date) FROM quotes)
    """).fetchall()
    return {r[0]: r[1] for r in rows if r[1]}

def load_hot_mentions(conn, lookback_days=20):
    """Load hot_stocks mention counts per code over recent trading days."""
    dates = conn.execute(
        "SELECT DISTINCT date FROM hot_stocks ORDER BY date DESC LIMIT ?",
        (lookback_days,)
    ).fetchall()
    if not dates: return {}
    ph = ",".join("?" for _ in dates)
    rows = conn.execute(
        f"SELECT code, COUNT(*) as cnt FROM hot_stocks WHERE date IN ({ph}) GROUP BY code",
        [d[0] for d in dates],
    ).fetchall()
    return {r[0]: r[1] for r in rows}

def load_stock_momentum(conn, lookback_days=20):
    """Load recent price momentum per stock from klines."""
    end_date = conn.execute("SELECT MAX(date) FROM klines WHERE period='daily'").fetchone()[0]
    start_date = conn.execute(
        "SELECT DISTINCT date FROM klines WHERE date <= ? AND period='daily' ORDER BY date DESC LIMIT ? OFFSET 0",
        (end_date, lookback_days + 1),
    ).fetchall()
    if len(start_date) < 2: return {}
    sd = start_date[-1][0]
    rows = conn.execute("""
        SELECT code, (MAX(close) - MIN(close)) / NULLIF(MIN(close),0) * 100 as mom
        FROM klines WHERE period='daily' AND date >= ? AND date <= ? AND close IS NOT NULL
        GROUP BY code
    """, (sd, end_date)).fetchall()
    return {r[0]: r[1] for r in rows if r[1] is not None}

def composite_score(market_cap, stock_mom, hot_cnt):
    """Composite leader score: market cap + momentum + hot popularity."""
    s = 0
    if market_cap and market_cap > 0:
        s += min(math.log10(market_cap) / 12, 1.0) * 0.4  # cap weight 40%
    if stock_mom and stock_mom != 0:
        s += min(abs(stock_mom) / 50, 1.0) * 0.3  # momentum weight 30%
    if hot_cnt and hot_cnt > 0:
        s += min(math.log10(hot_cnt + 1) / 2, 1.0) * 0.3  # hot weight 30%
    return round(s, 4)

def build_pool(conn, top_industries=3, min_score=0.2, period_days=20, lookback=20):
    """Build dynamic leader pool from top industry momentum."""

    # Pre-load static data
    cap_map = load_quotes_map(conn)
    hot_map = load_hot_mentions(conn, lookback)
    mom_map = load_stock_momentum(conn, lookback)

    print(f"Quotes: {len(cap_map)}, Hot mentions: {sum(hot_map.values())}, Stock momentum: {len(mom_map)}")

    # Load industry momentum rankings
    rankings = conn.execute("""
        SELECT date, code as industry_code, momentum_rank
        FROM industry_indicators
        WHERE period_days = ? AND momentum_rank IS NOT NULL AND momentum_rank <= ?
        ORDER BY date, momentum_rank
    """, (period_days, top_industries)).fetchall()

    if not rankings:
        return {"error": "no industry momentum data"}

    # Group by date
    by_date = defaultdict(list)
    for date, ind_code, rank in rankings:
        by_date[date].append(ind_code)

    dates = sorted(by_date.keys())
    print(f"Processing {len(dates)} dates ({dates[0]} ~ {dates[-1]})")

    pool_name = f"行业动量龙头_Top{top_industries}"

    # Create pool
    now = datetime.now().isoformat()
    conn.execute("DELETE FROM dynamic_pool_items WHERE pool_id IN (SELECT id FROM stock_pools WHERE name=?)", (pool_name,))
    conn.execute("DELETE FROM stock_pools WHERE name=?", (pool_name,))
    cur = conn.execute(
        "INSERT INTO stock_pools (name, description, is_dynamic, created_at, updated_at) VALUES (?,?,1,?,?)",
        (pool_name, f"行业{period_days}日动量Top{top_industries}，综合评分选龙头(min={min_score})", now, now)
    )
    pool_id = cur.lastrowid

    for di, date in enumerate(dates):
        if (di + 1) % 100 == 0:
            print(f"  [{di+1}/{len(dates)}] {date}")

        stocks = {}  # code -> (market, name, score)
        for ind_code in by_date[date]:
            rows = conn.execute("""
                SELECT si.code, si.market, s.name
                FROM stock_industries si
                JOIN stocks s ON si.code = s.code
                WHERE si.industry_code = ?
            """, (ind_code,)).fetchall()

            for code, market, name in rows:
                cap = cap_map.get(code)
                mom = mom_map.get(code)
                hot = hot_map.get(code, 0)
                score = composite_score(cap, mom, hot)
                if score >= min_score:
                    if code not in stocks or score > stocks[code][2]:
                        stocks[code] = (market, name, score)

        for code, (market, name, score) in stocks.items():
            conn.execute(
                "INSERT INTO dynamic_pool_items (pool_id, date, code, market, name) VALUES (?,?,?,?,?)",
                (pool_id, date, code, market, name)
            )

    conn.commit()
    cnt = conn.execute("SELECT COUNT(*), COUNT(DISTINCT date), AVG(cnt) FROM (SELECT date, COUNT(*) as cnt FROM dynamic_pool_items WHERE pool_id=? GROUP BY date)", (pool_id,)).fetchone()
    print(f"Pool {pool_id} ({pool_name}): {cnt[0]} rows, {cnt[1]} dates, avg {cnt[2]:.0f} stocks/day")
    return {"pool_id": pool_id, "name": pool_name, "rows": cnt[0], "dates": cnt[1], "avg_stocks": round(cnt[2])}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--top-industries", type=int, default=3)
    parser.add_argument("--min-score", type=float, default=0.2)
    parser.add_argument("--period-days", type=int, default=20)
    parser.add_argument("--lookback", type=int, default=20)
    args = parser.parse_args()

    conn = get_db()
    try:
        result = build_pool(conn, args.top_industries, args.min_score, args.period_days, args.lookback)
        print(result)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
