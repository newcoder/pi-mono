#!/usr/bin/env python3
"""
概念持续性分析 - 五维评分体系
用法: python concept_persistence.py --concept "人工智能" [--days 30] [--output result.json]
输出: JSON {concept, persistence_score, grade, verdict, dimensions: {...}}
"""

import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone


# ─── Helpers ──────────────────────────────────────────────────


def _get_db_path() -> str:
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "."
    return os.path.join(home, ".trading-agent", "data", "market.db")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _days_ago(days: int) -> str:
    return (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")


def clean_nan(obj):
    if isinstance(obj, dict):
        return {k: clean_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean_nan(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
    return obj


def _parse_float(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        if math.isnan(v) or math.isinf(v):
            return 0.0
        return float(v)
    if isinstance(v, str):
        v = v.strip().replace(",", "").replace("%", "")
        if v in ("-", ""):
            return 0.0
        try:
            return float(v)
        except ValueError:
            return 0.0
    return 0.0


def _grade_from_score(score: float) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "A-"
    if score >= 70:
        return "B+"
    if score >= 60:
        return "B"
    if score >= 50:
        return "B-"
    if score >= 40:
        return "C+"
    return "C"


def _verdict_from_score(score: float) -> str:
    if score >= 90:
        return "极强持续性，具备长期主线潜力"
    if score >= 80:
        return "强持续性，可作为中期主线配置"
    if score >= 70:
        return "较强持续性，阶段性热点，可参与"
    if score >= 60:
        return "一般持续性，短期热点，注意节奏"
    if score >= 50:
        return "较弱持续性，脉冲行情，快进快出"
    if score >= 40:
        return "弱持续性，一日游风险较高"
    return "无持续性，纯概念炒作，建议回避"


# ─── Dimension Scorers ────────────────────────────────────────


def _score_policy(concept: str, days: int, db_path: str) -> dict:
    """Policy dimension: scan market_news for policy-related keywords."""
    policy_keywords = ["政策", "支持", "扶持", "补贴", "规划", "战略", "指导意见", "通知", "方案", "十四五", "十五五"]
    regulatory_keywords = ["监管", "整顿", "限制", "禁令", "规范", "风险", "警惕", "降温"]
    concept_keywords = [concept]

    policy_mentions = 0
    regulatory_mentions = 0
    support_signals = 0

    try:
        if os.path.exists(db_path):
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            since = _days_ago(days)
            cursor.execute(
                "SELECT title, content, sentiment, news_type FROM market_news WHERE pub_time >= ? ORDER BY pub_time DESC",
                (since,),
            )
            rows = cursor.fetchall()
            conn.close()

            for row in rows:
                title = str(row[0] or "")
                content = str(row[1] or "")
                text = title + " " + content

                # Check if concept mentioned
                concept_mentioned = any(kw in text for kw in concept_keywords)
                if not concept_mentioned:
                    continue

                # Count policy signals
                if any(kw in text for kw in policy_keywords):
                    policy_mentions += 1
                    if row[2] == "positive":
                        support_signals += 1

                if any(kw in text for kw in regulatory_keywords):
                    regulatory_mentions += 1
    except Exception:
        pass

    # Score: more policy mentions = higher score, but regulatory risks subtract
    raw_score = min(100, policy_mentions * 5 + support_signals * 8)
    risk_penalty = min(30, regulatory_mentions * 5)
    score = max(0, raw_score - risk_penalty)

    return {
        "score": round(score, 1),
        "details": {
            "policy_mentions": policy_mentions,
            "support_signals": support_signals,
            "regulatory_risks": regulatory_mentions,
        },
    }


def _score_news(concept: str, days: int, db_path: str) -> dict:
    """News dimension: news volume trend and sentiment ratio."""
    news_count = 0
    positive_count = 0
    negative_count = 0
    hot_spots = []

    try:
        if os.path.exists(db_path):
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            since = _days_ago(days)
            cursor.execute(
                "SELECT title, content, sentiment FROM market_news WHERE pub_time >= ? ORDER BY pub_time DESC",
                (since,),
            )
            rows = cursor.fetchall()
            conn.close()

            for row in rows:
                title = str(row[0] or "")
                content = str(row[1] or "")
                text = title + " " + content

                if concept not in text:
                    continue

                news_count += 1
                sentiment = str(row[2] or "neutral")
                if sentiment == "positive":
                    positive_count += 1
                elif sentiment == "negative":
                    negative_count += 1

            # Extract hot spots (bigram frequency)
            # Simplified: just check for common sub-topics
            sub_topics = ["大模型", "算力", "应用", "芯片", "数据", "算法", "模型", "训练", "推理"]
            for topic in sub_topics:
                if any(topic in str(row[0] or "") for row in rows if concept in str(row[0] or "")):
                    hot_spots.append(topic)
            hot_spots = hot_spots[:5]
    except Exception:
        pass

    sentiment_ratio = (positive_count / max(negative_count, 1)) if positive_count + negative_count > 0 else 1.0
    volume_score = min(100, news_count * 3)
    sentiment_score = min(100, sentiment_ratio * 30)
    score = (volume_score * 0.6 + sentiment_score * 0.4)

    return {
        "score": round(score, 1),
        "details": {
            "news_count": news_count,
            "positive_count": positive_count,
            "negative_count": negative_count,
            "sentiment_ratio": round(sentiment_ratio, 2),
            "hot_spots": hot_spots,
        },
    }


def _score_capital(codes: list, days: int, db_path: str) -> dict:
    """Capital dimension: use turnover/volume change as proxy for capital flow."""
    if not codes or not os.path.exists(db_path):
        return {"score": 50, "details": {"note": "No data"}}

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        since = _days_ago(days)

        # Get latest and previous period average turnover
        cursor.execute(
            """
            SELECT code, AVG(turnover) as avg_turnover, AVG(volume) as avg_volume
            FROM klines
            WHERE code IN ({}) AND period = 'daily' AND date >= ?
            GROUP BY code
            """.format(",".join(["?"] * len(codes))),
            codes + [since],
        )
        recent_rows = {r[0]: {"turnover": r[1] or 0, "volume": r[2] or 0} for r in cursor.fetchall()}

        prev_since = _days_ago(days * 2)
        prev_end = _days_ago(days)
        cursor.execute(
            """
            SELECT code, AVG(turnover) as avg_turnover
            FROM klines
            WHERE code IN ({}) AND period = 'daily' AND date >= ? AND date < ?
            GROUP BY code
            """.format(",".join(["?"] * len(codes))),
            codes + [prev_since, prev_end],
        )
        prev_rows = {r[0]: r[1] or 0 for r in cursor.fetchall()}
        conn.close()

        turnover_changes = []
        for code, recent in recent_rows.items():
            prev = prev_rows.get(code, 0)
            if prev > 0:
                turnover_changes.append((recent["turnover"] - prev) / prev * 100)

        avg_turnover_change = sum(turnover_changes) / len(turnover_changes) if turnover_changes else 0

        # Score: positive turnover change = higher score
        if avg_turnover_change > 50:
            score = 90
        elif avg_turnover_change > 20:
            score = 75
        elif avg_turnover_change > 0:
            score = 60
        elif avg_turnover_change > -20:
            score = 45
        else:
            score = 30

        return {
            "score": round(score, 1),
            "details": {
                "avg_turnover_change_pct": round(avg_turnover_change, 2),
                "stocks_with_data": len(recent_rows),
            },
        }
    except Exception:
        return {"score": 50, "details": {"note": "Data fetch failed"}}


def _score_technical(codes: list, days: int, db_path: str) -> dict:
    """Technical dimension: average change_pct and MA alignment."""
    if not codes or not os.path.exists(db_path):
        return {"score": 50, "details": {"note": "No data"}}

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        since = _days_ago(days)

        cursor.execute(
            """
            SELECT code, AVG(change_pct) as avg_change, COUNT(*) as cnt
            FROM klines
            WHERE code IN ({}) AND period = 'daily' AND date >= ?
            GROUP BY code
            """.format(",".join(["?"] * len(codes))),
            codes + [since],
        )
        rows = cursor.fetchall()
        conn.close()

        if not rows:
            return {"score": 50, "details": {"note": "No kline data"}}

        avg_changes = [r[1] or 0 for r in rows if r[1] is not None]
        avg_change = sum(avg_changes) / len(avg_changes) if avg_changes else 0

        # Count stocks above MA20 (proxy for trend)
        ma_aligned = sum(1 for c in avg_changes if c > 0)
        ma_alignment = "bullish" if ma_aligned > len(avg_changes) * 0.6 else "bearish" if ma_aligned < len(avg_changes) * 0.4 else "neutral"

        # Score based on average change
        if avg_change > 5:
            score = 90
        elif avg_change > 2:
            score = 75
        elif avg_change > 0:
            score = 60
        elif avg_change > -2:
            score = 45
        else:
            score = 30

        return {
            "score": round(score, 1),
            "details": {
                "avg_change_pct": round(avg_change, 2),
                "ma_alignment": ma_alignment,
                "rising_stocks": ma_aligned,
                "total_stocks": len(avg_changes),
            },
        }
    except Exception:
        return {"score": 50, "details": {"note": "Data fetch failed"}}


def _score_fundamentals(codes: list, db_path: str) -> dict:
    """Fundamentals dimension: average revenue/profit growth."""
    if not codes or not os.path.exists(db_path):
        return {"score": 50, "details": {"note": "No data"}}

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        # Get latest two report periods for each stock
        revenue_growths = []
        profit_growths = []
        roes = []

        for code in codes:
            cursor.execute(
                """
                SELECT report_date, total_revenue, parent_net_profit, eps
                FROM fundamentals
                WHERE code = ?
                ORDER BY report_date DESC
                LIMIT 2
                """,
                (code,),
            )
            rows = cursor.fetchall()
            if len(rows) >= 2:
                latest = rows[0]
                prev = rows[1]
                latest_revenue = latest[1] or 0
                prev_revenue = prev[1] or 0
                latest_profit = latest[2] or 0
                prev_profit = prev[2] or 0

                if prev_revenue > 0:
                    revenue_growths.append((latest_revenue - prev_revenue) / prev_revenue * 100)
                if prev_profit > 0:
                    profit_growths.append((latest_profit - prev_profit) / prev_profit * 100)
                if latest[3]:
                    roes.append(latest[3] * 100)  # eps as proxy

        conn.close()

        avg_revenue_growth = sum(revenue_growths) / len(revenue_growths) if revenue_growths else 0
        avg_profit_growth = sum(profit_growths) / len(profit_growths) if profit_growths else 0
        avg_roe = sum(roes) / len(roes) if roes else 0

        # Score: higher growth = higher score
        growth_score = min(100, max(0, avg_revenue_growth * 2 + 50))
        profit_score = min(100, max(0, avg_profit_growth * 2 + 50))
        score = (growth_score + profit_score) / 2

        return {
            "score": round(score, 1),
            "details": {
                "avg_revenue_growth_pct": round(avg_revenue_growth, 2),
                "avg_profit_growth_pct": round(avg_profit_growth, 2),
                "avg_eps": round(avg_roe, 2),
                "stocks_with_data": len(revenue_growths),
            },
        }
    except Exception:
        return {"score": 50, "details": {"note": "Data fetch failed"}}


# ─── Main Logic ───────────────────────────────────────────────


def analyze_concept_persistence(concept: str, days: int = 30) -> dict:
    db_path = _get_db_path()

    # Get concept stock codes
    codes = []
    try:
        if os.path.exists(db_path):
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute("SELECT code FROM concept_stocks WHERE concept = ?", (concept,))
            codes = [r[0] for r in cursor.fetchall()]
            conn.close()
    except Exception:
        pass

    # Run 5-dimension scoring
    policy = _score_policy(concept, days, db_path)
    news = _score_news(concept, days, db_path)
    capital = _score_capital(codes, days, db_path)
    technical = _score_technical(codes, days, db_path)
    fundamentals = _score_fundamentals(codes, db_path)

    # Weighted composite score
    weights = {"policy": 0.25, "news": 0.20, "capital": 0.20, "technical": 0.15, "fundamentals": 0.20}
    dimensions = {
        "policy": {**policy, "weight": weights["policy"], "weighted_score": round(policy["score"] * weights["policy"], 2)},
        "news": {**news, "weight": weights["news"], "weighted_score": round(news["score"] * weights["news"], 2)},
        "capital": {**capital, "weight": weights["capital"], "weighted_score": round(capital["score"] * weights["capital"], 2)},
        "technical": {**technical, "weight": weights["technical"], "weighted_score": round(technical["score"] * weights["technical"], 2)},
        "fundamentals": {**fundamentals, "weight": weights["fundamentals"], "weighted_score": round(fundamentals["score"] * weights["fundamentals"], 2)},
    }

    persistence_score = sum(d["weighted_score"] for d in dimensions.values())
    grade = _grade_from_score(persistence_score)
    verdict = _verdict_from_score(persistence_score)

    return clean_nan({
        "concept": concept,
        "analysis_date": _now_iso(),
        "lookback_days": days,
        "persistence_score": round(persistence_score, 1),
        "grade": grade,
        "verdict": verdict,
        "dimensions": dimensions,
        "stock_count": len(codes),
    })


def main():
    parser = argparse.ArgumentParser(description="概念持续性分析 - 五维评分体系")
    parser.add_argument("--concept", required=True, help="概念名称，如 人工智能、新能源")
    parser.add_argument("--days", type=int, default=30, help="回溯天数，默认30")
    parser.add_argument("--output", help="输出文件路径")
    args = parser.parse_args()

    result = analyze_concept_persistence(args.concept, args.days)
    output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Result saved to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
