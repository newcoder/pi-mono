#!/usr/bin/env python3
"""
同花顺热点强势股获取 — 当日强势股 + 题材归因 reason tags

Moved from a-stock-data/scripts/get_hot_stocks.py into local-data to remove
cross-skill runtime dependency. Output JSON is consumed by daily_sync.py.
"""
import argparse
import json
import os
import sys
import time

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import requests

from local_data.market import market_prefix


def _fetch_tencent_quotes(codes):
    """批量拉取腾讯财经实时行情"""
    prefixed = []
    for c in codes:
        prefix = market_prefix(c, "lower")
        if prefix:
            prefixed.append(prefix)
        else:
            prefixed.append(f"sz{c}")

    url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
    resp.encoding = "gbk"
    data = resp.text

    result = {}
    for line in data.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        code = key[2:]
        result[code] = {
            "name": vals[1],
            "price": float(vals[3]) if vals[3] else 0,
            "change_pct": float(vals[32]) if vals[32] else 0,
            "turnover_pct": float(vals[38]) if vals[38] else 0,
            "amount_wan": float(vals[37]) if vals[37] else 0,
            "pe_ttm": float(vals[39]) if vals[39] else 0,
            "pb": float(vals[46]) if vals[46] else 0,
            "mcap_yi": float(vals[44]) if vals[44] else 0,
        }
    return result


def fetch_hot_stocks(date: str = None):
    """获取同花顺热点强势股 + 腾讯行情"""
    from datetime import date as _date
    t0 = time.time()

    if date is None:
        date = _date.today().strftime("%Y-%m-%d")

    # Step 1: THS 热点数据
    url = (
        f"http://zx.10jqka.com.cn/event/api/getharden/"
        f"date/{date}/orderby/date/orderway/desc/charset/GBK/"
    )
    r = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36"},
        timeout=10,
    )
    # Force GBK encoding — the server may claim UTF-8 but send GBK
    r.encoding = "gbk"
    data = r.json()

    if data.get("errocode", 0) != 0:
        raise RuntimeError(f"THS error: {data.get('errormsg', '')}")

    rows = data.get("data") or []
    if not rows:
        return {"count": 0, "date": date, "rows": [], "latency_ms": round((time.time() - t0) * 1000, 1)}

    # Step 2: 腾讯行情补充
    codes = [row["code"] for row in rows if row.get("code")]
    quotes = _fetch_tencent_quotes(codes)

    # Step 3: 合并
    merged = []
    for row in rows:
        code = row.get("code", "")
        q = quotes.get(code, {})
        merged.append({
            "code": code,
            "name": row.get("name", ""),
            "reason": row.get("reason", ""),
            "date": row.get("date", ""),
            "market": row.get("market", 0),
            "price": q.get("price", 0),
            "change_pct": q.get("change_pct", 0),
            "turnover_pct": q.get("turnover_pct", 0),
            "amount_wan": q.get("amount_wan", 0),
            "pe_ttm": q.get("pe_ttm", 0),
            "pb": q.get("pb", 0),
            "mcap_yi": q.get("mcap_yi", 0),
        })

    # Sort by date desc, then change_pct desc
    merged.sort(key=lambda r: (r.get("date", ""), r.get("change_pct", 0)), reverse=True)

    latency = round((time.time() - t0) * 1000, 1)
    return {"count": len(merged), "date": date, "rows": merged, "latency_ms": latency}


def main():
    parser = argparse.ArgumentParser(description="获取同花顺热点强势股")
    parser.add_argument("--date", help="日期 YYYY-MM-DD，默认今天")
    parser.add_argument("--limit", type=int, default=0, help="限制返回条数，0=不限")
    args = parser.parse_args()

    try:
        result = fetch_hot_stocks(date=args.date)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    rows = result["rows"]
    if args.limit > 0:
        rows = rows[:args.limit]
        result["count"] = len(rows)
        result["rows"] = rows

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
