#!/usr/bin/env python3
"""
Market news classifier.
Classifies market-wide news into types and analyzes impact on market/sectors.
"""
import argparse
import json
from typing import Dict, List, Tuple

# ── News type classification ────────────────────────────────────────────────

NEWS_TYPE_PATTERNS = [
    # 政策类
    {"news_type": "政策", "keywords": [
        "政策", "国务院", "部委", "发改委", "工信部", "科技部", "财政部",
        "通知", "指导意见", "规划", "纲要", "方案", "试点", "示范区",
        "补贴", "扶持", "鼓励", "限制", "禁止", "准入",
    ]},
    # 宏观类
    {"news_type": "宏观", "keywords": [
        "GDP", "CPI", "PPI", "PMI", "LPR", "MLF", "SLF", "逆回购",
        "降准", "降息", "加息", "利率", "汇率", "人民币", "美元", "美联储",
        "M2", "社融", "信贷", "存款", "贷款", "准备金",
        "通胀", "通缩", "复苏", "衰退", "滞胀",
        "就业", "失业率", "消费", "投资", "出口", "进口", "贸易",
    ]},
    # 监管类
    {"news_type": "监管", "keywords": [
        "证监会", "银保监会", "金融监管", "退市", "立案调查", "处罚",
        "问询函", "监管函", "警示函", "违规", "内幕交易", "操纵市场",
        "IPO", "注册制", "审核", "发审", "再融资",
    ]},
    # 国际类
    {"news_type": "国际", "keywords": [
        "美国", "美联储", "特朗普", "拜登", "欧盟", "欧洲", "日本", "韩国",
        "关税", "贸易战", "制裁", "脱钩", "供应链", "全球化",
        "中东", "伊朗", "以色列", "俄乌", "地缘政治", "冲突", "战争",
        "原油", "石油", "天然气", "黄金", "铜", "镍", "铝",
        "美股", "纳斯达克", "标普", "道指", "港股", "恒生",
    ]},
    # 行业类（产业政策/行业动态）
    {"news_type": "行业", "keywords": [
        "新能源", "光伏", "风电", "储能", "锂电池", "电动车", "新能源汽车",
        "半导体", "芯片", "光刻胶", "晶圆", "封测", "EDA", "AI芯片",
        "人工智能", "AI", "大模型", "算力", "数据中心", "云计算",
        "医药", "创新药", "医疗器械", "集采", "医保", "CXO",
        "房地产", "房价", "楼市", "住建部", "保交楼", "房贷利率",
        "银行", "保险", "券商", "金融科技",
        "消费", "零售", "餐饮", "旅游", "免税",
        "军工", "航天", "航空", "船舶",
    ]},
]

# ── Sector impact mapping ───────────────────────────────────────────────────

# Maps keywords to affected sectors: (benefit_sectors, harm_sectors)
SECTOR_IMPACT_MAP = {
    # 货币政策
    "降准": (["银行", "地产", "券商"], []),
    "降息": (["地产", "银行", "券商", "消费"], []),
    "加息": ([], ["地产", "银行", "高负债"]),
    "LPR下调": (["地产", "银行"], []),
    # 新能源
    "新能源补贴": (["新能源", "光伏", "风电", "储能", "锂电池"], ["传统能源"]),
    "新能源政策": (["新能源", "光伏", "风电", "储能", "电动车"], []),
    "双碳": (["新能源", "光伏", "风电", "储能", "核电", "环保"], ["煤炭", "钢铁", "水泥"]),
    "碳中和": (["新能源", "光伏", "风电", "储能", "核电", "环保"], ["煤炭", "钢铁"]),
    # 半导体
    "半导体": (["半导体", "芯片", "设备", "材料"], []),
    "芯片": (["半导体", "芯片", "设备", "材料"], []),
    "光刻胶": (["半导体", "材料"], []),
    "国产替代": (["半导体", "软件", "工业母机", "医疗器械"], []),
    # AI
    "人工智能": (["AI", "算力", "数据中心", "云计算", "软件"], []),
    "AI": (["AI", "算力", "数据中心", "云计算", "软件"], []),
    "大模型": (["AI", "算力", "数据中心", "软件"], []),
    "算力": (["AI", "算力", "数据中心", "云计算", "光模块"], []),
    # 医药
    "集采": ([], ["医药", "医疗器械", "创新药"]),
    "医保谈判": ([], ["医药", "创新药"]),
    "创新药": (["创新药", "CXO", "生物医药"], []),
    # 房地产
    "房地产政策": (["地产", "建材", "家电", "银行"], []),
    "保交楼": (["地产", "建材", "家电"], []),
    "房贷利率": (["地产", "银行"], []),
    "房地产税": ([], ["地产"]),
    "房住不炒": ([], ["地产", "建材"]),
    # 消费
    "消费券": (["消费", "零售", "餐饮", "旅游", "免税"], []),
    "刺激消费": (["消费", "零售", "餐饮", "旅游", "汽车"], []),
    # 国际贸易
    "关税": (["国产替代", "半导体"], ["出口", "外贸", "消费电子"]),
    "贸易战": (["国产替代", "半导体", "稀土"], ["出口", "外贸", "消费电子"]),
    "制裁": (["国产替代", "半导体", "稀土"], ["出口", "外贸"]),
    "脱钩": (["国产替代", "半导体", "稀土", "军工"], ["出口", "外贸"]),
    # 能源/资源
    "原油大涨": (["石油", "石化", "油服"], ["航空", "化工", "物流"]),
    "原油大跌": (["航空", "化工", "物流"], ["石油", "石化", "油服"]),
    "黄金大涨": (["黄金", "有色"], []),
    "铜涨价": (["铜", "有色", "矿业"], ["电力", "家电", "电缆"]),
    "稀土": (["稀土", "有色", "磁材"], []),
    # 监管
    "退市": ([], ["ST", "小市值", "壳资源"]),
    "IPO放缓": (["次新股", "壳资源"], ["券商"]),
    "IPO加速": (["券商"], ["次新股", "壳资源"]),
    "收紧": ([], ["券商", "地产", "信托"]),
    "放松": (["券商", "地产", "信托"], []),
}

