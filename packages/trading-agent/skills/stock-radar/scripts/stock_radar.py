#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
个股机会风险雷达 V2
扫描A股全市场股票，分析最近两周新闻和未来两周事件对个股的影响。

数据源混合策略（降低iwencai API消耗）：
- 事件数据：iwencai query2data（高管增减持、业绩预告、限售解禁、定增）
- 全市场新闻：财联社快讯(cls.cn) + 东财全球资讯(eastmoney) — 免费API
- 个股新闻补充：东财个股新闻(search-api-web) — 免费JSONP
- iwencai新闻：仅作为后备/补充
"""

import os
import sys
import json
import re
import logging
import argparse
import secrets
import time
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 配置与常量
# ---------------------------------------------------------------------------

IWENCAI_BASE = "https://openapi.iwencai.com"
API_KEY = os.environ.get("IWENCAI_API_KEY")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

EVENT_SCORES = {
    "高管增持": 3, "高管减持": -3,
    "大股东增持": 2, "大股东减持": -3,
    "业绩预告预增": 3, "业绩预告预盈": 3, "业绩预告扭亏": 3,
    "业绩预告预亏": -3, "业绩预告预降": -2, "业绩预告预减": -2,
    "限售解禁": -2, "定增": -1, "非公开发行": -1,
    "股权激励": 1, "回购": 2,
    "重大资产重组": 1, "并购重组": 1,
    "重大合同": 2, "中标": 2, "获批": 2,
    "股东增持": 2, "股东减持": -2,
    "机构调研": 1, "分红": 1, "送转": 0,
    "配股": -1, "可转债": 1,
    "减持计划": -2, "减持完毕": -1,
    "增持计划": 2, "增持完毕": 1,
}

# 扫描范围（universe）对应的 iwencai query
UNIVERSE_QUERIES = {
    "all": None,           # 全市场，不限制
    "zz1000": "中证1000成分股",
    "zz500": "中证500成分股",
    "hs300": "沪深300成分股",
    "cyb": "创业板成分股",
    "kcb": "科创板成分股",
}

NEWS_SENTIMENT_POSITIVE = {
    "利好", "上涨", "涨停", "突破", "超预期", "订单饱满", "业绩暴增",
    "获批", "中标", "签约", "合作", "扩张", "并购", "重组", "创新高",
    "强势", "反弹", "回暖", "复苏", "景气", "龙头", "国产替代",
    "自主可控", "技术突破", "政策扶持", "买入", "增持", "推荐",
}
NEWS_SENTIMENT_NEGATIVE = {
    "利空", "下跌", "跌停", "暴跌", "不及预期", "监管", "处罚", "暴雷",
    "踩雷", "亏损", "预亏", "下滑", "裁员", "关停", "债务违约",
    "问询函", "立案", "造假", "违规", "操纵", "减持", "套现",
    "破发", "破净", "泡沫", "回调", "下行", "低迷", "恶化",
}

# ---------------------------------------------------------------------------
# iwencai API 封装（仅用于事件数据）
# ---------------------------------------------------------------------------

def _build_headers(call_type: str = "normal", skill_id: str = "stock-radar") -> dict:
    if not API_KEY:
        raise ValueError("IWENCAI_API_KEY not set")
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json; charset=utf-8",
        "X-Claw-Call-Type": call_type,
        "X-Claw-Skill-Id": skill_id,
        "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": secrets.token_hex(32),
    }


def _iwencai_query2data(query: str, page: str = "1", limit: str = "500", max_retries: int = 3) -> dict:
    import requests
    payload = {"query": query, "page": page, "limit": limit, "is_cache": "1", "expand_index": "true"}
    url = f"{IWENCAI_BASE}/v1/query2data"
    for attempt in range(max_retries):
        try:
            resp = requests.post(url, json=payload, headers=_build_headers(), timeout=30)
            data = resp.json()
            if data.get("status_code", 0) != 0:
                logger.warning(f"iwencai query2data error: {data.get('status_msg', '')}")
            return data
        except Exception as e:
            logger.warning(f"iwencai request failed (attempt {attempt+1}): {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
    return {"success": False, "error": "max retries exceeded"}


# ---------------------------------------------------------------------------
# 免费新闻 API（东财 + 财联社）
# ---------------------------------------------------------------------------

def fetch_cls_telegraph(page_size: int = 100) -> List[Dict]:
    """财联社电报（全市场实时快讯）— 免费，无需鉴权"""
    import requests
    try:
        url = "https://www.cls.cn/nodeapi/telegraphList"
        params = {"rn": str(page_size), "page": "1"}
        headers = {"User-Agent": UA, "Referer": "https://www.cls.cn/"}
        r = requests.get(url, params=params, headers=headers, timeout=15)
        d = r.json()
        rows = []
        for item in d.get("data", {}).get("roll_data", []):
            title = item.get("title", "") or item.get("brief", "")
            content = item.get("content", "") or item.get("brief", "")
            ctime = item.get("ctime", "")
            # 格式化时间
            time_str = ""
            if ctime:
                try:
                    dt = datetime.fromtimestamp(int(ctime))
                    time_str = dt.strftime("%Y-%m-%d %H:%M:%S")
                    if dt < datetime.now() - timedelta(days=14):
                        continue
                except (ValueError, TypeError):
                    time_str = str(ctime)
            rows.append({"title": title, "content": content, "time": time_str, "source": "财联社"})
        logger.info(f"财联社电报: {len(rows)} 条")
        return rows
    except Exception as e:
        logger.warning(f"财联社电报获取失败: {e}")
        return []


def fetch_eastmoney_global_news(page_size: int = 100) -> List[Dict]:
    """东财全球资讯（7x24）— 免费，无需鉴权"""
    import requests
    try:
        url = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList"
        params = {
            "client": "web", "biz": "web_724", "fastColumn": "102",
            "sortEnd": "", "pageSize": str(page_size),
            "req_trace": str(int(time.time() * 1000)),
        }
        headers = {"User-Agent": UA, "Referer": "https://kuaixun.eastmoney.com/"}
        r = requests.get(url, params=params, headers=headers, timeout=15)
        d = r.json()
        rows = []
        data_obj = d.get("data") or {}
        if isinstance(data_obj, dict):
            for item in data_obj.get("fastNewsList", []):
                show_time = item.get("showTime", "")
                # 东财时间格式: 2026-05-28 10:30:00
                if show_time:
                    try:
                        dt = datetime.strptime(show_time, "%Y-%m-%d %H:%M:%S")
                        if dt < datetime.now() - timedelta(days=14):
                            continue
                    except (ValueError, TypeError):
                        pass
                rows.append({
                    "title": item.get("title", ""),
                    "content": item.get("summary", "")[:200],
                    "time": show_time,
                    "source": "东财全球资讯",
                })
        logger.info(f"东财全球资讯: {len(rows)} 条")
        return rows
    except Exception as e:
        logger.warning(f"东财全球资讯获取失败: {e}")
        return []


def fetch_eastmoney_stock_news(code: str, page_size: int = 20) -> List[Dict]:
    """东财个股新闻（JSONP）— 免费，按代码查询"""
    import requests
    try:
        cb = "jQuery_news"
        url = "https://search-api-web.eastmoney.com/search/jsonp"
        inner_params = json.dumps({
            "uid": "", "keyword": code, "type": ["cmsArticleWebOld"], "client": "web",
            "clientType": "web", "clientVersion": "curr",
            "param": {"cmsArticleWebOld": {"searchScope": "default", "sort": "default",
                      "pageIndex": 1, "pageSize": page_size, "preTag": "", "postTag": ""}},
        }, separators=(',', ':'))
        params = {"cb": cb, "param": inner_params}
        headers = {"User-Agent": UA, "Referer": "https://so.eastmoney.com/"}
        r = requests.get(url, params=params, headers=headers, timeout=15)
        text = r.text
        json_str = text[text.index("(") + 1: text.rindex(")")]
        d = json.loads(json_str)
        rows = []
        for a in d.get("result", {}).get("cmsArticleWebOld", {}).get("list", []):
            date_str = a.get("date", "")
            if date_str:
                try:
                    dt = datetime.strptime(date_str[:10], "%Y-%m-%d")
                    if dt < datetime.now() - timedelta(days=14):
                        continue
                except (ValueError, TypeError):
                    pass
            rows.append({
                "title": re.sub(r'<[^>]+>', '', a.get("title", "")),
                "content": re.sub(r'<[^>]+>', '', a.get("content", ""))[:200],
                "time": date_str,
                "source": a.get("mediaName", "东方财富"),
                "url": a.get("url", ""),
            })
        return rows
    except Exception as e:
        logger.warning(f"东财个股新闻获取失败 {code}: {e}")
        return []


# ---------------------------------------------------------------------------
# 股票列表 & 事件数据
# ---------------------------------------------------------------------------

def _fetch_all_stocks_from_eastmoney_api() -> List[Dict[str, str]]:
    """通过东财API直接获取A股列表（akshare失败时的fallback）"""
    import requests
    url = "https://82.push2.eastmoney.com/api/qt/clist/get"
    params = {
        "pn": "1", "pz": "10000", "po": "1", "np": "1",
        "fltt": "2", "invt": "2", "fid": "f12",
        "fs": "m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:2,m:1+t:23,m:1+t:88",
        "fields": "f12,f14",
    }
    headers = {
        "User-Agent": UA,
        "Referer": "https://quote.eastmoney.com/",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    session = requests.Session()
    for attempt in range(3):
        try:
            r = session.get(url, params=params, headers=headers, timeout=30)
            data = r.json()
            stocks = []
            for item in data.get("data", {}).get("diff", []):
                code = str(item.get("f12", "")).strip()
                name = str(item.get("f14", "")).strip()
                if not code or len(code) != 6 or not code.isdigit():
                    continue
                market = 1 if code.startswith(("6", "9")) else 0
                stocks.append({"code": code, "name": name, "market": market})
            return stocks
        except Exception as e:
            logger.warning(f"东财API尝试 {attempt+1}/3 失败: {e}")
            if attempt < 2:
                time.sleep(2 ** attempt)
    return []


def _fetch_all_stocks_from_tencent_api() -> List[Dict[str, str]]:
    """通过腾讯API获取部分热门A股（最后的fallback）"""
    # 内置常用A股列表（约120只，覆盖各板块龙头，用于API不可用时降级）
    common_stocks = [
        # 白酒/消费
        ("600519", "贵州茅台", 1), ("000858", "五粮液", 0), ("600809", "山西汾酒", 1),
        ("000568", "泸州老窖", 0), ("002304", "洋河股份", 0), ("600887", "伊利股份", 1),
        ("603288", "海天味业", 1), ("600600", "青岛啤酒", 1),
        # 金融
        ("601318", "中国平安", 1), ("600036", "招商银行", 1), ("000001", "平安银行", 0),
        ("601398", "工商银行", 1), ("601288", "农业银行", 1), ("601939", "建设银行", 1),
        ("601988", "中国银行", 1), ("600030", "中信证券", 1), ("300059", "东方财富", 0),
        ("601628", "中国人寿", 1), ("601336", "新华保险", 1),
        # 医药
        ("600276", "恒瑞医药", 1), ("000538", "云南白药", 0), ("603259", "药明康德", 1),
        ("300760", "迈瑞医疗", 0), ("600436", "片仔癀", 1), ("000963", "华东医药", 0),
        ("300122", "智飞生物", 0), ("688180", "君实生物", 1), ("688235", "百济神州", 1),
        ("600085", "同仁堂", 1),
        # 新能源/汽车
        ("002594", "比亚迪", 0), ("300750", "宁德时代", 0), ("601012", "隆基绿能", 1),
        ("300274", "阳光电源", 0), ("002460", "赣锋锂业", 0), ("002466", "天齐锂业", 0),
        ("600893", "航发动力", 1), ("000768", "中航西飞", 0),
        # 科技/电子
        ("002415", "海康威视", 0), ("000725", "京东方A", 0), ("002230", "科大讯飞", 0),
        ("688981", "中芯国际", 1), ("688012", "中微公司", 1), ("688008", "澜起科技", 1),
        ("603501", "韦尔股份", 1), ("002371", "北方华创", 0), ("300782", "卓胜微", 0),
        ("688396", "华润微", 1), ("688126", "沪硅产业", 1), ("688256", "寒武纪", 1),
        ("688047", "龙芯中科", 1), ("688521", "芯原股份", 1), ("688536", "思瑞浦", 1),
        ("688599", "天合光能", 1), ("688223", "晶科能源", 1),
        # 制造/工业
        ("000333", "美的集团", 0), ("000651", "格力电器", 0), ("600690", "海尔智家", 1),
        ("601766", "中国中车", 1), ("601100", "恒立液压", 1), ("600031", "三一重工", 1),
        ("601669", "中国电建", 1), ("601668", "中国建筑", 1), ("601390", "中国中铁", 1),
        ("601618", "中国中冶", 1), ("601868", "中国能建", 1), ("601611", "中国核建", 1),
        # 资源/化工
        ("600028", "中国石化", 1), ("601857", "中国石油", 1), ("600900", "长江电力", 1),
        ("601088", "中国神华", 1), ("601899", "紫金矿业", 1), ("603993", "洛阳钼业", 1),
        ("002460", "赣锋锂业", 0), ("002738", "中矿资源", 0), ("600547", "山东黄金", 1),
        ("600426", "华鲁恒升", 1), ("002812", "恩捷股份", 0),
        # 通信/互联网
        ("601728", "中国电信", 1), ("600050", "中国联通", 1), ("600941", "中国移动", 1),
        ("601138", "工业富联", 1), ("603019", "中科曙光", 1), ("000938", "紫光股份", 0),
        ("002236", "大华股份", 0), ("300433", "蓝思科技", 0),
        # 交运/基建
        ("601816", "京沪高铁", 1), ("600009", "上海机场", 1), ("600115", "中国东航", 1),
        ("601111", "中国国航", 1), ("000429", "粤高速A", 0),
        # 其他
        ("601888", "中国中免", 1), ("002027", "分众传媒", 0), ("300413", "芒果超媒", 0),
        ("002352", "顺丰控股", 0), ("601919", "中远海控", 1), ("600026", "中远海能", 1),
        ("603288", "海天味业", 1), ("600298", "安琪酵母", 1), ("002714", "牧原股份", 0),
        ("603477", "巨星农牧", 1), ("002840", "华统股份", 0), ("000785", "居然智家", 0),
        ("002839", "张家港行", 0), ("300131", "英唐智控", 0), ("301101", "明月镜片", 0),
        ("603109", "神驰机电", 1), ("301571", "国科天成", 0), ("300486", "东杰智能", 0),
        ("600199", "金种子酒", 1), ("002713", "*ST东易", 0), ("603110", "东方材料", 1),
        ("603351", "威尔药业", 1), ("688603", "天承科技", 1), ("688717", "艾罗能源", 1),
        ("688729", "屹唐股份", 1), ("688766", "普冉股份", 1), ("688778", "厦钨新能", 1),
        ("688820", "盛合晶微", 1), ("688136", "科兴制药", 1), ("688247", "宣泰医药", 1),
        ("688512", "慧智微", 1), ("600746", "江苏索普", 1), ("920058", "华洋赛车", 0),
        ("603439", "三力制药", 1), ("605268", "王力安防", 1), ("688530", "欧莱新材", 1),
        ("002219", "新里程", 0), ("300984", "金沃股份", 0), ("002858", "力盛体育", 0),
        ("001237", "惠康科技", 0), ("002319", "乐通股份", 0), ("301300", "远翔新材", 0),
        ("600933", "爱柯迪", 1), ("603014", "威高血净", 1), ("605589", "圣泉集团", 1),
        ("688361", "中科飞测", 1),
    ]
    stocks = [{"code": c, "name": n, "market": m} for c, n, m in common_stocks]
    logger.warning(f"使用内置股票列表（{len(stocks)}只，API不可用时降级）")
    return stocks


def fetch_all_stocks() -> List[Dict[str, str]]:
    """获取全市场A股列表"""
    # 尝试 akshare
    try:
        import akshare as ak
        df = ak.stock_zh_a_spot_em()
        stocks = []
        for _, row in df.iterrows():
            code = str(row.get("代码", "")).strip()
            name = str(row.get("名称", "")).strip()
            if not code or len(code) != 6:
                continue
            market = 1 if code.startswith(("6", "9")) else 0
            stocks.append({"code": code, "name": name, "market": market})
        logger.info(f"获取A股列表 (akshare): {len(stocks)} 只")
        return stocks
    except Exception as e:
        logger.warning(f"akshare获取失败，尝试东财API: {e}")

    # fallback 1: 东财API
    try:
        stocks = _fetch_all_stocks_from_eastmoney_api()
        if stocks:
            logger.info(f"获取A股列表 (东财API): {len(stocks)} 只")
            return stocks
    except Exception as e:
        logger.warning(f"东财API获取失败: {e}")

    # fallback 2: 内置测试列表
    stocks = _fetch_all_stocks_from_tencent_api()
    if stocks:
        return stocks

    logger.error("获取A股列表失败: 所有数据源均不可用")
    return []


def fetch_universe_stocks(universe: str) -> List[Dict[str, str]]:
    """获取指定范围（universe）的股票列表。all=全市场，其他通过iwencai查询成分股。"""
    if universe == "all" or universe not in UNIVERSE_QUERIES:
        return fetch_all_stocks()

    query = UNIVERSE_QUERIES[universe]
    logger.info(f"获取扫描范围: {universe} (iwencai: {query})...")
    result = _iwencai_query2data(query, limit="1500")
    stocks = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        name = row.get("股票简称", row.get("名称", ""))
        market = 1 if code.startswith(("6", "9")) else 0
        stocks.append({"code": code, "name": name, "market": market})
    logger.info(f"  -> {universe} 成分股: {len(stocks)} 只")
    return stocks


def _extract_code(row: dict) -> Optional[str]:
    for key in ["股票代码", "代码"]:
        val = str(row.get(key, ""))
        if val:
            code = val.split(".")[0] if "." in val else val
            code = code.zfill(6)
            if len(code) == 6 and code.isdigit():
                return code
    return None


def fetch_executive_changes() -> List[Dict]:
    logger.info("获取高管增减持...")
    result = _iwencai_query2data("近期高管增减持", limit="500")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        change_type = row.get("变动类型", "")
        score = EVENT_SCORES.get("高管增持" if "增持" in change_type else "高管减持", 0)
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": f"高管{change_type}", "date": str(row.get("变动日期", ""))[:10],
            "description": f"{row.get('变动人', '')} {change_type} {row.get('变动股数', '')}股",
            "score": score, "category": "executive_change",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_earnings_forecast() -> List[Dict]:
    logger.info("获取业绩预告...")
    result = _iwencai_query2data("近期业绩预告", limit="500")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        forecast_type = row.get("预告类型", "")
        score = 0
        if any(kw in forecast_type for kw in ["预增", "预盈", "扭亏"]):
            score = 3
        elif any(kw in forecast_type for kw in ["预亏", "预降", "预减"]):
            score = -3
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": f"业绩预告:{forecast_type}", "date": str(row.get("预告日期", ""))[:10],
            "description": f"预告类型: {forecast_type}; 净利润变动: {row.get('净利润变动幅度', '')}%",
            "score": score, "category": "earnings",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_unlocks() -> List[Dict]:
    logger.info("获取限售解禁...")
    result = _iwencai_query2data("近期限售解禁", limit="500")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": "限售解禁", "date": str(row.get("解禁日期", ""))[:10],
            "description": f"解禁数量: {row.get('解禁数量', '-')}万股; 解禁市值: {row.get('解禁市值', '-')}万元",
            "score": EVENT_SCORES["限售解禁"], "category": "unlock",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def _build_clean_description(row: dict, skip_keys: List[str]) -> str:
    """从iwencai行数据构建简洁描述，过滤掉价格等冗余字段"""
    skip_keys = set(skip_keys + ["股票代码", "股票简称", "最新价", "最新涨跌幅", "a股市值(不含限售股)", "a股市值(含限售股)"])
    parts = []
    for k, v in row.items():
        if k in skip_keys or not v or str(v).strip() == "-":
            continue
        parts.append(f"{k}: {v}")
    desc = "; ".join(parts)[:120]
    return desc if desc else "该股近期有相关公告"


def fetch_private_placement() -> List[Dict]:
    logger.info("获取定增...")
    result = _iwencai_query2data("近期定向增发", limit="300")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        purpose = row.get("目的", "")
        progress = row.get("进度", "")
        amount = row.get("预案募集金额", "")
        desc = f"目的: {purpose}; 进度: {progress}"
        if amount:
            desc += f"; 预案募集: {amount}"
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": "定向增发", "date": str(row.get("公告日期", row.get("日期", "")))[:10],
            "description": desc, "score": EVENT_SCORES["定增"], "category": "placement",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_major_contracts() -> List[Dict]:
    logger.info("获取重大合同...")
    result = _iwencai_query2data("近期重大合同", limit="200")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        desc = _build_clean_description(row, ["最新价", "最新涨跌幅"])
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": "重大合同", "date": str(row.get("公告日期", row.get("日期", "")))[:10],
            "description": desc, "score": EVENT_SCORES["重大合同"], "category": "contract",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_buybacks() -> List[Dict]:
    """回购"""
    logger.info("获取回购...")
    result = _iwencai_query2data("近期回购", limit="300")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        desc = _build_clean_description(row, ["最新价", "最新涨跌幅"])
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": "回购", "date": str(row.get("公告日期", row.get("日期", "")))[:10],
            "description": desc, "score": EVENT_SCORES["回购"], "category": "buyback",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_equity_incentive() -> List[Dict]:
    """股权激励"""
    logger.info("获取股权激励...")
    result = _iwencai_query2data("近期股权激励", limit="300")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        desc = _build_clean_description(row, ["最新价", "最新涨跌幅"])
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": "股权激励", "date": str(row.get("公告日期", row.get("日期", "")))[:10],
            "description": desc, "score": EVENT_SCORES["股权激励"], "category": "incentive",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_institutional_research() -> List[Dict]:
    """机构调研"""
    logger.info("获取机构调研...")
    result = _iwencai_query2data("近期机构调研", limit="500")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        desc = _build_clean_description(row, ["最新价", "最新涨跌幅"])
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": "机构调研", "date": str(row.get("调研日期", row.get("日期", "")))[:10],
            "description": desc, "score": EVENT_SCORES["机构调研"], "category": "research",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_shareholder_changes() -> List[Dict]:
    """大股东增减持（与高管增减持互补）"""
    logger.info("获取大股东增减持...")
    result = _iwencai_query2data("近期大股东增减持", limit="300")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        change_type = row.get("变动类型", "")
        score = EVENT_SCORES.get("大股东增持" if "增持" in change_type else "大股东减持", 0)
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": f"大股东{change_type}", "date": str(row.get("变动日期", ""))[:10],
            "description": f"{row.get('变动人', '')} {change_type} {row.get('变动股数', '')}股",
            "score": score, "category": "shareholder_change",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


def fetch_reduction_plans() -> List[Dict]:
    """减持计划（预披露）"""
    logger.info("获取减持计划...")
    result = _iwencai_query2data("近期减持计划", limit="300")
    events = []
    for row in result.get("datas", []):
        code = _extract_code(row)
        if not code:
            continue
        desc = _build_clean_description(row, ["最新价", "最新涨跌幅"])
        events.append({
            "code": code, "name": row.get("股票简称", ""),
            "type": "减持计划", "date": str(row.get("公告日期", row.get("日期", "")))[:10],
            "description": desc, "score": EVENT_SCORES["减持计划"], "category": "reduction_plan",
        })
    logger.info(f"  -> {len(events)} 条")
    return events


# ---------------------------------------------------------------------------
# 新闻分析
# ---------------------------------------------------------------------------

def analyze_news_sentiment(text: str) -> Tuple[str, float]:
    """分析新闻情感"""
    pos = sum(1 for w in NEWS_SENTIMENT_POSITIVE if w in text)
    neg = sum(1 for w in NEWS_SENTIMENT_NEGATIVE if w in text)
    total = pos + neg
    if total == 0:
        return "neutral", 0.0
    ratio = (pos - neg) / total
    if ratio > 0.2:
        return "positive", min(ratio * 3, 3.0)
    elif ratio < -0.2:
        return "negative", max(ratio * 3, -3.0)
    return "neutral", 0.0


def extract_stocks_from_news(articles: List[Dict], stocks: List[Dict] = None) -> Dict[str, List[Dict]]:
    """从新闻中提取涉及的股票（支持代码匹配和名称匹配）"""
    stock_news = defaultdict(list)
    # 构建名称->代码映射
    name_to_code = {}
    if stocks:
        for s in stocks:
            name = s.get("name", "")
            if name and len(name) >= 2:
                name_to_code[name] = s["code"]
    for article in articles:
        title = article.get("title", "")
        content = article.get("content", "")
        text = title + " " + content
        codes = set()
        # 方式1: 正则匹配6位代码
        matched = re.findall(r'(?:sh|sz|bj)?(\d{6})', text)
        for c in matched:
            if c.startswith(('60', '68', '90', '00', '30', '43', '83', '87', '92')):
                codes.add(c)
        # 方式2: 股票名称匹配
        if name_to_code:
            for name, code in name_to_code.items():
                if name in text:
                    codes.add(code)
        if not codes:
            continue
        sentiment, score = analyze_news_sentiment(text)
        for code in codes:
            stock_news[code].append({
                "title": title[:100], "date": str(article.get("time", ""))[:10],
                "sentiment": sentiment, "score": round(score, 2),
                "source": article.get("source", ""),
            })
    return dict(stock_news)


# ---------------------------------------------------------------------------
# 雷达构建
# ---------------------------------------------------------------------------

def build_radar(stocks: List[Dict], events: List[Dict], stock_news: Dict[str, List[Dict]]) -> Dict[str, Dict]:
    """事件驱动雷达构建：只处理有事件或新闻的股票，不再遍历全市场。
    如果 stocks 不是全市场（有universe限制），则只保留在universe范围内的股票。"""
    radar = {}
    # 构建代码->名称映射（优先用universe列表，再用事件/新闻数据补充）
    stock_map = {s["code"]: s["name"] for s in stocks}
    # universe 代码集合（用于范围过滤）
    universe_codes = {s["code"] for s in stocks}
    is_limited_universe = len(universe_codes) < 1000  # 全市场通常5000+，指数成分股才几百~几千

    # 收集所有"有动静"的股票代码（来自事件 + 新闻）
    active_codes = set()
    for ev in events:
        code = ev["code"]
        # 如果有限定universe，过滤掉不在范围内的
        if is_limited_universe and code not in universe_codes:
            continue
        active_codes.add(code)
        if code not in stock_map and ev.get("name"):
            stock_map[code] = ev["name"]
    for code in stock_news.keys():
        if is_limited_universe and code not in universe_codes:
            continue
        active_codes.add(code)

    logger.info(f"事件驱动: 共 {len(active_codes)} 只股票有事件/新闻（跳过无动静股票）")

    # 只为有事件/新闻的股票创建条目
    for code in active_codes:
        radar[code] = {
            "code": code, "name": stock_map.get(code, ""),
            "score": 0, "event_count": 0, "news_count": 0,
            "events": [], "news": [],
        }

    # 填充事件
    for ev in events:
        code = ev["code"]
        if code not in radar:
            continue
        radar[code]["score"] += ev["score"]
        radar[code]["event_count"] += 1
        radar[code]["events"].append({
            "type": ev["type"], "date": ev.get("date", ""),
            "description": ev.get("description", ""),
            "score": ev["score"], "category": ev.get("category", ""),
        })

    # 填充新闻
    for code, news_list in stock_news.items():
        if code not in radar:
            continue
        for n in news_list:
            radar[code]["score"] += n["score"]
            radar[code]["news_count"] += 1
            radar[code]["news"].append(n)

    # 计算方向
    for data in radar.values():
        s = data["score"]
        if s >= 3:
            data["direction"] = "强烈利好"
        elif s >= 1:
            data["direction"] = "利好"
        elif s <= -3:
            data["direction"] = "强烈利空"
        elif s <= -1:
            data["direction"] = "利空"
        else:
            data["direction"] = "中性"
    return radar


def filter_active_radar(radar: Dict[str, Dict], min_score_abs: float = 0.5) -> Dict[str, Dict]:
    """过滤：只保留分数达到阈值或有结构化事件的股票（纯新闻0分也保留，因为已被事件驱动筛选过）。"""
    return {k: v for k, v in radar.items() if abs(v["score"]) >= min_score_abs or v["event_count"] > 0 or v["news_count"] > 0}


# ---------------------------------------------------------------------------
# 个股新闻补充（对重点股票）
# ---------------------------------------------------------------------------

def enrich_top_stocks_with_news(radar: Dict[str, Dict], top_n: int = 20) -> Dict[str, Dict]:
    """对机会榜和风险榜TOP股票，用东财个股新闻补充"""
    sorted_radar = sorted(radar.values(), key=lambda x: abs(x["score"]), reverse=True)
    top_codes = [r["code"] for r in sorted_radar[:top_n]]
    logger.info(f"对TOP {len(top_codes)} 只个股补充东财新闻...")
    for code in top_codes:
        try:
            news = fetch_eastmoney_stock_news(code, page_size=10)
            if not news:
                continue
            for n in news:
                # 去重：标题是否已存在
                existing_titles = [x["title"] for x in radar[code]["news"]]
                if n["title"] in existing_titles:
                    continue
                sentiment, score = analyze_news_sentiment(n["title"] + " " + n["content"])
                radar[code]["news"].append({
                    "title": n["title"][:100], "date": n["time"][:10],
                    "sentiment": sentiment, "score": round(score, 2),
                    "source": n["source"],
                })
                radar[code]["score"] += score
                radar[code]["news_count"] += 1
            time.sleep(0.5)  # 礼貌延迟
        except Exception as e:
            logger.warning(f"补充个股新闻失败 {code}: {e}")
    # 重新计算方向
    for data in radar.values():
        s = data["score"]
        if s >= 3:
            data["direction"] = "强烈利好"
        elif s >= 1:
            data["direction"] = "利好"
        elif s <= -3:
            data["direction"] = "强烈利空"
        elif s <= -1:
            data["direction"] = "利空"
        else:
            data["direction"] = "中性"
    return radar


# ---------------------------------------------------------------------------
# 报告生成
# ---------------------------------------------------------------------------

def generate_markdown_report(radar: Dict[str, Dict], top_n: int = 30) -> str:
    sorted_radar = sorted(radar.values(), key=lambda x: x["score"], reverse=True)
    opportunity = [r for r in sorted_radar if r["score"] >= 1][:top_n]
    risk = [r for r in sorted_radar if r["score"] <= -1][:top_n]

    lines = []
    lines.append("# A股个股机会风险雷达\n")
    lines.append(f"**报告时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"**扫描股票数**: {len(radar)}")
    lines.append(f"**机会股数**: {len(opportunity)} | **风险股数**: {len(risk)}\n")

    lines.append("## 机会榜 TOP{}\n".format(top_n))
    lines.append("| 排名 | 代码 | 名称 | 总评分 | 事件数 | 新闻数 | 方向 |")
    lines.append("|------|------|------|--------|--------|--------|------|")
    for i, r in enumerate(opportunity, 1):
        lines.append(f"| {i} | {r['code']} | {r['name']} | **+{r['score']:.1f}** | {r['event_count']} | {r['news_count']} | {r['direction']} |")
    lines.append("")

    for r in opportunity[:10]:
        lines.append(f"### {r['code']} {r['name']} (评分: +{r['score']:.1f})\n")
        if r["events"]:
            lines.append("**事件**:")
            for ev in r["events"]:
                marker = "[+]" if ev["score"] > 0 else ("[-]" if ev["score"] < 0 else "[ ]")
                lines.append(f"- {marker} [{ev['date']}] {ev['type']} (评分: {ev['score']:+d}) -- {ev['description']}")
            lines.append("")
        if r["news"]:
            lines.append("**新闻**:")
            for n in r["news"][:5]:
                marker = "[+]" if n["sentiment"] == "positive" else ("[-]" if n["sentiment"] == "negative" else "[~]")
                lines.append(f"- {marker} [{n['date']}] {n['source']} | {n['title'][:60]}... (评分: {n['score']:+.1f})")
            lines.append("")

    lines.append("## 风险榜 TOP{}\n".format(top_n))
    lines.append("| 排名 | 代码 | 名称 | 总评分 | 事件数 | 新闻数 | 方向 |")
    lines.append("|------|------|------|--------|--------|--------|------|")
    for i, r in enumerate(risk, 1):
        lines.append(f"| {i} | {r['code']} | {r['name']} | **{r['score']:.1f}** | {r['event_count']} | {r['news_count']} | {r['direction']} |")
    lines.append("")

    for r in risk[:10]:
        lines.append(f"### {r['code']} {r['name']} (评分: {r['score']:.1f})\n")
        if r["events"]:
            lines.append("**事件**:")
            for ev in r["events"]:
                marker = "[+]" if ev["score"] > 0 else ("[-]" if ev["score"] < 0 else "[ ]")
                lines.append(f"- {marker} [{ev['date']}] {ev['type']} (评分: {ev['score']:+d}) -- {ev['description']}")
            lines.append("")
        if r["news"]:
            lines.append("**新闻**:")
            for n in r["news"][:5]:
                marker = "[+]" if n["sentiment"] == "positive" else ("[-]" if n["sentiment"] == "negative" else "[~]")
                lines.append(f"- {marker} [{n['date']}] {n['source']} | {n['title'][:60]}... (评分: {n['score']:+.1f})")
            lines.append("")

    lines.append("---\n")
    lines.append("*免责声明: 本报告基于公开数据自动生成，仅供参考，不构成投资建议。*")
    return "\n".join(lines)


def generate_json_report(radar: Dict[str, Dict], top_n: int = 30) -> dict:
    sorted_radar = sorted(radar.values(), key=lambda x: x["score"], reverse=True)
    return {
        "meta": {
            "report_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "total_stocks_scanned": len(radar),
            "opportunity_count": len([r for r in sorted_radar if r["score"] >= 1]),
            "risk_count": len([r for r in sorted_radar if r["score"] <= -1]),
        },
        "opportunity_top": [r for r in sorted_radar if r["score"] >= 1][:top_n],
        "risk_top": [r for r in sorted_radar if r["score"] <= -1][:top_n],
    }


# ---------------------------------------------------------------------------
# 缓存与增量更新
# ---------------------------------------------------------------------------

CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DAYS = 14


def _cache_path(date_str: str) -> Path:
    return CACHE_DIR / f"radar_daily_{date_str}.json"


def _load_cached_data(days: int = CACHE_DAYS) -> Tuple[List[Dict], List[Dict]]:
    """加载最近N天的缓存数据（含今天），返回 (events, articles)"""
    all_events = []
    all_articles = []
    for i in range(days):
        date_str = (datetime.now() - timedelta(days=i)).strftime("%Y%m%d")
        cache_file = _cache_path(date_str)
        if not cache_file.exists():
            continue
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            all_events.extend(data.get("events", []))
            all_articles.extend(data.get("articles", []))
            logger.debug(f"加载缓存 {date_str}: {len(data.get('events', []))} 事件, {len(data.get('articles', []))} 新闻")
        except Exception as e:
            logger.warning(f"加载缓存失败 {date_str}: {e}")
    logger.info(f"从缓存加载: {len(all_events)} 事件, {len(all_articles)} 新闻")
    return all_events, all_articles


def _save_daily_cache(events: List[Dict], articles: List[Dict]) -> None:
    """保存当天数据到缓存"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y%m%d")
    cache_file = _cache_path(today)
    try:
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({"events": events, "articles": articles, "saved_at": datetime.now().isoformat()}, f, ensure_ascii=False)
        logger.info(f"当天数据已缓存: {cache_file}")
    except Exception as e:
        logger.warning(f"缓存保存失败: {e}")


