#!/usr/bin/env python3
"""
A-stock-data 新闻获取器 — 稳定快速内容多的接口优先

数据源:
1. 东财个股新闻 (search-api-web) — curl_cffi 绕过 TLS 指纹检测
   特点: ~200ms, 20条, 有 content 摘要 + mediaName 来源
2. 财联社快讯 (cls.cn telegraph) — 纯 requests
   特点: ~500ms, 50条, 实时快讯
3. 东财全球资讯 7x24 (np-weblist) — 纯 requests + req_trace
   特点: ~330ms, 50条, 全市场新闻

输出 JSON 供 TypeScript 层调用
"""

import argparse
import json
import re
import sys
import time
from typing import Dict, List, Optional

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


# ═══════════════════════════════════════════════════════════════════════════════
# 数据源 1: 东财个股新闻 (search-api-web)
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_eastmoney_stock_news(code: str, page_size: int = 20) -> List[Dict]:
    """东财个股新闻 — 需 curl_cffi 绕过 TLS 指纹检测"""
    try:
        from curl_cffi import requests as curl_requests
    except ImportError:
        return [{"error": "curl_cffi not installed, required for eastmoney stock news"}]

    cb = "jQuery35101792940631092459_1764599530165"
    url = "https://search-api-web.eastmoney.com/search/jsonp"
    inner_param = {
        "uid": "",
        "keyword": code,
        "type": ["cmsArticleWebOld"],
        "client": "web",
        "clientType": "web",
        "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default",
                "sort": "default",
                "pageIndex": 1,
                "pageSize": page_size,
                "preTag": "<em>",
                "postTag": "</em>",
            }
        },
    }
    params = {
        "cb": cb,
        "param": json.dumps(inner_param, ensure_ascii=False),
        "_": str(int(time.time() * 1000)),
    }
    headers = {
        "User-Agent": UA,
        "Referer": f"https://so.eastmoney.com/news/s?keyword={code}",
        "accept": "*/*",
        "accept-language": "en,zh-CN;q=0.9,zh;q=0.8",
    }

    r = curl_requests.get(url, params=params, headers=headers, timeout=15, impersonate="chrome")
    text = r.text
    json_str = text.strip(f"{cb}(")[:-1]
    d = json.loads(json_str)

    rows = []
    result = d.get("result") or {}
    cms = result.get("cmsArticleWebOld") or {}
    if isinstance(cms, list):
        articles = cms
    else:
        articles = cms.get("list", [])

    for a in articles:
        rows.append({
            "title": re.sub(r'<[^>]+>', '', a.get("title", "")),
            "content": re.sub(r'<[^>]+>', '', a.get("content", ""))[:300],
            "time": a.get("date", ""),
            "source": a.get("mediaName", ""),
            "url": a.get("url", "") or f"http://finance.eastmoney.com/a/{a.get('code', '')}.html",
            "source_type": "eastmoney_stock",
        })
    return rows


# ═══════════════════════════════════════════════════════════════════════════════
# 数据源 2: 财联社快讯 (cls.cn telegraph)
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_cls_telegraph(page_size: int = 50) -> List[Dict]:
    """财联社电报 — 纯 requests, 实时快讯"""
    import requests

    url = "https://www.cls.cn/nodeapi/telegraphList"
    params = {"rn": str(page_size), "page": "1"}
    headers = {"User-Agent": UA, "Referer": "https://www.cls.cn/"}
    r = requests.get(url, params=params, headers=headers, timeout=10)
    d = r.json()

    rows = []
    for item in d.get("data", {}).get("roll_data", []):
        ctime = item.get("ctime", 0)
        time_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ctime)) if ctime else ""
        rows.append({
            "title": item.get("title", "") or item.get("brief", ""),
            "content": item.get("content", "") or item.get("brief", ""),
            "time": time_str,
            "source": "财联社",
            "url": f"https://www.cls.cn/detail/{item.get('id', '')}",
            "source_type": "cls_telegraph",
        })
    return rows


# ═══════════════════════════════════════════════════════════════════════════════
# 数据源 3: 东财全球资讯 7x24
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_eastmoney_global_news(page_size: int = 50) -> List[Dict]:
    """东财全球资讯 7x24 — 纯 requests + req_trace"""
    import requests

    url = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList"
    params = {
        "client": "web",
        "biz": "web_724",
        "fastColumn": "102",
        "sortEnd": "",
        "pageSize": str(page_size),
        "req_trace": str(int(time.time() * 1000)),
    }
    headers = {"User-Agent": UA, "Referer": "https://kuaixun.eastmoney.com/"}
    r = requests.get(url, params=params, headers=headers, timeout=10)
    d = r.json()

    rows = []
    data = d.get("data") or {}
    for item in data.get("fastNewsList", []) or []:
        rows.append({
            "title": item.get("title", ""),
            "content": item.get("summary", "")[:300],
            "time": item.get("showTime", ""),
            "source": "东财7x24",
            "url": "",
            "source_type": "eastmoney_global",
        })
    return rows


# ═══════════════════════════════════════════════════════════════════════════════
# 统一封装
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_news(code: str = "", sources: List[str] = None, limit_per_source: int = 20) -> Dict:
    """
    获取新闻 — 统一入口

    Args:
        code: 股票代码 (如 "600519")，为空时获取市场-wide 新闻
        sources: 数据源列表 ["eastmoney_stock", "cls_telegraph", "eastmoney_global"]
        limit_per_source: 每个来源的条数限制

    Returns:
        {"success": bool, "count": int, "items": List[Dict], "elapsed_ms": float}
    """
    if sources is None:
        sources = ["eastmoney_stock", "cls_telegraph", "eastmoney_global"]

    t0 = time.time()
    all_items = []
    errors = []

    for source in sources:
        try:
            if source == "eastmoney_stock":
                if code:
                    items = fetch_eastmoney_stock_news(code, page_size=limit_per_source)
                else:
                    continue
            elif source == "cls_telegraph":
                items = fetch_cls_telegraph(page_size=limit_per_source)
            elif source == "eastmoney_global":
                items = fetch_eastmoney_global_news(page_size=limit_per_source)
            else:
                continue

            # 过滤掉错误条目
            valid_items = [i for i in items if "error" not in i]
            errors.extend([i["error"] for i in items if "error" in i])
            all_items.extend(valid_items)

        except Exception as e:
            errors.append(f"{source}: {str(e)}")

    # 按时间倒序排列
    def _sort_key(item):
        t = item.get("time", "")
        if not t:
            return ""
        # 统一时间格式用于排序
        try:
            if len(t) == 19 and t[4] == "-":
                return t
            return ""
        except:
            return ""

    all_items.sort(key=_sort_key, reverse=True)

    elapsed = round((time.time() - t0) * 1000, 1)
    return {
        "success": len(all_items) > 0,
        "count": len(all_items),
        "items": all_items,
        "elapsed_ms": elapsed,
        "errors": errors if errors else None,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="A-stock-data 新闻获取器")
    parser.add_argument("--code", type=str, default="", help="股票代码 (如 600519)，为空则获取市场-wide 新闻")
    parser.add_argument("--sources", type=str, default="eastmoney_stock,cls_telegraph,eastmoney_global",
                        help="数据源，逗号分隔")
    parser.add_argument("--limit", type=int, default=20, help="每个来源的条数限制")
    args = parser.parse_args()

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    result = fetch_news(code=args.code, sources=sources, limit_per_source=args.limit)

    # 输出 JSON 到 stdout
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