# ── Sentiment rules by news type ────────────────────────────────────────────

POSITIVE_KEYWORDS = [
    "上涨", "大涨", "反弹", "复苏", "回暖", "向好", "利好", "超预期",
    "增长", "提升", "扩大", "加速", "推进", "落地", "通过", "获批",
    "降息", "降准", "宽松", "刺激", "支持", "扶持", "鼓励",
    "突破", "创新高", "涨停", "走强", "放量",
]

NEGATIVE_KEYWORDS = [
    "下跌", "大跌", "暴跌", "调整", "回落", "走弱", "低迷", "不及预期",
    "下降", "下滑", "萎缩", "放缓", "推迟", "暂停", "终止", "失败",
    "加息", "收紧", "限制", "禁止", "打压", "调查", "处罚", "立案",
    "风险", "危机", "违约", "暴雷", "退市", "跌停", "崩盘",
    "冲突", "战争", "制裁", "贸易战", "脱钩",
]


def classify_market_news(title: str) -> Dict:
    """
    Classify a market news item.
    Returns: {
        news_type, sentiment, impact_scope,
        affected_sectors: {benefit: [...], harm: [...]},
        matched_keywords, confidence
    }
    """
    text = title.lower()

    # 1. Classify news type
    news_type = "其他"
    type_matches = []
    for pattern in NEWS_TYPE_PATTERNS:
        for kw in pattern["keywords"]:
            if kw.lower() in text or kw in title:
                type_matches.append(pattern["news_type"])
                break

    if type_matches:
        # Priority: 政策 > 监管 > 宏观 > 国际 > 行业 > 其他
        priority = {"政策": 5, "监管": 4, "宏观": 3, "国际": 2, "行业": 1, "其他": 0}
        news_type = max(type_matches, key=lambda x: priority.get(x, 0))

    # 2. Determine sentiment
    pos_count = sum(1 for kw in POSITIVE_KEYWORDS if kw in title)
    neg_count = sum(1 for kw in NEGATIVE_KEYWORDS if kw in title)

    if neg_count > pos_count:
        sentiment = "negative"
    elif pos_count > neg_count:
        sentiment = "positive"
    else:
        sentiment = "neutral"

    # 3. Analyze sector impact
    benefit_sectors = set()
    harm_sectors = set()
    matched_impact_keywords = []

    for kw, (benefit, harm) in SECTOR_IMPACT_MAP.items():
        if kw in title:
            benefit_sectors.update(benefit)
            harm_sectors.update(harm)
            matched_impact_keywords.append(kw)

    # Determine impact scope
    if benefit_sectors or harm_sectors:
        impact_scope = "sector_specific"
    elif news_type in ["宏观", "监管", "国际"]:
        impact_scope = "market_wide"
    else:
        impact_scope = "mixed"

    # Confidence based on matches
    total_matches = len(type_matches) + len(matched_impact_keywords) + max(pos_count, neg_count)
    confidence = min(total_matches * 0.2 + 0.3, 1.0)

    return {
        "news_type": news_type,
        "sentiment": sentiment,
        "impact_scope": impact_scope,
        "affected_sectors": {
            "benefit": sorted(list(benefit_sectors)),
            "harm": sorted(list(harm_sectors)),
        },
        "matched_keywords": matched_impact_keywords,
        "confidence": round(confidence, 2),
    }


def classify_market_news_batch(news_list: List[Dict]) -> List[Dict]:
    """Classify a batch of market news."""
    results = []
    for item in news_list:
        classification = classify_market_news(item.get("title", ""))
        item.update(classification)
        results.append(item)
    return results


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Classify market news")
    parser.add_argument("--input", required=True, help="Input JSON file")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    news_list = data.get("news", [])
    classified = classify_market_news_batch(news_list)

    # Group by type
    type_stats = {}
    for item in classified:
        nt = item["news_type"]
        if nt not in type_stats:
            type_stats[nt] = {"count": 0, "positive": 0, "negative": 0, "neutral": 0}
        type_stats[nt]["count"] += 1
        type_stats[nt][item["sentiment"]] += 1

    result = {
        "fetch_time": data.get("fetch_time"),
        "total": len(classified),
        "type_stats": type_stats,
        "news": classified,
    }

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Classified market news saved to: {args.output}")
    else:
        print(result_json)


if __name__ == "__main__":
    main()
