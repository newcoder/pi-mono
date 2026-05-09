#!/usr/bin/env python3
"""
概念股精选 - 基于主营收入占比验证概念股真伪
用法: python concept_stock_picker.py --concept "人工智能" [--min-revenue-ratio 30] [--output result.json]
输出: JSON {concept, total_stocks, real_concept_stocks, stocks: [{code, name, is_real, total_matching_ratio, matching_segments}]}
"""

import argparse
import json
import math
import os
import sqlite3
import sys
from pathlib import Path

# ─── Helpers ──────────────────────────────────────────────────


def _get_script_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _load_concept_mapping() -> dict:
    map_path = os.path.join(_get_script_dir(), "concept_business_map.json")
    if os.path.exists(map_path):
        with open(map_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("mappings", {})
    return {}


def _get_db_path() -> str:
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "."
    return os.path.join(home, ".trading-agent", "data", "market.db")


def _fetch_concept_stocks_from_db(concept: str, db_path: str) -> list:
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT code, name FROM concept_stocks WHERE concept = ? ORDER BY code",
        (concept,),
    )
    rows = cursor.fetchall()
    conn.close()
    return [{"code": r[0], "name": r[1] or ""} for r in rows]


def _fetch_concept_stocks_from_api(concept: str) -> list:
    """Fallback: use existing get_concept_stocks.py via Eastmoney API"""
    script_path = os.path.join(_get_script_dir(), "..", "..", "a-share-analysis", "scripts", "get_concept_stocks.py")
    if not os.path.exists(script_path):
        return []
    import subprocess
    try:
        result = subprocess.run(
            [sys.executable, script_path, concept],
            capture_output=True,
            text=True,
            timeout=30,
        )
        data = json.loads(result.stdout)
        return data.get("stocks", [])
    except Exception:
        return []


def _is_product_classification(cell_value) -> bool:
    """Detect '按产品分类' by checking Unicode ord values of first few chars."""
    if not isinstance(cell_value, str):
        return False
    s = cell_value.strip()
    if len(s) < 4:
        return False
    # 按 = 25353, 产 = 20135, 品 = 21697
    return s.startswith("按产品")


