#!/usr/bin/env python3
"""
Stock news classifier.
Classifies news into event types and sentiment based on keyword matching.
"""
import argparse
import json
import re
from typing import Dict, List, Optional, Tuple

# ── Event type definitions ──────────────────────────────────────────────────

# Negative events (利空)
NEGATIVE_PATTERNS = [
    # 减持
    {"event_type": "减持", "keywords": ["减持", "拟减持", "大宗交易减持", "减持计划", "减持股份", "控股股东减持", "高管减持", "股东减持"], "impact": "high"},
    # 定增
    {"event_type": "定增", "keywords": ["定增", "定向增发", "非公开发行", "增发股份", "募集资金"], "impact": "medium"},
    # 业绩亏损/预亏
    {"event_type": "业绩预亏", "keywords": ["预亏", "业绩预亏", "净利润预亏", "亏损预警"], "impact": "high"},
    {"event_type": "业绩亏损", "keywords": ["业绩亏损", "净利润亏损", "经营亏损", "亏损扩大", "由盈转亏"], "impact": "high"},
    {"event_type": "业绩下滑", "keywords": ["业绩下滑", "净利润下降", "营收下降", "业绩下降", "业绩预降", "净利润预降"], "impact": "medium"},
    # 解禁
    {"event_type": "解禁", "keywords": ["解禁", "限售股解禁", "解禁上市", "解禁股份", "解禁期"], "impact": "medium"},
    # 监管/处罚
    {"event_type": "监管处罚", "keywords": ["立案调查", "行政处罚", "监管函", "警示函", "违规", "ST", "退市风险", "*ST"], "impact": "high"},
    # 质押风险
    {"event_type": "质押风险", "keywords": ["质押", "股权质押", "质押率", "平仓风险", "质押违约"], "impact": "medium"},
    # 诉讼/仲裁
    {"event_type": "诉讼仲裁", "keywords": ["诉讼", "仲裁", "重大诉讼", "被起诉", "索赔"], "impact": "medium"},
]

# Positive events (利多)
POSITIVE_PATTERNS = [
    # 增持
    {"event_type": "增持", "keywords": ["增持", "拟增持", "增持计划", "控股股东增持", "高管增持", "股东增持"], "impact": "high"},
    # 业绩预增/增长
    {"event_type": "业绩预增", "keywords": ["预增", "业绩预增", "净利润预增", "大幅预增"], "impact": "high"},
    {"event_type": "业绩增长", "keywords": ["业绩增长", "净利润增长", "营收增长", "业绩大增", "净利润大增", "扭亏为盈"], "impact": "high"},
    # 回购
    {"event_type": "回购", "keywords": ["回购", "股份回购", "拟回购", "回购股份", "注销股份"], "impact": "medium"},
    # 分红
    {"event_type": "分红", "keywords": ["分红", "高送转", "派息", "股息", "现金分红", "送转", "每10股派"], "impact": "low"},
    # 重大合同
    {"event_type": "重大合同", "keywords": ["重大合同", "中标", "大单", "签署协议", "战略合作协议", "项目中标"], "impact": "medium"},
    # 产品突破
    {"event_type": "产品突破", "keywords": ["新产品", "技术突破", "获得认证", "专利授权", "量产", "获批"], "impact": "medium"},
]

# All patterns combined for classification
ALL_PATTERNS = NEGATIVE_PATTERNS + POSITIVE_PATTERNS


def classify_news(title: str, content: str = "") -> Dict:
    """
    Classify a single news item.
    Returns: {"event_type", "sentiment", "impact_level", "matched_keywords", "confidence"}
    """
    text = f"{title} {content}"
    text_lower = text.lower()

    matches = []
    for pattern in ALL_PATTERNS:
        for kw in pattern["keywords"]:
            if kw in text or kw in text_lower:
                matches.append({
                    "event_type": pattern["event_type"],
                    "sentiment": "negative" if pattern in NEGATIVE_PATTERNS else "positive",
                    "impact_level": pattern["impact"],
                    "matched_keyword": kw,
                })
                break  # Only count one keyword per pattern

    if not matches:
        return {
            "event_type": None,
            "sentiment": "neutral",
            "impact_level": "low",
            "matched_keywords": [],
            "confidence": 0.0,
        }

    # Priority: high impact > medium impact, negative > positive (for risk alerts)
    def sort_key(m):
        impact_score = {"high": 3, "medium": 2, "low": 1}.get(m["impact_level"], 0)
        sentiment_score = 1 if m["sentiment"] == "negative" else 0  # Negative first for risk
        return (impact_score, sentiment_score)

    matches.sort(key=sort_key, reverse=True)
    best = matches[0]

    return {
        "event_type": best["event_type"],
        "sentiment": best["sentiment"],
        "impact_level": best["impact_level"],
        "matched_keywords": [m["matched_keyword"] for m in matches],
        "confidence": min(len(matches) * 0.3 + 0.4, 1.0),  # More matches = higher confidence
    }


def classify_news_batch(news_list: List[Dict]) -> List[Dict]:
    """Classify a batch of news items."""
    results = []
    for item in news_list:
        classification = classify_news(item.get("title", ""), item.get("content", ""))
        item.update(classification)
        results.append(item)
    return results


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Classify stock news")
    parser.add_argument("--input", required=True, help="Input JSON file with news array")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    news_list = data.get("news", [])
    classified = classify_news_batch(news_list)

    result = {
        "code": data.get("code", ""),
        "total": len(classified),
        "negative_count": sum(1 for n in classified if n["sentiment"] == "negative"),
        "positive_count": sum(1 for n in classified if n["sentiment"] == "positive"),
        "neutral_count": sum(1 for n in classified if n["sentiment"] == "neutral"),
        "news": classified,
    }

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Classified news saved to: {args.output}")
    else:
        print(result_json)


if __name__ == "__main__":
    main()
