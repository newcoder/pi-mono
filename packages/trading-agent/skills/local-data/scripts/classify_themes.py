#!/usr/bin/env python3
"""
Auto-classify market themes from hot_stocks reasons.
Reads hot stock selection reasons → extracts concept mentions →
auto-merges related sub-concepts → assigns 主线/支线/细分 levels.
Usage: python classify_themes.py [--lookback-days 5] [--min-primary 15] [--min-secondary 5]
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import argparse
import sqlite3
import re
from local_data.db import get_db
from datetime import datetime, timedelta
from collections import Counter
from typing import Dict, List, Optional, Tuple

# ── Parent → children concept merging map ──────────────────────────
# When a concept appears as a child, its mentions are rolled up to the parent.
# Concepts in the same parent group that are NOT listed as children are
# auto-assigned as children if they co-occur with the parent in reasons.
CONCEPT_MERGE_MAP: Dict[str, List[str]] = {
    "人形机器人": ["机器人", "机器人概念", "灵巧手", "减速器", "电子皮肤", "具身智能",
                   "间接持股宇树科技", "铝挤压模具", "谐波减速器", "滚珠丝杠"],
    "半导体": ["半导体设备", "先进封装", "光纤概念", "存储芯片", "半导体封测",
               "半导体硅片", "功率半导体", "半导体材料", "半导体洁净室", "半导体封装",
               "高纯四氯化硅", "覆铜板", "PCB", "PCB概念", "第三代半导体",
               "相控阵T/R芯片"],
    "商业航天": ["卫星互联网", "航天装备", "火箭发动机"],
    "AI基础设施": ["液冷服务器", "算力租赁", "算力合同", "智算中心", "数据中心"],
    "低空经济": ["无人机", "飞行汽车", "通航"],
    "新能源": ["风电", "钙钛矿设备", "光伏", "锂电池", "固态电池", "钠离子电池",
               "盐湖提锂参股", "盐湖提锂", "BC电池", "充电桩"],
    "创新药": ["阿尔茨海默病", "CRO", "生物医药", "化学制药", "中药", "医药"],
    "有色金属": ["铜", "稀土永磁", "稀土", "铝", "钴", "锡", "锌", "镍", "钼", "钨", "锑", "白银"],
    "黄金": ["黄金概念", "贵金属"],
    "消费电子": ["AI手机", "AI PC", "MR", "3D打印", "智能穿戴", "折叠屏"],
    "国企改革": ["央企改革", "国企"],
}

# ── Noise filter ───────────────────────────────────────────────────
# Terms that appear in hot stock reasons but don't represent tradeable themes.
NOISE_PATTERNS = [
    r"^摘帽$", r"摘帽", r"^复牌$", r"^回购$", r"回购注销", r"^定增",
    r"^控制权", r"^实控人", r"^增持$", r"^减持$", r"^ST", r"ST板块",
    r"^业绩", r"扭亏", r"减亏", r"^预重整$", r"^重整$", r"^保壳",
    r"^股权转让$", r"^资产", r"^董事长", r"^分红$", r"^面值",
    r"^已申请", r"^追偿", r"^物业", r"^葡萄酒$", r"^林业",
    r"^央企$", r"^国资$", r"^深圳国资$", r"^中山国资$",
    r"^福建国资$", r"^成都国资$", r"^杭州国资$", r"^海南国资$",
    r"^超跌反弹$", r"^重大资产", r"^对外投资$", r"^铝业转型",
    r"^儿童", r"^智能驾培", r"^城市运营",
    r"^一季报", r"^年报", r"^半年报", r"^三季报", r"^业绩预告", r"^业绩快报",
    r"^退市", r"^暂停上市", r"^撤销",
    r"^庭外重组", r"^协议转让", r"国资$", r"^举牌",
    r"^预盈", r"^预亏", r"^高管", r"^股东", r"^索赔",
    r"^被立案", r"^证监会", r"^监管函", r"^问询函",
]


def is_noise(term: str) -> bool:
    for pat in NOISE_PATTERNS:
        if re.search(pat, term):
            return True
    return False


def ensure_tables(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS theme_classification (
            theme TEXT NOT NULL,
            parent_theme TEXT,
            level TEXT NOT NULL,
            mentions INTEGER,
            sub_concepts TEXT,
            snapshot_date TEXT NOT NULL,
            updated_at TEXT,
            PRIMARY KEY (theme, snapshot_date)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_theme_classification_level
        ON theme_classification(level, snapshot_date)
    """)
    conn.commit()