def _parse_number(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        if math.isnan(v) or math.isinf(v):
            return 0.0
        return float(v)
    if isinstance(v, str):
        v = v.strip().replace(",", "").replace("%", "")
        if v == "-" or v == "":
            return 0.0
        try:
            return float(v)
        except ValueError:
            return 0.0
    return 0.0


def _match_segment_to_concept(segment_name: str, concept: str, mapping: dict) -> bool:
    """Check if a business segment name matches the concept keywords."""
    if not segment_name:
        return False
    segment_lower = segment_name.lower()
    entry = mapping.get(concept, {})
    keywords = entry.get("keywords", []) if isinstance(entry, dict) else []
    # Fallback: use concept name itself as keyword if not in mapping
    if not keywords:
        keywords = [concept]
    for kw in keywords:
        if kw.lower() in segment_lower:
            return True
    return False


def _fetch_business_composition(code: str) -> list:
    """Fetch business composition from akshare stock_zygc_em."""
    try:
        import akshare as ak
    except ImportError:
        return []

    # Determine exchange prefix
    prefix = "SH" if code.startswith("6") else "SZ"
    symbol = f"{prefix}{code}"

    try:
        df = ak.stock_zygc_em(symbol=symbol)
    except Exception:
        return []

    if df is None or df.empty:
        return []

    # Filter to latest report period only (column 1 is report_date)
    report_dates = df.iloc[:, 1].dropna().unique()
    if len(report_dates) == 0:
        return []
    latest_date = sorted(report_dates)[-1]

    results = []
    for _, row in df.iterrows():
        # Access by position due to encoding issues with column names
        row_date = str(row.iloc[1]) if len(row) > 1 else ""
        if row_date != str(latest_date):
            continue

        classify_type = str(row.iloc[2]) if len(row) > 2 else ""
        if not _is_product_classification(classify_type):
            continue

        item_name = str(row.iloc[3]) if len(row) > 3 else ""
        # akshare returns revenue_ratio as decimal (0-1), convert to percentage
        revenue_ratio = _parse_number(row.iloc[5]) * 100 if len(row) > 5 else 0.0
        revenue = _parse_number(row.iloc[4]) if len(row) > 4 else 0.0
        profit = _parse_number(row.iloc[8]) if len(row) > 8 else 0.0
        profit_ratio = _parse_number(row.iloc[9]) * 100 if len(row) > 9 else 0.0
        gross_margin = _parse_number(row.iloc[10]) * 100 if len(row) > 10 else 0.0

        results.append({
            "item_name": item_name,
            "revenue": revenue,
            "revenue_ratio": revenue_ratio,
            "profit": profit,
            "profit_ratio": profit_ratio,
            "gross_margin": gross_margin,
        })

    return results


def _save_to_db(code: str, compositions: list, db_path: str) -> None:
    """Save business composition to local SQLite cache."""
    if not compositions or not os.path.exists(db_path):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        now = _now_iso()
        for comp in compositions:
            cursor.execute(
                """
                INSERT OR REPLACE INTO business_composition
                (code, report_date, classify_type, item_name, revenue, revenue_ratio, profit, profit_ratio, gross_margin, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    code,
                    now[:10],  # use current date as report_date proxy
                    "按产品分类",
                    comp["item_name"],
                    comp["revenue"] if comp["revenue"] else None,
                    comp["revenue_ratio"] if comp["revenue_ratio"] else None,
                    comp["profit"] if comp["profit"] else None,
                    comp["profit_ratio"] if comp["profit_ratio"] else None,
                    comp["gross_margin"] if comp["gross_margin"] else None,
                    now,
                ),
            )
        conn.commit()
        conn.close()
    except Exception:
        pass


def _load_from_db(code: str, db_path: str) -> list:
    """Load business composition from local SQLite cache."""
    if not os.path.exists(db_path):
        return []
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT item_name, revenue, revenue_ratio, profit, profit_ratio, gross_margin
            FROM business_composition
            WHERE code = ? AND classify_type = '按产品分类'
            ORDER BY report_date DESC
            LIMIT 1
            """,
            (code,),
        )
        # Check if we have data for this code
        cursor.execute(
            "SELECT COUNT(*) FROM business_composition WHERE code = ?",
            (code,),
        )
        count = cursor.fetchone()[0]
        if count == 0:
            conn.close()
            return []

        cursor.execute(
            """
            SELECT item_name, revenue, revenue_ratio, profit, profit_ratio, gross_margin
            FROM business_composition
            WHERE code = ? AND classify_type = '按产品分类'
            AND report_date = (SELECT MAX(report_date) FROM business_composition WHERE code = ?)
            ORDER BY item_name
            """,
            (code, code),
        )
        rows = cursor.fetchall()
        conn.close()
        return [
            {
                "item_name": r[0],
                "revenue": r[1] or 0.0,
                "revenue_ratio": r[2] or 0.0,
                "profit": r[3] or 0.0,
                "profit_ratio": r[4] or 0.0,
                "gross_margin": r[5] or 0.0,
            }
            for r in rows
        ]
    except Exception:
        return []


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_nan(obj):
    if isinstance(obj, dict):
        return {k: clean_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean_nan(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
    return obj


# ─── Main Logic ───────────────────────────────────────────────


def verify_concept_stocks(concept: str, min_revenue_ratio: float = 30.0, use_cache: bool = True) -> dict:
    mapping = _load_concept_mapping()
    db_path = _get_db_path()

    # 1. Get concept stocks
    stocks = _fetch_concept_stocks_from_db(concept, db_path)
    if not stocks:
        stocks = _fetch_concept_stocks_from_api(concept)
    if not stocks:
        return clean_nan({
            "concept": concept,
            "min_revenue_ratio": min_revenue_ratio,
            "total_stocks": 0,
            "real_concept_stocks": 0,
            "fake_concept_stocks": 0,
            "stocks": [],
            "error": "No stocks found for this concept",
            "fetch_time": _now_iso(),
        })

    # 2. Analyze each stock
    results = []
    for stock in stocks:
        code = stock.get("code", "")
        name = stock.get("name", "")

        # Try cache first
        compositions = []
        if use_cache:
            compositions = _load_from_db(code, db_path)

        # Fetch from API if no cache
        if not compositions:
            compositions = _fetch_business_composition(code)
            if compositions:
                _save_to_db(code, compositions, db_path)

        # Match segments to concept
        matching_segments = []
        total_matching_ratio = 0.0
        for comp in compositions:
            if _match_segment_to_concept(comp["item_name"], concept, mapping):
                matching_segments.append({
                    "segment": comp["item_name"],
                    "revenue_ratio": comp["revenue_ratio"],
                    "revenue": comp["revenue"],
                })
                total_matching_ratio += comp["revenue_ratio"]

        is_real = total_matching_ratio >= min_revenue_ratio

        results.append({
            "code": code,
            "name": name,
            "is_real": is_real,
            "total_matching_ratio": round(total_matching_ratio, 2),
            "matching_segments": matching_segments,
            "verification_method": "keyword_match",
            "data_source": "cache" if use_cache and _load_from_db(code, db_path) else "akshare",
        })

    # Sort: real first, then by matching ratio desc
    results.sort(key=lambda x: (-int(x["is_real"]), -x["total_matching_ratio"]))

    real_count = sum(1 for r in results if r["is_real"])

    return clean_nan({
        "concept": concept,
        "min_revenue_ratio": min_revenue_ratio,
        "total_stocks": len(results),
        "real_concept_stocks": real_count,
        "fake_concept_stocks": len(results) - real_count,
        "stocks": results,
        "fetch_time": _now_iso(),
    })


def main():
    parser = argparse.ArgumentParser(description="概念股精选 - 基于主营收入占比验证")
    parser.add_argument("--concept", required=True, help="概念名称，如 人工智能、新能源")
    parser.add_argument("--min-revenue-ratio", type=float, default=30.0, help="最低主营收入占比(%%)，默认30")
    parser.add_argument("--use-cache", action="store_true", default=True, help="使用本地缓存")
    parser.add_argument("--no-cache", action="store_true", help="不使用本地缓存")
    parser.add_argument("--output", help="输出文件路径")
    args = parser.parse_args()

    use_cache = not args.no_cache
    result = verify_concept_stocks(args.concept, args.min_revenue_ratio, use_cache)

    output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Result saved to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
