#!/usr/bin/env python3
"""
通过聚宽(jqdatasdk)同步多级多标准行业分类数据到本地SQLite数据库
支持标准: sw_l1, sw_l2, sw_l3, zjw, jq_l1, jq_l2
用法: python sync_industries_jq.py [--standard sw_l1] [--all]
"""

import argparse
import json
import os
import sqlite3
import sys
import time

import jqdatasdk as jq

def _log(msg):
    print(msg, file=sys.stderr)

def _ensure_auth():
    if not jq.is_auth():
        jq.auth('13758103948', 'DingPanBao2021')

def _get_db_path():
    return os.path.expanduser("~/.trading-agent/data/market.db")

def _norm_to_6digit(code):
    return code.split('.')[0]

def _get_market_from_code(code):
    return 1 if code.startswith(('60', '68', '90')) else 0

# Map standard name to level
STANDARD_LEVELS = {
    'sw_l1': 1,
    'sw_l2': 2,
    'sw_l3': 3,
    'zjw': None,
    'jq_l1': 1,
    'jq_l2': 2,
}

def _build_sw_parent_map(all_industries):
    """Build sw_l1->sw_l2 and sw_l2->sw_l3 parent mappings by scanning stock data."""
    _log("[sync_industries_jq] Building SW parent relationships...")
    all_stocks = jq.get_all_securities(types=['stock'], date=None)
    stock_codes = list(all_stocks.index)

    today = time.strftime('%Y-%m-%d')
    industries = jq.get_industry(security=stock_codes, date=today)

    l1_to_l2 = {}
    l2_to_l3 = {}

    for code, info in industries.items():
        sw_l1 = info.get('sw_l1')
        sw_l2 = info.get('sw_l2')
        sw_l3 = info.get('sw_l3')

        if sw_l1 and sw_l2:
            l1_code = sw_l1['industry_code']
            l2_code = sw_l2['industry_code']
            if l2_code not in l1_to_l2:
                l1_to_l2[l2_code] = l1_code

        if sw_l2 and sw_l3:
            l2_code = sw_l2['industry_code']
            l3_code = sw_l3['industry_code']
            if l3_code not in l2_to_l3:
                l2_to_l3[l3_code] = l2_code

    return l1_to_l2, l2_to_l3

def sync_standard(standard, db_path, now):
    """Sync a single industry standard."""
    _log(f"[sync_industries_jq] Syncing standard: {standard}...")

    # 1. Get industry definitions
    industries_df = jq.get_industries(name=standard)
    level = STANDARD_LEVELS.get(standard)

    industry_rows = []
    for industry_code, row in industries_df.iterrows():
        start_date = None
        if 'start_date' in row and row['start_date'] is not None:
            start_date = str(row['start_date'])[:10]
        industry_rows.append({
            'industry_code': str(industry_code),
            'name': row['name'],
            'standard': standard,
            'level': level,
            'parent_code': None,
            'start_date': start_date,
            'updated_at': now,
        })

    # 2. Get all stocks and their industry classification
    all_stocks = jq.get_all_securities(types=['stock'], date=None)
    stock_codes = list(all_stocks.index)

    today = time.strftime('%Y-%m-%d')
    industries = jq.get_industry(security=stock_codes, date=today)

    stock_industry_rows = []
    default_industry_map = {}  # code -> sw_l1 name for stocks.industry update

    for code, info in industries.items():
        code_6d = _norm_to_6digit(code)
        market = _get_market_from_code(code_6d)

        ind_info = info.get(standard)
        if ind_info:
            stock_industry_rows.append({
                'code': code_6d,
                'market': market,
                'industry_code': ind_info['industry_code'],
                'standard': standard,
                'updated_at': now,
            })

        # Also capture sw_l1 for stocks.industry default
        if standard == 'sw_l1':
            sw_l1_info = info.get('sw_l1')
            if sw_l1_info:
                default_industry_map[code_6d] = sw_l1_info['industry_name']

    # 3. Write to SQLite
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Save industry definitions
    for item in industry_rows:
        cur.execute(
            """INSERT OR REPLACE INTO industries
               (industry_code, name, standard, level, parent_code, start_date, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (item['industry_code'], item['name'], item['standard'], item['level'],
             item['parent_code'], item['start_date'], item['updated_at'])
        )

    # Save stock-industry mappings
    for item in stock_industry_rows:
        cur.execute(
            """INSERT OR REPLACE INTO stock_industries
               (code, market, industry_code, standard, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (item['code'], item['market'], item['industry_code'], item['standard'], item['updated_at'])
        )

    # Update stocks.industry default (sw_l1)
    if standard == 'sw_l1':
        for code_6d, name in default_industry_map.items():
            market = _get_market_from_code(code_6d)
            cur.execute(
                "UPDATE stocks SET industry = ?, updated_at = ? WHERE code = ? AND market = ?",
                (name, now, code_6d, market)
            )

    conn.commit()

    # Count
    cur.execute("SELECT COUNT(*) FROM industries WHERE standard = ?", (standard,))
    industry_count = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM stock_industries WHERE standard = ?", (standard,))
    mapping_count = cur.fetchone()[0]

    conn.close()

    result = {
        'standard': standard,
        'industries': industry_count,
        'mappings': mapping_count,
    }
    _log(f"[sync_industries_jq] {standard}: {industry_count} industries, {mapping_count} mappings")
    return result

def sync_all_standards():
    """Sync all industry standards."""
    _ensure_auth()
    db_path = _get_db_path()
    now = time.strftime('%Y-%m-%dT%H:%M:%S')

    standards = ['sw_l1', 'sw_l2', 'sw_l3', 'zjw', 'jq_l1', 'jq_l2']
    results = []

    for standard in standards:
        try:
            result = sync_standard(standard, db_path, now)
            results.append(result)
        except Exception as e:
            _log(f"[sync_industries_jq] Failed to sync {standard}: {e}")
            results.append({'standard': standard, 'error': str(e)})

    # Build and apply SW parent relationships
    try:
        l1_to_l2, l2_to_l3 = _build_sw_parent_map(results)
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        for l2_code, l1_code in l1_to_l2.items():
            cur.execute(
                "UPDATE industries SET parent_code = ? WHERE industry_code = ? AND standard = 'sw_l2'",
                (l1_code, l2_code)
            )
        for l3_code, l2_code in l2_to_l3.items():
            cur.execute(
                "UPDATE industries SET parent_code = ? WHERE industry_code = ? AND standard = 'sw_l3'",
                (l2_code, l3_code)
            )
        conn.commit()
        conn.close()
        _log(f"[sync_industries_jq] Linked {len(l1_to_l2)} sw_l2 and {len(l2_to_l3)} sw_l3 parents")
    except Exception as e:
        _log(f"[sync_industries_jq] Failed to build parent relationships: {e}")

    output = {
        'results': results,
        'total_standards': len(standards),
    }
    print(json.dumps(output, ensure_ascii=False))
    return output

def main():
    parser = argparse.ArgumentParser(description="Sync industry classifications from JoinQuant")
    parser.add_argument("--standard", type=str, help="Sync single standard: sw_l1/sw_l2/sw_l3/zjw/jq_l1/jq_l2")
    parser.add_argument("--all", action="store_true", help="Sync all standards")
    args = parser.parse_args()

    if args.standard:
        _ensure_auth()
        db_path = _get_db_path()
        now = time.strftime('%Y-%m-%dT%H:%M:%S')
        result = sync_standard(args.standard, db_path, now)
        print(json.dumps(result, ensure_ascii=False))
    else:
        sync_all_standards()

if __name__ == "__main__":
    main()