def _cleanup_old_cache(days: int = CACHE_DAYS) -> None:
    """清理超过N天的缓存"""
    if not CACHE_DIR.exists():
        return
    cutoff = datetime.now() - timedelta(days=days)
    for f in CACHE_DIR.glob("radar_daily_*.json"):
        try:
            date_str = f.stem.replace("radar_daily_", "")
            file_date = datetime.strptime(date_str, "%Y%m%d")
            if file_date < cutoff:
                f.unlink()
                logger.debug(f"清理旧缓存: {f.name}")
        except Exception:
            pass


def _dedup_events(events: List[Dict]) -> List[Dict]:
    """按(code, type, date, description)去重事件"""
    seen = set()
    result = []
    for ev in events:
        key = (ev.get("code"), ev.get("type"), ev.get("date"), ev.get("description"))
        if key not in seen:
            seen.add(key)
            result.append(ev)
    return result


def _dedup_articles(articles: List[Dict]) -> List[Dict]:
    """按title去重新闻"""
    seen = set()
    result = []
    for a in articles:
        key = a.get("title", "")
        if key and key not in seen:
            seen.add(key)
            result.append(a)
    return result


# ---------------------------------------------------------------------------
# 主程序
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="A股个股机会风险雷达 V3 - 事件驱动（iwencai+东财+财联社）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s                           # 默认扫描（事件驱动，全市场）
  %(prog)s --universe zz1000         # 只扫描中证1000成分股
  %(prog)s --incremental             # 增量模式（加载缓存+只采当天）
  %(prog)s --top 50 --format md      # 输出前50名，Markdown
  %(prog)s --output radar.json       # 保存JSON
  %(prog)s --enrich 30               # 对TOP30补充个股新闻

