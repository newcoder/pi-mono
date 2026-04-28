#!/usr/bin/env python3
"""
通过聚宽(jqdatasdk)同步概念股数据到本地SQLite数据库
用法: python sync_concepts_jq.py [--concept <概念名称>] [--all]
"""

import argparse
import json
import os
import sqlite3
import sys
import time

import jqdatasdk as jq

def _log(msg):
    """Log to stderr so stdout stays clean for JSON output."""
    print(msg, file=sys.stderr)

def _ensure_auth():
    if not jq.is_auth():
        jq.auth('13758103948', 'DingPanBao2021')

def _get_db_path():
    return os.path.expanduser("~/.trading-agent/data/market.db")

def _norm_to_6digit(code):
    """Convert '000001.XSHE' to '000001'"""
    return code.split('.')[0]

def _get_market_from_code(code):
    """1=SH, 0=SZ"""
    return 1 if code.startswith(('60', '68', '90')) else 0

def _save_concept_stocks(db_path, concept_name, stocks):
    """Save concept stocks to SQLite."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    now = time.strftime('%Y-%m-%dT%H:%M:%S')

    # Delete old data for this concept
    cur.execute("DELETE FROM concept_stocks WHERE concept = ?", (concept_name,))

    for stock_code in stocks:
        code_6d = _norm_to_6digit(stock_code)
        cur.execute(
            "INSERT OR REPLACE INTO concept_stocks (concept, code, name, updated_at) VALUES (?, ?, ?, ?)",
            (concept_name, code_6d, None, now)
        )

    conn.commit()
    conn.close()
    return len(stocks)

def sync_single_concept(concept_name):
    """Sync a single concept by name."""
    _ensure_auth()
    db_path = _get_db_path()

    # Search concept by name
    concepts = jq.get_concepts()
    matched = concepts[concepts['name'] == concept_name]
    if len(matched) == 0:
        # Try partial match
        matched = concepts[concepts['name'].str.contains(concept_name, na=False)]

    if len(matched) == 0:
        print(json.dumps({"error": f"Concept '{concept_name}' not found"}, ensure_ascii=False))
        return 0

    concept_code = matched.index[0]
    actual_name = matched.iloc[0]['name']

    stocks = jq.get_concept_stocks(concept_code)
    count = _save_concept_stocks(db_path, actual_name, stocks)
    print(json.dumps({"concept": actual_name, "count": count}, ensure_ascii=False))
    return count

def sync_all_concepts():
    """Sync all concepts from JoinQuant."""
    _ensure_auth()
    db_path = _get_db_path()

    concepts = jq.get_concepts()
    total = len(concepts)
    _log(f"[sync_concepts_jq] Total concepts: {total}")

    total_stocks = 0
    for idx, (concept_code, row) in enumerate(concepts.iterrows()):
        name = row['name']
        try:
            stocks = jq.get_concept_stocks(concept_code)
            count = _save_concept_stocks(db_path, name, stocks)
            total_stocks += count
            if (idx + 1) % 50 == 0:
                _log(f"[sync_concepts_jq] Progress: {idx + 1}/{total} concepts, {total_stocks} stocks synced")
            # Small delay to avoid rate limiting
            time.sleep(0.1)
        except Exception as e:
            _log(f"[sync_concepts_jq] Failed to sync {name} ({concept_code}): {e}")

    _log(f"[sync_concepts_jq] Done. {total} concepts, {total_stocks} stocks synced.")
    result = {"total_concepts": total, "total_stocks": total_stocks}
    print(json.dumps(result, ensure_ascii=False))
    return total_stocks

def main():
    parser = argparse.ArgumentParser(description="Sync concept stocks from JoinQuant")
    parser.add_argument("--concept", type=str, help="Sync single concept by name")
    parser.add_argument("--all", action="store_true", help="Sync all concepts")
    args = parser.parse_args()

    if args.all:
        sync_all_concepts()
    elif args.concept:
        sync_single_concept(args.concept)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
