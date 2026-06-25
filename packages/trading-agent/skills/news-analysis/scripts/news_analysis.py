#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
新闻深度分析技能 V2.0
基于 news-search 获取数据，进行多维度深度分析：
  1. 覆盖A股、港股、美股及全球市场新闻
  2. 行业正面/负面影响详细拆解
  3. 新闻影响持续性评估（短期/中期/长期）
  4. 结合投资日历分析未来事件关联
"""

import os
import sys
import json
import re
import logging
import argparse
import subprocess
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from collections import Counter, defaultdict
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# 将 news-search 路径加入 sys.path
_current_dir = Path(__file__).parent.resolve()
_news_search_path = (_current_dir.parent.parent / "news-search" / "scripts").resolve()
if str(_news_search_path) not in sys.path:
    sys.path.insert(0, str(_news_search_path))

# ---------------------------------------------------------------------------
# 词典配置
# ---------------------------------------------------------------------------

# 停用词 — 公告模板、无意义词汇、日期格式
STOP_WORDS = {
    "以下简称", "证券简称", "股票名称", "公告编号", "电脑硬件", "涨跌幅",
    "截至本公告披露日", "本公司董事会", "全体董事保证", "不存在虚假记载",
    "信息披露", "媒体", "报道", "证券时报", "证券日报", "中国证券报",
    "上海证券报", "财联社", "同花顺", "东方财富", "新浪财经",
    "特此公告", "备查文件", "股东大会", "董事会", "监事会",
    "关于公司", "有限公司", "股份有限公司", "集团股份有限公司",
    "数据来源", "风险提示", "免责声明", "仅供参考",
    "不代表", "投资顾问", "研究团队", "分析师", "研究所",
    "本文来自", "版权声明", "编辑", "记者", "播报",
    "与此同时", "截至发稿", "证券代码", "证券时报网", "中证网",
    "年月日", "月日", "今日", "昨日", "明日", "近日", "日前", "日前后",
    "早盘", "午盘", "尾盘", "盘中", "开盘", "收盘", "日内", "分时",
    "道指涨", "纳指涨", "标普涨", "道指跌", "纳指跌", "标普跌",
    "涨幅", "跌幅", "涨跌", "成交量", "成交额", "市值",
    "股份有限公司", "有限责任公司", "集团股份有限公司",
}

# 情感词典
SENTIMENT_POSITIVE = {
    "利好", "上涨", "涨停", "大涨", "飙升", "突破", "增长", "超预期", "政策扶持",
    "订单饱满", "业绩暴增", "净利润增长", "营收增长", "市场份额扩大", "技术突破",
    "获批", "中标", "签约", "合作", "扩张", "增资", "并购", "重组", "复牌",
    "创新高", "强势", "反弹", "回升", "回暖", "复苏", "景气", "繁荣", "向好",
    "优化", "升级", "转型成功", "龙头", "领跑", "市占率提升", "盈利能力增强",
    "降本增效", "毛利率提升", "现金流改善", "估值修复", "机构看好", "买入评级",
    "增持", "推荐", "目标价上调", "白马", "蓝筹", "核心资产", "护城河", "壁垒",
    "国产替代", "自主可控", "卡脖子", "突破封锁", "供应链安全", "新基建",
    "碳中和", "碳达峰", "新能源", "清洁能源", "绿色金融", "ESG", "双碳",
    "降息", "降准", "宽松", "刺激", "支持", "减税", "降费", "补贴",
    "供不应求", "涨价", "提价", "产能利用率", "满产", "扩产",
    "超预期", "戴维斯双击", "双击", "量价齐升", "量价",
}

SENTIMENT_NEGATIVE = {
    "利空", "下跌", "跌停", "大跌", "暴跌", "崩盘", "下滑", "不及预期", "监管",
    "处罚", "暴雷", "踩雷", "ST", "退市", "亏损", "业绩预亏", "净利润下滑",
    "营收下降", "裁员", "关停", "破产", "债务违约", "信用评级下调", "问询函",
    "立案调查", "高管被查", "财务造假", "造假", "欺诈", "违规", "操纵",
    "减持", "套现", "大股东减持", "解禁", "破发", "破净", "估值过高",
    "泡沫", "过热", "回调", "调整", "下行", "低迷", "萎缩", "恶化", "承压",
    "拖累", "拖累业绩", "miss", "预警", "风险提示", "黑天鹅",
    "灰犀牛", "地缘政治", "贸易摩擦", "制裁", "断供", "封锁", "关税",
    "产能过剩", "库存积压", "价格战", "内卷", "竞争加剧", "毛利下滑",
    "加息", "收紧", "缩表", "流动性紧张", "信用收缩", "通缩", "衰退",
    "俄乌", "冲突", "战争", "紧张局势", "地缘政治风险",
}

# 行业映射词典
INDUSTRY_KEYWORDS = {
    # 金融
    "银行": "银行", "农商行": "银行", "城商行": "银行", "国有大行": "银行",
    "保险": "保险", "寿险": "保险", "财险": "保险", "再保险": "保险",
    "券商": "证券", "投行": "证券", "经纪业务": "证券", "资管": "证券",
    "信托": "多元金融", "期货": "多元金融", "融资租赁": "多元金融",
    "港股": "港股", "恒生": "港股", "港交所": "港股",
    "美股": "美股", "纳斯达克": "美股", "标普": "美股", "道琼斯": "美股",
    "美联储": "美股", "加息": "宏观", "降息": "宏观", "降准": "宏观",

    # 科技
    "半导体": "电子", "芯片": "电子", "集成电路": "电子", "晶圆": "电子",
    "光刻": "电子", "EDA": "电子", "封测": "电子", "存储": "电子",
    "AI": "计算机", "人工智能": "计算机", "大模型": "计算机", "算法": "计算机",
    "算力": "计算机", "数据中心": "计算机", "云计算": "计算机", "软件": "计算机",
    "5G": "通信", "6G": "通信", "基站": "通信", "光纤": "通信", "光模块": "通信",
    "物联网": "通信", "卫星": "通信", "通信设备": "通信",

    # 新能源
    "光伏": "电力设备", "太阳能": "电力设备", "组件": "电力设备", "逆变器": "电力设备",
    "风电": "电力设备", "风机": "电力设备", "储能": "电力设备", "锂电池": "电力设备",
    "宁德时代": "电力设备", "比亚迪": "汽车", "新能源车": "汽车", "电动汽车": "汽车",
    "充电桩": "电力设备", "换电": "电力设备", "氢能源": "电力设备",

    # 医药
    "创新药": "医药生物", "仿制药": "医药生物", "CXO": "医药生物", "CRO": "医药生物",
    "医疗器械": "医药生物", "疫苗": "医药生物", "生物制药": "医药生物",
    "中药": "医药生物", "医保": "医药生物", "集采": "医药生物",

    # 消费
    "白酒": "食品饮料", "茅台": "食品饮料", "五粮液": "食品饮料",
    "啤酒": "食品饮料", "乳制品": "食品饮料", "调味品": "食品饮料",
    "家电": "家用电器", "空调": "家用电器", "冰箱": "家用电器",
    "扫地机器人": "家用电器", "小家电": "家用电器",
    "免税": "商贸零售", "电商": "商贸零售", "零售": "商贸零售",
    "旅游": "社会服务", "酒店": "社会服务", "餐饮": "社会服务",
    "影视": "传媒", "游戏": "传媒", "短视频": "传媒", "直播": "传媒",
    "广告": "传媒", "出版": "传媒",

    # 周期
    "钢铁": "钢铁", "煤炭": "煤炭", "化工": "基础化工", "石化": "石油石化",
    "有色金属": "有色金属", "稀土": "有色金属", "锂": "有色金属", "铜": "有色金属",
    "铝": "有色金属", "黄金": "有色金属", "贵金属": "有色金属",
    "原油": "石油石化", "油价": "石油石化", "OPEC": "石油石化",
    "水泥": "建筑材料", "玻璃": "建筑材料", "建材": "建筑材料",
    "造纸": "轻工制造", "家具": "轻工制造", "包装": "轻工制造",

    # 制造
    "机器人": "机械设备", "减速器": "机械设备", "机床": "机械设备",
    "工程机械": "机械设备", "挖掘机": "机械设备", "叉车": "机械设备",
    "汽车零部件": "汽车", "一体化压铸": "汽车", "智能驾驶": "汽车",
    "激光雷达": "汽车", "车联网": "汽车", "智能座舱": "汽车",
    "航空航天": "国防军工", "军工": "国防军工", "船舶": "国防军工",
    "无人机": "国防军工",

    # 其他
    "房地产": "房地产", "地产": "房地产", "基建": "建筑装饰",
    "建筑": "建筑装饰", "电力": "公用事业", "水务": "公用事业",
    "燃气": "公用事业", "环保": "环保", "农业": "农林牧渔",
    "养殖": "农林牧渔", "种业": "农林牧渔", "猪肉": "农林牧渔",
    "航运": "交通运输", "港口": "交通运输", "物流": "交通运输",
    "快递": "交通运输", "航空": "交通运输", "铁路": "交通运输",
}

# 公司名称 -> 股票代码映射
COMPANY_STOCK_MAP = {
    "茅台": "600519", "贵州茅台": "600519",
    "五粮液": "000858",
    "宁德时代": "300750",
    "比亚迪": "002594",
    "中国平安": "601318",
    "招商银行": "600036",
    "工商银行": "601398",
    "建设银行": "601939",
    "农业银行": "601288",
    "中国银行": "601988",
    "中信证券": "600030",
    "东方财富": "300059",
    "海康威视": "002415",
    "美的集团": "000333",
    "格力电器": "000651",
    "立讯精密": "002475",
    "迈瑞医疗": "300760",
    "恒瑞医药": "600276",
    "药明康德": "603259",
    "中芯国际": "688981",
    "北方华创": "002371",
    "隆基绿能": "601012",
    "通威股份": "600438",
    "天岳先进": "688234",
    "宝钢股份": "600019",
    "Tesla": "TSLA", "特斯拉": "TSLA",
    "英伟达": "NVDA", "NVIDIA": "NVDA",
    "苹果": "AAPL", "Apple": "AAPL",
    "微软": "MSFT", "Microsoft": "MSFT",
    "谷歌": "GOOGL", "Alphabet": "GOOGL",
    "亚马逊": "AMZN", "Amazon": "AMZN",
    "Meta": "META", "Facebook": "META",
    "腾讯": "0700.HK", "腾讯控股": "0700.HK",
    "阿里": "BABA", "阿里巴巴": "BABA",
    "美团": "3690.HK", "拼多多": "PDD",
    "小米": "1810.HK", "小米集团": "1810.HK",
}

# 影响持续性评估关键词
DURATION_SHORT = {
    "涨停", "跌停", "异动", "冲高回落", "反弹", "回调", "日内", "短线",
    "一日游", "脉冲", "快闪", "波动", "震荡", "盘整", "技术性",
    "临时", "短期", "短线交易", "超短", "T+0", "分时",
    "早盘", "尾盘", "开盘", "收盘", "盘中", "跳涨", "跳跌",
}
DURATION_MEDIUM = {
    "季报", "中报", "年报", "业绩预告", "业绩快报", "财报", "披露",
    "政策落地", "行业数据", "月度数据", "季度", "月度", "半年报",
    "一季报", "三季报", "四季报", "中期", "阶段性", "窗口期",
    "季节性", "旺季", "淡季", "补库存", "去库存",
    "调研", "路演", "机构调研", "业绩说明会",
}
DURATION_LONG = {
    "产业升级", "技术变革", "结构性改革", "长期趋势", "战略", "规划",
    "五年计划", "人口结构", "老龄化", "城镇化", "双循环",
    "新质生产力", "高质量发展", "共同富裕", "区域协调",
    "碳中和", "碳达峰", "能源转型", "数字化转型", "智能制造",
    "自主可控", "国产替代", "供应链重构", "全球化", "逆全球化",
    "地缘政治格局", "国际秩序", "气候", "科技革命", "产业革命",
    "颠覆性", "范式转移", "长周期", "结构性", "制度性",
}


# ---------------------------------------------------------------------------
# 投资日历集成
# ---------------------------------------------------------------------------

def fetch_calendar_events(start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    调用 investment_calendar.py 获取未来事件
    """
    script_path = Path(__file__).parent.parent.parent / "a-share-analysis" / "scripts" / "investment_calendar.py"
    if not script_path.exists():
        logger.warning(f"投资日历脚本不存在: {script_path}")
        return _fallback_seasonal_events(start_date, end_date)

    try:
        result = subprocess.run(
            [sys.executable, str(script_path), "--refresh-market", "--since", start_date, "--until", end_date],
            capture_output=True, timeout=60
        )
        # 尝试多种编码解码
        for encoding in ["utf-8", "gbk", "gb2312", "latin-1"]:
            try:
                stdout = result.stdout.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            stdout = result.stdout.decode("utf-8", errors="replace")

        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                data = json.loads(line)
                if data.get("success") and "events" in data:
                    return data["events"]
        logger.warning("投资日历返回数据解析失败，使用内置事件")
        return _fallback_seasonal_events(start_date, end_date)
    except Exception as e:
        logger.warning(f"调用投资日历失败: {e}")
        return _fallback_seasonal_events(start_date, end_date)