环境变量:
  IWENCAI_API_KEY    iwencai API密钥（事件数据需要）
        """
    )
    parser.add_argument("--top", type=int, default=30, help="机会/风险榜各显示多少只 (默认: 30)")
    parser.add_argument("--format", choices=["json", "markdown", "md"], default="markdown", help="输出格式")
    parser.add_argument("--output", type=str, default=None, help="输出文件路径")
    parser.add_argument("--min-score", type=float, default=0.5, help="最小绝对评分过滤 (默认: 0.5)")
    parser.add_argument("--enrich", type=int, default=20, help="对TOP N个股补充东财个股新闻 (默认: 20, 0=关闭)")
    parser.add_argument("--incremental", action="store_true", help="增量模式：加载历史缓存，只获取当天新数据")
    parser.add_argument("--no-cache", action="store_true", help="不保存缓存（增量模式时仍读取已有缓存）")
    parser.add_argument("--debug", action="store_true", help="调试模式")
    parser.add_argument("--universe", choices=list(UNIVERSE_QUERIES.keys()), default="all",
                        help="扫描范围: all=全市场, zz1000=中证1000, zz500=中证500, hs300=沪深300, cyb=创业板, kcb=科创板 (默认: all)")

    args = parser.parse_args()
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    try:
        # 1. 获取扫描范围股票列表（用于名称映射和范围过滤）
        logger.info("=" * 50)
        logger.info(f"扫描范围: {args.universe}")
        stocks = fetch_universe_stocks(args.universe)
        if not stocks:
            print("错误: 无法获取股票列表", file=sys.stderr)
            sys.exit(1)

        # 2. 免费新闻（财联社 + 东财全球资讯）
        logger.info("=" * 50)
        logger.info("开始采集免费新闻...")
        all_articles = []
        if args.incremental:
            cached_events, cached_articles = _load_cached_data(days=CACHE_DAYS)
            all_articles.extend(cached_articles)
            logger.info(f"增量模式: 已加载历史 {len(cached_articles)} 条新闻，本次只获取当天...")

        with ThreadPoolExecutor(max_workers=2) as executor:
            future_cls = executor.submit(fetch_cls_telegraph, page_size=100)
            future_em = executor.submit(fetch_eastmoney_global_news, page_size=100)
            cls_articles = future_cls.result()
            em_articles = future_em.result()
        all_articles.extend(cls_articles)
        all_articles.extend(em_articles)
        all_articles = _dedup_articles(all_articles)
        logger.info(f"免费新闻总计: {len(all_articles)} 条")

        # 3. 从新闻提取个股（事件驱动：只保留新闻里提到的股票）
        stock_news = extract_stocks_from_news(all_articles, stocks=stocks)
        logger.info(f"新闻涉及个股: {len(stock_news)} 只")

        # 4. iwencai事件数据（扩展为10个query2data调用，覆盖更多事件类型）
        logger.info("=" * 50)
        logger.info("开始采集iwencai事件数据...")
        all_events = []
        if args.incremental:
            all_events.extend(cached_events)
            logger.info(f"增量模式: 已加载历史 {len(cached_events)} 条事件")

        if API_KEY:
            event_fetchers = [
                fetch_executive_changes,
                fetch_earnings_forecast,
                fetch_unlocks,
                fetch_private_placement,
                fetch_major_contracts,
                fetch_buybacks,
                fetch_equity_incentive,
                fetch_institutional_research,
                fetch_shareholder_changes,
                fetch_reduction_plans,
            ]
            with ThreadPoolExecutor(max_workers=min(len(event_fetchers), 5)) as executor:
                future_to_name = {executor.submit(fn): fn.__name__ for fn in event_fetchers}
                for future in as_completed(future_to_name):
                    name = future_to_name[future]
                    try:
                        events = future.result()
                        all_events.extend(events)
                        logger.info(f"  -> {name}: {len(events)} 条")
                    except Exception as e:
                        logger.warning(f"{name} 获取失败: {e}")
            all_events = _dedup_events(all_events)
            logger.info(f"事件总数(含缓存): {len(all_events)}")
        else:
            logger.warning("未设置 IWENCAI_API_KEY，跳过事件数据")

        # 保存当天缓存
        if not args.no_cache:
            _save_daily_cache(all_events, all_articles[-200:] if len(all_articles) > 200 else all_articles)
            _cleanup_old_cache(days=CACHE_DAYS)

        # 5. 事件驱动构建雷达（只处理有事件/新闻的股票）
        logger.info("=" * 50)
        logger.info("构建个股雷达（事件驱动）...")
        radar = build_radar(stocks, all_events, stock_news)
        radar = filter_active_radar(radar, min_score_abs=args.min_score)
        logger.info(f"活跃雷达个股: {len(radar)} 只")

        # 6. 对重点个股补充东财个股新闻
        if args.enrich > 0:
            radar = enrich_top_stocks_with_news(radar, top_n=args.enrich)

        # 7. 生成报告
        if args.format in ("markdown", "md"):
            output = generate_markdown_report(radar, top_n=args.top)
        else:
            output = json.dumps(generate_json_report(radar, top_n=args.top), ensure_ascii=False, indent=2)

        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(output)
            logger.info(f"报告已保存: {args.output}")
        else:
            print(output)

    except Exception as e:
        logger.error(f"雷达扫描失败: {e}")
        if args.debug:
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
