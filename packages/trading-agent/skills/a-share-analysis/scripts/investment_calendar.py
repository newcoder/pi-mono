#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
投资日历数据获取脚本
获取宏观数据发布、限售解禁、财报披露、行业展会等事件
"""

import argparse
import json
import os
import secrets
import sys
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = "https://openapi.iwencai.com"
API_KEY = os.environ.get("IWENCAI_API_KEY")
DEFAULT_TIMEOUT = 30
MAX_RETRIES = 2


def build_headers() -> dict:
    if not API_KEY:
        return {"error": "IWENCAI_API_KEY not set"}
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json; charset=utf-8",
        "X-Claw-Call-Type": "normal",
        "X-Claw-Skill-Id": "hithink-astock-selector",
        "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": secrets.token_hex(32),
    }


def query_iwencai(query: str, page: str = "1", limit: str = "100") -> dict:
    payload = {
        "query": query,
        "page": page,
        "limit": limit,
        "is_cache": "1",
        "expand_index": "true",
    }
    headers = build_headers()
    if "error" in headers:
        return {"success": False, "error": headers["error"]}

    req = Request(
        f"{BASE_URL}/v1/query2data",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            last_error = e
            if e.code == 401:
                return {"success": False, "error": "Authentication failed"}
            if attempt < MAX_RETRIES:
                time.sleep(0.5 * (attempt + 1))
                req = Request(
                    f"{BASE_URL}/v1/query2data",
                    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    headers=build_headers(),
                    method="POST",
                )
        except (URLError, Exception) as e:
            last_error = e
            if attempt < MAX_RETRIES:
                time.sleep(0.5 * (attempt + 1))

    return {"success": False, "error": f"Request failed: {last_error}"}


# ── 硬编码季节性事件 ──────────────────────────────────────────────

SEASONAL_EVENTS = [
    # 科技/消费电子
    {"title": "苹果WWDC", "month": 6, "day_range": (2, 13), "category": "conference", "description": "苹果年度开发者大会，iOS/macOS新系统发布", "affected_sectors": ["苹果概念", "AI手机", "消费电子"], "importance": "high"},
    {"title": "Computex台北电脑展", "month": 6, "day_range": (2, 5), "category": "conference", "description": "全球第二大电脑展，AI PC新品发布", "affected_sectors": ["AI PC", "芯片", "消费电子"], "importance": "high"},
    {"title": "CES消费电子展", "month": 1, "day_range": (7, 10), "category": "conference", "description": "全球最大消费电子展", "affected_sectors": ["消费电子", "AI", "新能源车"], "importance": "high"},
    {"title": "MWC世界移动通信大会", "month": 2, "day_range": (26, 29), "category": "conference", "description": "全球移动通信行业盛会", "affected_sectors": ["5G", "通信设备", "消费电子"], "importance": "high"},
    # 光伏/新能源
    {"title": "SNEC光伏展", "month": 6, "day_range": (10, 12), "category": "conference", "description": "全球最大光伏展", "affected_sectors": ["光伏", "储能", "逆变器"], "importance": "high"},
    # 电商/消费
    {"title": "618购物节", "month": 6, "day_range": (1, 18), "category": "industry", "description": "年中电商大促", "affected_sectors": ["电商", "化妆品", "小家电", "白酒"], "importance": "medium"},
    {"title": "双11购物节", "month": 11, "day_range": (1, 11), "category": "industry", "description": "全年最大电商促销", "affected_sectors": ["电商", "化妆品", "小家电", "白酒", "物流"], "importance": "high"},
    # 能源
    {"title": "OPEC+产量会议", "month": 6, "day_range": (1, 5), "category": "macro", "description": "决定下半年原油产量政策", "affected_sectors": ["油气", "油服", "航运"], "importance": "high"},
    # 宏观
    {"title": "全国两会", "month": 3, "day_range": (4, 11), "category": "macro", "description": "政府工作报告发布，政策方向明确", "affected_sectors": [], "importance": "high"},
    {"title": "中央政治局会议", "month": 4, "day_range": (25, 30), "category": "macro", "description": "季度经济工作部署", "affected_sectors": [], "importance": "high"},
    {"title": "中央政治局会议", "month": 7, "day_range": (25, 30), "category": "macro", "description": "半年度经济工作部署", "affected_sectors": [], "importance": "high"},
    {"title": "中央经济工作会议", "month": 12, "day_range": (10, 12), "category": "macro", "description": "次年经济政策定调", "affected_sectors": [], "importance": "high"},
    # 电力
    {"title": "迎峰度夏", "month": 6, "day_range": (15, 30), "category": "industry", "description": "夏季用电高峰，电力保供政策密集", "affected_sectors": ["火电", "水电", "核电", "虚拟电厂", "煤炭"], "importance": "medium"},
    # 农业
    {"title": "中央一号文件", "month": 2, "day_range": (1, 5), "category": "macro", "description": "三农政策指导文件", "affected_sectors": ["农业", "农机", "种业"], "importance": "medium"},
]


def generate_seasonal_events(start_date: str, end_date: str) -> List[Dict]:
    """生成硬编码的季节性事件（日期为预计范围的起始日）"""
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    events = []

    for tmpl in SEASONAL_EVENTS:
        day_start, day_end = tmpl["day_range"]
        for year in range(start.year, end.year + 1):
            # Use the start of the range as the anchor date for calendar display
            event_date = datetime(year, tmpl["month"], day_start)
            if start.date() <= event_date.date() <= end.date():
                date_range_text = f"{year}年{tmpl['month']}月{day_start}-{day_end}日"
                desc = f"预计时间: {date_range_text}"
                if tmpl["description"]:
                    desc = f"{tmpl['description']} ({date_range_text})"
                events.append({
                    "event_date": event_date.strftime("%Y-%m-%d"),
                    "title": tmpl["title"],
                    "category": tmpl["category"],
                    "description": desc,
                    "affected_sectors": tmpl.get("affected_sectors", []),
                    "importance": tmpl["importance"],
                    "source": "seasonal",
                })
    return events


# ── iWencai 查询 ─────────────────────────────────────────────────

IWENCAI_QUERIES = {
    "unlock": {
        "query": "近期限售解禁",
        "category": "unlock",
        "importance": "medium",
        "date_field": "解禁日期",
    },
    "earnings_forecast": {
        "query": "近期业绩预告",
        "category": "earnings",
        "importance": "high",
        "date_field": "预告日期",
    },
    "shareholder_meeting": {
        "query": "近期股东大会",
        "category": "other",
        "importance": "low",
        "date_field": "会议日期",
    },
    "macro_calendar": {
        "query": "近期宏观数据发布",
        "category": "macro",
        "importance": "high",
        "date_field": None,
    },
}


def parse_iwencai_events(result: dict, category: str, importance: str, date_field: Optional[str]) -> List[Dict]:
    """Parse iWencai response into calendar events"""
    events = []
    datas = result.get("datas", [])
    if not datas:
        return events

    for row in datas:
        # Try to find date field
        event_date = None
        if date_field and date_field in row:
            event_date = str(row[date_field])
        else:
            # Try common date fields
            for key in ["日期", "解禁日期", "预告日期", "会议日期", "发布日期", "公告日期"]:
                if key in row:
                    event_date = str(row[key])
                    break

        if not event_date:
            continue

        # Normalize date format (handle YYYY-MM-DD or YYYYMMDD)
        if len(event_date) == 8 and event_date.isdigit():
            event_date = f"{event_date[:4]}-{event_date[4:6]}-{event_date[6:]}"

        # Try to find stock code/name
        code = None
        for key in ["股票代码", "代码", "股票简称"]:
            if key in row:
                val = str(row[key])
                if key == "股票代码":
                    # Extract just the code part (e.g., "600519.SH" -> "600519")
                    code = val.split(".")[0] if "." in val else val
                break

        # Build title
        title_parts = []
        name_key = "股票简称" in row and row["股票简称"]
        if name_key:
            title_parts.append(str(row["股票简称"]))
        if category == "unlock":
            title_parts.append("限售解禁")
        elif category == "earnings":
            title_parts.append("业绩预告")
        elif category == "macro":
            title_parts.append("宏观数据")
        else:
            title_parts.append(category)
        title = " ".join(title_parts) if title_parts else "事件"

        # Build description from available fields
        desc_parts = []
        for k, v in row.items():
            if k in ["股票代码", "股票简称", "日期"]:
                continue
            if v and str(v).strip():
                desc_parts.append(f"{k}: {v}")
        description = "; ".join(desc_parts[:5]) if desc_parts else None

        events.append({
            "event_date": event_date,
            "title": title,
            "category": category,
            "description": description,
            "code": code,
            "market": 1 if code and code.startswith("6") else 0 if code else None,
            "importance": importance,
            "source": "iwencai",
        })

    return events


# ── akshare 数据 ─────────────────────────────────────────────────

def fetch_akshare_unlocks(start_date: str, end_date: str) -> List[Dict]:
    """Fetch restricted stock unlock data from akshare"""
    events = []
    try:
        import akshare as ak
        df = ak.stock_restricted_release_queue_em()
        if df.empty:
            return events

        # Filter by date range
        df["解禁日期"] = pd.to_datetime(df["解禁日期"]).dt.strftime("%Y-%m-%d")
        mask = (df["解禁日期"] >= start_date) & (df["解禁日期"] <= end_date)
        df = df[mask]

        for _, row in df.iterrows():
            code = str(row.get("股票代码", "")).zfill(6)
            events.append({
                "event_date": row["解禁日期"],
                "title": f"{row.get('股票简称', code)} 限售解禁",
                "category": "unlock",
                "description": f"解禁数量: {row.get('解禁数量', '-')}万股; 解禁市值: {row.get('解禁市值', '-')}万元",
                "code": code,
                "market": 1 if code.startswith("6") else 0,
                "importance": "medium",
                "source": "akshare",
            })
    except Exception as e:
        print(f"[WARN] akshare unlock fetch failed: {e}", file=sys.stderr)

    return events


def fetch_akshare_earnings(start_date: str, end_date: str) -> List[Dict]:
    """Fetch earnings forecast from akshare"""
    events = []
    try:
        import akshare as ak
        import pandas as pd
        df = ak.stock_yjyg_em(date=datetime.now().strftime("%Y%m%d"))
        if df.empty:
            return events

        # The date field varies, try to filter
        date_col = None
        for col in ["公告日期", "预告日期"]:
            if col in df.columns:
                date_col = col
                break

        if date_col:
            df[date_col] = pd.to_datetime(df[date_col]).dt.strftime("%Y-%m-%d")
            mask = (df[date_col] >= start_date) & (df[date_col] <= end_date)
            df = df[mask]

        for _, row in df.head(100).iterrows():
            code = str(row.get("股票代码", "")).zfill(6)
            events.append({
                "event_date": row.get(date_col, start_date),
                "title": f"{row.get('股票简称', code)} 业绩预告",
                "category": "earnings",
                "description": f"预告类型: {row.get('预告类型', '-')}; 净利润变动: {row.get('净利润变动幅度', '-')}%; 上年同期: {row.get('上年同期净利润', '-')}万元",
                "code": code,
                "market": 1 if code.startswith("6") else 0,
                "importance": "high",
                "source": "akshare",
            })
    except Exception as e:
        print(f"[WARN] akshare earnings fetch failed: {e}", file=sys.stderr)

    return events


# ── 主程序 ───────────────────────────────────────────────────────

def refresh_market_events(start_date: str, end_date: str) -> List[Dict]:
    """Refresh all market-wide events"""
    all_events = []

    # 1. Hardcoded seasonal events
    all_events.extend(generate_seasonal_events(start_date, end_date))

    # 2. iWencai macro calendar (if API key available)
    if API_KEY:
        for key, cfg in IWENCAI_QUERIES.items():
            if key == "unlock":
                continue  # Skip unlocks for market-wide refresh
            print(f"[FETCH] iWencai: {cfg['query']}", file=sys.stderr)
            result = query_iwencai(cfg["query"])
            if "error" in result and "datas" not in result:
                print(f"[WARN] iWencai query failed: {result.get('error')}", file=sys.stderr)
                continue
            events = parse_iwencai_events(result, cfg["category"], cfg["importance"], cfg.get("date_field"))
            all_events.extend(events)
            print(f"[OK] Got {len(events)} {key} events", file=sys.stderr)

    return all_events


def refresh_stock_events(code: str, start_date: str, end_date: str) -> List[Dict]:
    """Refresh events for a specific stock"""
    events = []

    # iWencai queries for specific stock
    if API_KEY:
        queries = [
            (f"{code} 限售解禁", "unlock", "medium", "解禁日期"),
            (f"{code} 业绩预告", "earnings", "high", "预告日期"),
            (f"{code} 股东大会", "other", "low", "会议日期"),
        ]
        for query, category, importance, date_field in queries:
            result = query_iwencai(query)
            if "error" in result and "datas" not in result:
                continue
            parsed = parse_iwencai_events(result, category, importance, date_field)
            # Filter to only events for this stock
            for ev in parsed:
                if ev.get("code") == code:
                    events.append(ev)

    # akshare data for specific stock
    try:
        import akshare as ak
        import pandas as pd
        # Try to get unlock data for this stock
        df = ak.stock_restricted_release_queue_em()
        if not df.empty:
            df["股票代码"] = df["股票代码"].astype(str).str.zfill(6)
            df = df[df["股票代码"] == code]
            df["解禁日期"] = pd.to_datetime(df["解禁日期"]).dt.strftime("%Y-%m-%d")
            mask = (df["解禁日期"] >= start_date) & (df["解禁日期"] <= end_date)
            df = df[mask]
            for _, row in df.iterrows():
                events.append({
                    "event_date": row["解禁日期"],
                    "title": f"{row.get('股票简称', code)} 限售解禁",
                    "category": "unlock",
                    "description": f"解禁数量: {row.get('解禁数量', '-')}万股",
                    "code": code,
                    "market": 1 if code.startswith("6") else 0,
                    "importance": "medium",
                    "source": "akshare",
                })
    except Exception as e:
        print(f"[WARN] akshare stock events failed: {e}", file=sys.stderr)

    return events


def main():
    parser = argparse.ArgumentParser(description="Investment Calendar Data Fetcher")
    parser.add_argument("--refresh-market", action="store_true", help="Refresh market-wide events")
    parser.add_argument("--refresh-stock", type=str, help="Refresh events for specific stock code")
    parser.add_argument("--since", type=str, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--until", type=str, help="End date (YYYY-MM-DD)")
    args = parser.parse_args()

    # Default date range: previous month to next 2 months
    today = datetime.now()
    start_date = args.since or (today - timedelta(days=30)).strftime("%Y-%m-%d")
    end_date = args.until or (today + timedelta(days=60)).strftime("%Y-%m-%d")

    print(f"[INFO] Date range: {start_date} to {end_date}", file=sys.stderr)

    events = []
    if args.refresh_market:
        events = refresh_market_events(start_date, end_date)
    elif args.refresh_stock:
        events = refresh_stock_events(args.refresh_stock, start_date, end_date)
    else:
        parser.print_help()
        sys.exit(1)

    # Deduplicate by (date, title, code)
    seen = set()
    unique_events = []
    for ev in events:
        key = (ev["event_date"], ev["title"], ev.get("code"))
        if key not in seen:
            seen.add(key)
            unique_events.append(ev)

    # Sort by date
    unique_events.sort(key=lambda x: x["event_date"])

    output = {
        "success": True,
        "start_date": start_date,
        "end_date": end_date,
        "count": len(unique_events),
        "events": unique_events,
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