def _fallback_seasonal_events(start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """内置季节性事件回退"""
    events = [
        {"event_date": "2026-06-02", "title": "苹果WWDC", "category": "conference",
         "description": "苹果年度开发者大会，iOS/macOS新系统发布", "importance": "high",
         "affected_sectors": ["苹果概念", "AI手机", "消费电子"], "source": "seasonal"},
        {"event_date": "2026-06-02", "title": "Computex台北电脑展", "category": "conference",
         "description": "全球第二大电脑展，AI PC新品发布", "importance": "high",
         "affected_sectors": ["AI PC", "芯片", "消费电子"], "source": "seasonal"},
        {"event_date": "2026-06-10", "title": "SNEC光伏展", "category": "conference",
         "description": "全球最大光伏展", "importance": "high",
         "affected_sectors": ["光伏", "储能", "逆变器"], "source": "seasonal"},
        {"event_date": "2026-06-01", "title": "618购物节", "category": "industry",
         "description": "年中电商大促", "importance": "medium",
         "affected_sectors": ["电商", "化妆品", "小家电", "白酒"], "source": "seasonal"},
        {"event_date": "2026-06-01", "title": "OPEC+产量会议", "category": "macro",
         "description": "决定下半年原油产量政策", "importance": "high",
         "affected_sectors": ["油气", "油服", "航运"], "source": "seasonal"},
        {"event_date": "2026-07-25", "title": "中央政治局会议", "category": "macro",
         "description": "半年度经济工作部署", "importance": "high",
         "affected_sectors": [], "source": "seasonal"},
    ]
    # 过滤日期范围
    filtered = []
    for ev in events:
        if start_date <= ev["event_date"] <= end_date:
            filtered.append(ev)
    return filtered


def match_news_to_calendar(news_topics: List[str], calendar_events: List[Dict]) -> List[Dict]:
    """将新闻话题与投资日历事件关联"""
    matched = []
    # 扩展的行业关键词映射：事件 -> 相关新闻话题
    EVENT_TOPIC_MAP = {
        "苹果WWDC": ["苹果", "AI手机", "消费电子", "人工智能", "大模型"],
        "Computex": ["AI PC", "芯片", "半导体", "消费电子", "人工智能"],
        "SNEC光伏展": ["光伏", "储能", "新能源", "电力设备", "逆变器"],
        "618购物节": ["电商", "消费", "零售", "白酒", "家电"],
        "OPEC+": ["原油", "油价", "石油", "能源", "油气"],
        "中央政治局会议": ["政策", "宏观", "经济", "刺激", "宽松"],
        "苹果": ["苹果", "AI手机", "消费电子"],
        "光伏": ["光伏", "储能", "新能源"],
    }
    for ev in calendar_events:
        title = ev.get("title", "")
        desc = ev.get("description", "")
        sectors = ev.get("affected_sectors", [])
        related_topics = []
        # 通过事件标题匹配预设话题
        for event_key, related_keywords in EVENT_TOPIC_MAP.items():
            if event_key.lower() in (title + desc).lower():
                for kw in related_keywords:
                    if kw in news_topics and kw not in related_topics:
                        related_topics.append(kw)
        # 通过板块匹配
        for sector in sectors:
            for topic in news_topics:
                if sector in topic or topic in sector:
                    if topic not in related_topics:
                        related_topics.append(topic)
        if related_topics:
            matched.append({
                "event": ev,
                "related_topics": related_topics,
            })
    return matched


# ---------------------------------------------------------------------------
# 分析器类
# ---------------------------------------------------------------------------

class NewsAnalyzer:
    """新闻深度分析器 V2"""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("IWENCAI_API_KEY")
        if not self.api_key:
            raise ValueError("API密钥未设置。请设置环境变量 IWENCAI_API_KEY")

        try:
            from news_search import NewsSearchAPI, NewsProcessor
            self.search_api = NewsSearchAPI(api_key=self.api_key)
            self.processor = NewsProcessor()
        except ImportError as e:
            logger.error(f"无法导入news_search模块: {e}")
            raise

    # ---- 文本分析工具 -----------------------------------------------------

    def _is_stop_word(self, word: str) -> bool:
        """判断是否为停用词"""
        if word in STOP_WORDS:
            return True
        if len(word) <= 2:
            return True
        # 纯数字
        if re.match(r'^\d+$', word):
            return True
        # 日期格式: 5月27日, 2026年, 2026-05-28
        if re.search(r'\d{1,2}月\d{1,2}日|\d{4}年|\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月', word):
            return True
        # 股价/指数格式: 道指涨0.5, 股价跌3%, 67亿元
        if re.search(r'涨\d|跌\d|股价|亿元|万元|亿美元|亿美元|指数\d', word):
            return True
        # 公告类固定词组
        if word.startswith("公告") or word.startswith("发布") or word.endswith("公告"):
            return True
        return False

    def _extract_keywords(self, text: str) -> List[str]:
        """提取关键词（带停用词过滤）"""
        if not text:
            return []
        text = re.sub(r'[^一-龥a-zA-Z0-9]', ' ', text)
        words = text.split()
        keywords = []
        for w in words:
            if not self._is_stop_word(w):
                keywords.append(w)
        return keywords

    def _analyze_sentiment(self, text: str) -> Tuple[str, float]:
        """分析文本情感倾向"""
        if not text:
            return "neutral", 0.0
        pos_count = sum(1 for word in SENTIMENT_POSITIVE if word in text)
        neg_count = sum(1 for word in SENTIMENT_NEGATIVE if word in text)
        total = pos_count + neg_count
        if total == 0:
            return "neutral", 0.0
        score = (pos_count - neg_count) / total
        if score > 0.2:
            return "positive", min(score, 1.0)
        elif score < -0.2:
            return "negative", max(score, -1.0)
        else:
            return "neutral", score

    def _extract_industries(self, text: str) -> List[str]:
        """提取相关行业"""
        if not text:
            return []
        industries = []
        for keyword, industry in INDUSTRY_KEYWORDS.items():
            if keyword in text and industry not in industries:
                industries.append(industry)
        return industries

    def _extract_stock_codes(self, text: str) -> List[str]:
        """提取A股6位股票代码"""
        if not text:
            return []
        codes = re.findall(r'(?:sh|sz|bj|SH|SZ|BJ)?(\d{6})', text)
        valid = [c for c in codes if c.startswith(
            ('60', '68', '90', '00', '30', '43', '83', '87', '92')
        )]
        return list(set(valid))

    def _extract_companies(self, text: str) -> List[Tuple[str, str]]:
        """提取公司名称和代码"""
        return [(c, code) for c, code in COMPANY_STOCK_MAP.items() if c in text]

    def _assess_duration(self, text: str) -> Tuple[str, str]:
        """
        评估新闻影响持续性
        Returns: (duration_label, reason)
        duration_label: short / medium / long
        """
        text = text.lower()
        short_score = sum(1 for w in DURATION_SHORT if w in text)
        medium_score = sum(1 for w in DURATION_MEDIUM if w in text)
        long_score = sum(1 for w in DURATION_LONG if w in text)

        if long_score > 0 and long_score >= medium_score and long_score >= short_score:
            return "long", "涉及结构性变革、长期政策或产业周期"
        elif medium_score > 0 and medium_score >= short_score:
            return "medium", "涉及季度/中期业绩或阶段性政策"
        elif short_score > 0:
            return "short", "市场短期波动或技术性行情"
        else:
            # 默认根据文本长度和复杂度判断
            if len(text) > 200 and ("政策" in text or "改革" in text):
                return "medium", "政策类事件，通常有中期影响"
            return "short", "日常市场波动，无明显长期信号"

    def _determine_impact_level(self, article: Dict[str, Any]) -> str:
        """判断新闻影响级别"""
        text = article.get("title", "") + article.get("summary", "")
        major_keywords = ["国务院", "央行", "证监会", "银保监会", "重大政策", "国家级",
                         "中美", "贸易战", "制裁", "突发", "重大", "重磅", "美联储"]
        for kw in major_keywords:
            if kw in text:
                return "major"
        medium_keywords = ["行业政策", "部门", "协会", "公告", "订单", "中标", "获批"]
        for kw in medium_keywords:
            if kw in text:
                return "medium"
        return "minor"

    # ---- 数据采集 ---------------------------------------------------------

    def _fetch_news(self, topic: Optional[str] = None, days: int = 7) -> List[Dict[str, Any]]:
        """获取新闻（覆盖A股、港股、美股、全球宏观）"""
        if topic:
            queries = [topic]
        else:
            queries = [
                # A股
                "A股市场重大新闻", "A股政策利好", "A股行业动态", "A股上市公司公告",
                # 港股
                "港股市场动态", "港股重大新闻", "港股科技板块", "恒生指数",
                # 美股
                "美股市场动态", "美股科技股", "美联储政策", "纳斯达克", "中概股",
                # 全球宏观
                "全球宏观经济", "国际贸易动态", "原油价格", "黄金价格", "汇率波动",
                # 热点主题
                "人工智能AI新闻", "新能源动态", "半导体芯片", "医药生物",
            ]

        all_articles = []
        seen_titles = set()

        import time
        for i, query in enumerate(queries):
            try:
                logger.info(f"搜索: {query}")
                response = self.search_api.search(query)
                if "error" in response:
                    logger.warning(f"查询 '{query}' 返回错误")
                    continue
                articles = response.get("data", [])
                logger.info(f"查询 '{query}' 获取 {len(articles)} 篇文章")
                for article in articles:
                    title = article.get("title", "")
                    if title in seen_titles:
                        continue
                    seen_titles.add(title)
                    all_articles.append(article)
            except Exception as e:
                logger.error(f"查询 '{query}' 失败: {e}")
            # 避免触发API频率限制
            if i < len(queries) - 1:
                time.sleep(1.5)

        filtered = self.processor.filter_by_date(all_articles, days)
        logger.info(f"过滤后: {len(filtered)} 篇 (最近{days}天)")
        return filtered

    # ---- 核心分析 ---------------------------------------------------------

    def analyze_articles(self, articles: List[Dict[str, Any]], calendar_events: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """对文章进行深度多维度分析"""
        if not articles:
            return {"error": "没有文章可供分析"}

        analyzed = []
        topic_counter = Counter()
        industry_positive = defaultdict(list)   # industry -> list of scores
        industry_negative = defaultdict(list)
        stock_counter = Counter()
        sentiment_scores = []
        daily_counts = defaultdict(int)
        duration_counts = Counter()
        risk_articles = []
        opportunity_articles = []
        market_region_counts = Counter()  # A股/港股/美股/全球

        for article in articles:
            title = article.get("title", "")
            summary = article.get("summary", "")
            text = title + " " + summary
            pub_date = article.get("publish_date", "")

            # 情感
            sentiment, score = self._analyze_sentiment(text)
            sentiment_scores.append(score)

            # 行业
            industries = self._extract_industries(text)
            for ind in industries:
                if sentiment == "positive":
                    industry_positive[ind].append(score)
                elif sentiment == "negative":
                    industry_negative[ind].append(score)
                else:
                    industry_positive[ind].append(0.1)
                    industry_negative[ind].append(-0.1)

            # 个股
            stock_codes = self._extract_stock_codes(text)
            companies = self._extract_companies(text)
            for _, code in companies:
                if code not in stock_codes:
                    stock_codes.append(code)
            for code in stock_codes:
                stock_counter[code] += 1

            # 关键词（停用词已过滤）
            keywords = self._extract_keywords(text)
            for kw in keywords:
                if len(kw) >= 3:
                    topic_counter[kw] += 1

            # 影响级别
            impact = self._determine_impact_level(article)

            # 持续性
            duration, duration_reason = self._assess_duration(text)
            duration_counts[duration] += 1

            # 市场区域
            region = "A股"
            if any(kw in text for kw in ["港股", "恒生", "港交所"]):
                region = "港股"
            elif any(kw in text for kw in ["美股", "纳斯达克", "标普", "道琼斯", "美联储"]):
                region = "美股"
            elif any(kw in text for kw in ["全球", "国际", "OPEC", "原油", "黄金", "汇率", "贸易"]):
                region = "全球"
            market_region_counts[region] += 1

            # 日统计
            if pub_date:
                try:
                    dt = datetime.strptime(pub_date.split('+')[0].strip(), "%Y-%m-%d %H:%M:%S")
                    daily_counts[dt.strftime("%Y-%m-%d")] += 1
                except (ValueError, TypeError):
                    pass

            # 风险/机会
            if sentiment == "negative" and score < -0.5:
                risk_articles.append(article)
            elif sentiment == "positive" and score > 0.5:
                opportunity_articles.append(article)

            analyzed.append({
                "title": title,
                "summary": summary,
                "url": article.get("url", ""),
                "publish_date": pub_date,
                "sentiment": sentiment,
                "sentiment_score": round(score, 3),
                "industries": industries,
                "stocks": stock_codes,
                "impact_level": impact,
                "duration": duration,
                "duration_reason": duration_reason,
                "market_region": region,
            })

        # 整体情感
        avg_sentiment = sum(sentiment_scores) / len(sentiment_scores) if sentiment_scores else 0
        if avg_sentiment > 0.3:
            market_sentiment = "乐观"
        elif avg_sentiment > 0.1:
            market_sentiment = "中性偏乐观"
        elif avg_sentiment > -0.1:
            market_sentiment = "中性"
        elif avg_sentiment > -0.3:
            market_sentiment = "中性偏悲观"
        else:
            market_sentiment = "悲观"

        # 热点话题TOP15（过滤停用词后）
        hot_topics = []
        for word, count in topic_counter.most_common(15):
            if count >= 2 and not self._is_stop_word(word):
                hot_topics.append({"name": word, "count": count})

        # 行业深度分析：正面 vs 负面
        industry_analysis = []
        all_industries = set(list(industry_positive.keys()) + list(industry_negative.keys()))
        for name in all_industries:
            pos_scores = industry_positive.get(name, [])
            neg_scores = industry_negative.get(name, [])
            pos_count = len([s for s in pos_scores if s > 0.2])
            neg_count = len([s for s in neg_scores if s < -0.2])
            total = pos_count + neg_count
            if total == 0:
                continue
            avg = (sum(pos_scores) + sum(neg_scores)) / (len(pos_scores) + len(neg_scores)) if (pos_scores or neg_scores) else 0
            sentiment_label = "positive" if avg > 0.2 else ("negative" if avg < -0.2 else "neutral")
            industry_analysis.append({
                "name": name,
                "total_mentions": total,
                "positive_count": pos_count,
                "negative_count": neg_count,
                "sentiment": sentiment_label,
                "sentiment_score": round(avg, 3),
                "direction": "偏多" if avg > 0.2 else ("偏空" if avg < -0.2 else "中性"),
            })
        industry_analysis.sort(key=lambda x: x["total_mentions"], reverse=True)

        # 热门个股
        stocks = []
        for code, count in stock_counter.most_common(15):
            stock_scores = [a["sentiment_score"] for a in analyzed if code in a["stocks"]]
            stock_avg = sum(stock_scores) / len(stock_scores) if stock_scores else 0
            sentiment_label = "positive" if stock_avg > 0.2 else ("negative" if stock_avg < -0.2 else "neutral")
            name = ""
            for comp, c in COMPANY_STOCK_MAP.items():
                if c == code and len(comp) > len(name):
                    name = comp
            stocks.append({
                "code": code,
                "name": name,
                "mention_count": count,
                "sentiment": sentiment_label,
                "sentiment_score": round(stock_avg, 3),
            })

        # 风险/机会
        risks = []
        for article in risk_articles[:5]:
            text = article.get("title", "") + article.get("summary", "")
            duration, _ = self._assess_duration(text)
            risks.append({
                "description": article.get("title", ""),
                "severity": "高" if "重大" in text or "突发" in text else "中",
                "affected_industries": self._extract_industries(text),
                "duration": duration,
                "url": article.get("url", ""),
            })

        opportunities = []
        for article in opportunity_articles[:5]:
            text = article.get("title", "") + article.get("summary", "")
            duration, _ = self._assess_duration(text)
            related = self._extract_stock_codes(text)
            companies = self._extract_companies(text)
            for _, c in companies:
                if c not in related:
                    related.append(c)
            opportunities.append({
                "description": article.get("title", ""),
                "confidence": "高" if "利好" in text or "上涨" in text else "中",
                "related_stocks": related[:5],
                "duration": duration,
                "url": article.get("url", ""),
            })

        # 投资日历关联
        calendar_matches = []
        if calendar_events:
            topic_names = [t["name"] for t in hot_topics]
            calendar_matches = match_news_to_calendar(topic_names, calendar_events)

        report = {
            "meta": {
                "analysis_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "total_articles": len(articles),
                "data_source": "同花顺问财",
            },
            "summary": {
                "market_sentiment": market_sentiment,
                "sentiment_score": round(avg_sentiment, 3),
                "hot_topics_count": len(hot_topics),
                "affected_industries_count": len(industry_analysis),
                "mentioned_stocks_count": len(stock_counter),
                "risk_articles_count": len(risk_articles),
                "opportunity_articles_count": len(opportunity_articles),
                "duration_distribution": dict(duration_counts),
                "market_region_distribution": dict(market_region_counts),
                "daily_distribution": dict(sorted(daily_counts.items())),
            },
            "topics": hot_topics[:10],
            "industries": industry_analysis[:15],
            "stocks": stocks,
            "risks": risks,
            "opportunities": opportunities,
            "calendar_matches": [
                {
                    "event_title": m["event"]["title"],
                    "event_date": m["event"]["event_date"],
                    "event_category": m["event"]["category"],
                    "affected_sectors": m["event"].get("affected_sectors", []),
                    "related_topics": m["related_topics"],
                }
                for m in calendar_matches[:10]
            ],
            "articles": analyzed[:20],
        }
        return report

    def analyze_recent_news(self, topic: Optional[str] = None, days: int = 7,
                           min_articles: int = 10) -> Dict[str, Any]:
        """分析最近新闻（含投资日历）"""
        articles = self._fetch_news(topic=topic, days=days)
        if len(articles) < min_articles:
            logger.warning(f"文章数量({len(articles)})少于最小要求({min_articles})")

        # 获取未来1-2个月的投资日历事件
        today = datetime.now().strftime("%Y-%m-%d")
        future = (datetime.now() + timedelta(days=60)).strftime("%Y-%m-%d")
        logger.info(f"获取投资日历事件: {today} ~ {future}")
        calendar_events = fetch_calendar_events(today, future)
        logger.info(f"获取到 {len(calendar_events)} 个日历事件")

        return self.analyze_articles(articles, calendar_events)


# ---------------------------------------------------------------------------
# 报告格式化
# ---------------------------------------------------------------------------

def report_to_markdown(report: Dict[str, Any]) -> str:
    """转换为Markdown报告"""
    lines = []
    lines.append("# 财经新闻深度分析报告 (V2)\n")

    meta = report.get("meta", {})
    lines.append(f"**分析时间**: {meta.get('analysis_date', '')}")
    lines.append(f"**数据来源**: {meta.get('data_source', '同花顺问财')}")
    lines.append(f"**分析文章数**: {meta.get('total_articles', 0)}\n")

    summary = report.get("summary", {})
    lines.append("## 一、市场概况\n")
    lines.append(f"- **整体情绪**: {summary.get('market_sentiment', '未知')}")
    lines.append(f"- **情感得分**: {summary.get('sentiment_score', 0)}")
    lines.append(f"- **热点话题**: {summary.get('hot_topics_count', 0)} 个")
    lines.append(f"- **受影响行业**: {summary.get('affected_industries_count', 0)} 个")
    lines.append(f"- **提及个股**: {summary.get('mentioned_stocks_count', 0)} 只")
    lines.append(f"- **风险文章**: {summary.get('risk_articles_count', 0)} 篇")
    lines.append(f"- **机会文章**: {summary.get('opportunity_articles_count', 0)} 篇\n")

    # 市场区域分布
    region_dist = summary.get("market_region_distribution", {})
    if region_dist:
        lines.append("### 新闻来源分布\n")
        for region, count in region_dist.items():
            lines.append(f"- {region}: {count} 篇")
        lines.append("")

    # 影响持续性分布
    duration_dist = summary.get("duration_distribution", {})
    if duration_dist:
        lines.append("### 影响持续性分布\n")
        duration_names = {"short": "短期(1-3天)", "medium": "中期(1-4周)", "long": "长期(1月+)"}
        for k, v in duration_dist.items():
            lines.append(f"- {duration_names.get(k, k)}: {v} 篇")
        lines.append("")

    # 日度分布
    daily = summary.get("daily_distribution", {})
    if daily:
        lines.append("### 日度分布\n")
        for date, count in daily.items():
            lines.append(f"- {date}: {count} 篇")
        lines.append("")

    # 热点话题
    topics = report.get("topics", [])
    if topics:
        lines.append("## 二、热点话题 TOP10\n")
        lines.append("| 排名 | 话题 | 出现次数 |")
        lines.append("|------|------|----------|")
        for i, t in enumerate(topics, 1):
            lines.append(f"| {i} | {t['name']} | {t['count']} |")
        lines.append("")

    # 行业深度分析
    industries = report.get("industries", [])
    if industries:
        lines.append("## 三、行业影响深度分析\n")
        lines.append("| 行业 | 总提及 | 正面 | 负面 | 方向 | 情感得分 |")
        lines.append("|------|--------|------|------|------|----------|")
        for ind in industries:
            emoji = "📈" if ind['sentiment'] == 'positive' else ("📉" if ind['sentiment'] == 'negative' else "➖")
            lines.append(f"| {ind['name']} | {ind['total_mentions']} | {ind['positive_count']} | {ind['negative_count']} | {emoji} {ind['direction']} | {ind['sentiment_score']} |")
        lines.append("")

        # 正面影响行业TOP5
        positive_industries = [i for i in industries if i['sentiment'] == 'positive'][:5]
        if positive_industries:
            lines.append("### 正面影响行业 TOP5\n")
            for ind in positive_industries:
                lines.append(f"- **{ind['name']}**: {ind['positive_count']}篇正面新闻，情感得分 {ind['sentiment_score']}")
            lines.append("")

        # 负面影响行业TOP5
        negative_industries = [i for i in industries if i['sentiment'] == 'negative'][:5]
        if negative_industries:
            lines.append("### 负面影响行业 TOP5\n")
            for ind in negative_industries:
                lines.append(f"- **{ind['name']}**: {ind['negative_count']}篇负面新闻，情感得分 {ind['sentiment_score']}")
            lines.append("")

    # 热门个股
    stocks = report.get("stocks", [])
    if stocks:
        lines.append("## 四、热门个股\n")
        lines.append("| 代码 | 名称 | 提及次数 | 情感 | 得分 |")
        lines.append("|------|------|----------|------|------|")
        for s in stocks:
            emoji = "📈" if s['sentiment'] == 'positive' else ("📉" if s['sentiment'] == 'negative' else "➖")
            lines.append(f"| {s['code']} | {s['name'] or '-'} | {s['mention_count']} | {emoji} | {s['sentiment_score']} |")
        lines.append("")

    # 投资日历关联
    calendar = report.get("calendar_matches", [])
    if calendar:
        lines.append("## 五、投资日历关联事件\n")
        lines.append("> 以下即将发生的事件与当前新闻热点相关，可能提前反应或持续发酵\n")
        for m in calendar:
            lines.append(f"### 📅 {m['event_title']} ({m['event_date']})")
            lines.append(f"- **类型**: {m['event_category']}")
            if m.get('affected_sectors'):
                lines.append(f"- **受影响板块**: {', '.join(m['affected_sectors'])}")
            if m.get('related_topics'):
                lines.append(f"- **关联热点**: {', '.join(m['related_topics'])}")
            lines.append("")

    # 风险警示
    risks = report.get("risks", [])
    if risks:
        lines.append("## 六、风险警示\n")
        for risk in risks:
            dur_icon = "⏱️" if risk['duration'] == 'short' else ("📅" if risk['duration'] == 'medium' else "🏛️")
            lines.append(f"### 🔴 {risk['severity']}风险 {dur_icon}")
            lines.append(f"**{risk['description']}**")
            if risk.get('affected_industries'):
                lines.append(f"- 受影响行业: {', '.join(risk['affected_industries'])}")
            lines.append(f"- 影响持续性: {risk['duration']}")
            if risk.get('url'):
                lines.append(f"- 来源: {risk['url']}")
            lines.append("")

    # 机会提示
    opportunities = report.get("opportunities", [])
    if opportunities:
        lines.append("## 七、机会提示\n")
        for opp in opportunities:
            dur_icon = "⏱️" if opp['duration'] == 'short' else ("📅" if opp['duration'] == 'medium' else "🏛️")
            lines.append(f"### 🟢 {opp['confidence']}信心 {dur_icon}")
            lines.append(f"**{opp['description']}**")
            if opp.get('related_stocks'):
                lines.append(f"- 相关个股: {', '.join(opp['related_stocks'])}")
            lines.append(f"- 影响持续性: {opp['duration']}")
            if opp.get('url'):
                lines.append(f"- 来源: {opp['url']}")
            lines.append("")

    # 重点文章
    articles = report.get("articles", [])
    if articles:
        lines.append("## 八、重点文章分析\n")
        for i, article in enumerate(articles[:10], 1):
            emoji = "📈" if article['sentiment'] == 'positive' else ("📉" if article['sentiment'] == 'negative' else "➖")
            dur_icon = "⏱️" if article['duration'] == 'short' else ("📅" if article['duration'] == 'medium' else "🏛️")
            lines.append(f"### {i}. {article['title']} {emoji} {dur_icon}")
            lines.append(f"- **时间**: {article['publish_date']}")
            lines.append(f"- **情感**: {article['sentiment']} (得分: {article['sentiment_score']})")
            lines.append(f"- **影响级别**: {article['impact_level']}")
            lines.append(f"- **持续性**: {article['duration']} — {article['duration_reason']}")
            lines.append(f"- **市场**: {article['market_region']}")
            if article.get('industries'):
                lines.append(f"- **相关行业**: {', '.join(article['industries'])}")
            if article.get('stocks'):
                lines.append(f"- **相关个股**: {', '.join(article['stocks'])}")
            if article.get('url'):
                lines.append(f"- **链接**: {article['url']}")
            lines.append("")

    lines.append("---\n")
    lines.append("*免责声明: 本报告基于公开新闻数据自动生成，仅供参考，不构成投资建议。*")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 主程序
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="财经新闻深度分析工具 V2 - 覆盖A股/港股/美股，结合投资日历",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s                          # 分析最近7天全球市场新闻
  %(prog)s --days 3                 # 分析最近3天
  %(prog)s --topic "人工智能"        # 分析指定主题
  %(prog)s --format markdown --output report.md   # Markdown输出
  %(prog)s --format json --output report.json     # JSON输出

环境变量:
  IWENCAI_API_KEY    iwencai API密钥（必填）
        """
    )
    parser.add_argument("--days", type=int, default=7, help="分析最近多少天 (默认: 7)")
    parser.add_argument("--topic", type=str, default=None, help="指定主题 (默认: 全市场)")
    parser.add_argument("--format", choices=["json", "markdown"], default="json", help="输出格式")
    parser.add_argument("--output", type=str, default=None, help="输出文件路径")
    parser.add_argument("--min-articles", type=int, default=10, help="最少文章数")
    parser.add_argument("--api-key", type=str, default=None, help="API密钥")
    parser.add_argument("--debug", action="store_true", help="调试模式")

    args = parser.parse_args()
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    try:
        analyzer = NewsAnalyzer(api_key=args.api_key)
        report = analyzer.analyze_recent_news(
            topic=args.topic, days=args.days, min_articles=args.min_articles
        )

        if args.format == "markdown":
            output = report_to_markdown(report)
        else:
            output = json.dumps(report, ensure_ascii=False, indent=2)

        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(output)
            logger.info(f"报告已保存: {args.output}")
        else:
            print(output)

    except ValueError as e:
        logger.error(f"参数错误: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"分析失败: {e}")
        if args.debug:
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