def get_trading_dates(conn: sqlite3.Connection, lookback_days: int, target_date: Optional[str] = None) -> List[str]:
    """Get the last N distinct trading dates from hot_stocks, up to target_date."""
    if target_date:
        rows = conn.execute(
            "SELECT DISTINCT date FROM hot_stocks WHERE date <= ? ORDER BY date DESC LIMIT ?",
            (target_date, lookback_days),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT DISTINCT date FROM hot_stocks ORDER BY date DESC LIMIT ?",
            (lookback_days,),
        ).fetchall()
    return [r[0] for r in rows]


def parse_concepts(conn: sqlite3.Connection, dates: List[str]) -> Counter:
    """Parse concept mentions from hot_stocks reasons for given dates."""
    placeholders = ",".join("?" for _ in dates)
    rows = conn.execute(
        f"SELECT date, code, reason FROM hot_stocks WHERE date IN ({placeholders})",
        dates,
    ).fetchall()

    concepts = Counter()
    for date, code, reason in rows:
        if not reason:
            continue
        for p in reason.split("+"):
            term = p.strip()
            if term and not is_noise(term):
                concepts[term] += 1
    return concepts


def merge_concepts(concepts: Counter) -> Tuple[Dict[str, dict], Counter]:
    """Merge sub-concepts into parent themes using CONCEPT_MERGE_MAP.
    Returns: (theme_map, unmerged_counter)
      theme_map: {parent_theme: {mentions: N, sub_concepts: [child1, child2, ...]}}
      unmerged: remaining concepts not assigned to any parent
    """
    # Build a reverse lookup: child → parent
    child_to_parent = {}
    for parent, children in CONCEPT_MERGE_MAP.items():
        for child in children:
            child_to_parent[child] = parent

    theme_map: Dict[str, dict] = {}
    assigned = set()

    # First pass: assign parent concepts themselves
    for parent in CONCEPT_MERGE_MAP:
        if parent in concepts:
            theme_map[parent] = {
                "mentions": concepts[parent],
                "sub_concepts": [],
                "is_parent_direct": True,
            }
            assigned.add(parent)

    # Second pass: roll up children into parents
    for concept, cnt in concepts.items():
        if concept in assigned:
            continue
        parent = child_to_parent.get(concept)
        if parent:
            if parent not in theme_map:
                theme_map[parent] = {"mentions": 0, "sub_concepts": [], "is_parent_direct": False}
            theme_map[parent]["mentions"] += cnt
            theme_map[parent]["sub_concepts"].append(f"{concept}({cnt})")
            assigned.add(concept)

    # Remaining unassigned concepts
    unmerged = Counter()
    for concept, cnt in concepts.items():
        if concept not in assigned:
            unmerged[concept] = cnt

    return theme_map, unmerged


def classify_levels(
    theme_map: Dict[str, dict],
    unmerged: Counter,
    min_primary: int = 15,
    min_secondary: int = 5,
) -> List[dict]:
    """Assign 主线/支线/细分 levels."""
    results = []

    # Classify merged themes
    for theme, info in sorted(theme_map.items(), key=lambda x: -x[1]["mentions"]):
        mentions = info["mentions"]
        if mentions >= min_primary:
            level = "primary"
        elif mentions >= min_secondary:
            level = "secondary"
        else:
            level = "niche"

        results.append({
            "theme": theme,
            "parent_theme": None,
            "level": level,
            "mentions": mentions,
            "sub_concepts": ", ".join(info["sub_concepts"]) if info["sub_concepts"] else None,
        })

    # Classify unmerged concepts as niche (no parent theme)
    for concept, cnt in unmerged.most_common():
        if cnt >= min_secondary:
            level = "secondary"
        elif cnt >= 2:
            level = "niche"
        else:
            continue  # skip single-mention concepts

        results.append({
            "theme": concept,
            "parent_theme": None,
            "level": level,
            "mentions": cnt,
            "sub_concepts": None,
        })

    results.sort(key=lambda x: (-x["mentions"], x["theme"]))
    return results


def save_results(conn: sqlite3.Connection, results: List[dict], snapshot_date: str) -> int:
    now = datetime.now().isoformat()
    conn.execute("DELETE FROM theme_classification WHERE snapshot_date = ?", (snapshot_date,))
    rows = []
    for r in results:
        rows.append((
            r["theme"], r["parent_theme"], r["level"], r["mentions"],
            r["sub_concepts"], snapshot_date, now,
        ))
    conn.executemany(
        """INSERT INTO theme_classification (theme, parent_theme, level, mentions, sub_concepts, snapshot_date, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    conn.commit()
    return len(rows)


def run_classification(
    conn: sqlite3.Connection,
    lookback_days: int = 5,
    min_primary: int = 15,
    min_secondary: int = 5,
    target_date: Optional[str] = None,
) -> dict:
    ensure_tables(conn)

    dates = get_trading_dates(conn, lookback_days, target_date)
    if not dates:
        return {"error": "no hot_stocks data"}

    snapshot_date = max(dates)
    print(f"Trading dates: {dates} (snapshot: {snapshot_date})")

    concepts = parse_concepts(conn, dates)
    print(f"Parsed {len(concepts)} unique concepts from {sum(concepts.values())} total mentions")

    theme_map, unmerged = merge_concepts(concepts)
    results = classify_levels(theme_map, unmerged, min_primary, min_secondary)

    n = save_results(conn, results, snapshot_date)

    # Print summary
    primary = [r for r in results if r["level"] == "primary"]
    secondary = [r for r in results if r["level"] == "secondary"]
    niche = [r for r in results if r["level"] == "niche"]

    print(f"\n=== Theme Classification ({snapshot_date}) ===")
    print(f"  主线 (primary): {len(primary)}")
    for r in primary:
        subs = f"  ← {r['sub_concepts']}" if r["sub_concepts"] else ""
        print(f"    {r['theme']} ({r['mentions']}x){subs}")

    print(f"  支线 (secondary): {len(secondary)}")
    for r in secondary:
        subs = f"  ← {r['sub_concepts']}" if r["sub_concepts"] else ""
        print(f"    {r['theme']} ({r['mentions']}x){subs}")

    print(f"  细分 (niche): {len(niche)} (not shown)")

    return {
        "snapshot_date": snapshot_date,
        "trading_dates": len(dates),
        "total_concepts": len(concepts),
        "primary": len(primary),
        "secondary": len(secondary),
        "niche": len(niche),
        "saved_rows": n,
    }


def main():
    parser = argparse.ArgumentParser(description="Classify market themes from hot stock reasons")
    parser.add_argument("--lookback-days", type=int, default=5, help="Trading days to look back")
    parser.add_argument("--target-date", help="Base date for lookback (YYYY-MM-DD). Default: today")
    parser.add_argument("--min-primary", type=int, default=15)
    parser.add_argument("--min-secondary", type=int, default=5)
    args = parser.parse_args()

    conn = get_db()
    try:
        result = run_classification(conn, args.lookback_days, args.min_primary, args.min_secondary, args.target_date)
        print(f"\nDone: {result}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
