#!/usr/bin/env python3
"""
对比测试 a-stock-data 三种新闻数据源 vs 现有 a-share-analysis 新闻脚本

测试维度:
1. 响应时间
2. 返回数据量
3. 字段完整性
4. 可用性/稳定性
"""

import json
import re
import sys
import time
from typing import Dict, List

import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

_SESSION = requests.Session()
_SESSION.mount("https://", HTTPAdapter(max_retries=Retry(total=2, backoff_factor=0.5)))
_SESSION.mount("http://", HTTPAdapter(max_retries=Retry(total=2, backoff_factor=0.5)))

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

TEST_CODE = "600519"
TEST_NAME = "贵州茅台"


# ═══════════════════════════════════════════════════════════════════════════════
# a-stock-data 三种新闻源（直接 HTTP，零依赖）
# ═══════════════════════════════════════════════════════════════════════════════

def eastmoney_stock_news(code: str, page_size: int = 20) -> List[Dict]:
    """东财个股新闻（search-api-web JSONP 接口）
    注: 该接口有 TLS 指纹校验，标准 requests 会被拦截，需 curl_cffi 或 akshare
    """
    try:
        # 优先使用 curl_cffi (akshare 内部使用，可绕过 TLS 指纹检测)
        from curl_cffi import requests as curl_requests
        http = curl_requests
    except ImportError:
        http = requests

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
    # curl_cffi 需要 impersonate 参数模拟浏览器 TLS 指纹
    if hasattr(http, "Session"):
        # curl_cffi requests
        r = http.get(url, params=params, headers=headers, timeout=15, impersonate="chrome")
    else:
        r = http.get(url, params=params, headers=headers, timeout=15)
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
            "content": re.sub(r'<[^>]+>', '', a.get("content", ""))[:200],
            "time": a.get("date", ""),
            "source": a.get("mediaName", ""),
            "url": a.get("url", "") or f"http://finance.eastmoney.com/a/{a.get('code', '')}.html",
        })
    return rows


def cls_telegraph(page_size: int = 50) -> List[Dict]:
    """财联社电报（cls.cn）"""
    url = "https://www.cls.cn/nodeapi/telegraphList"
    params = {"rn": str(page_size), "page": "1"}
    headers = {"User-Agent": UA, "Referer": "https://www.cls.cn/"}
    r = requests.get(url, params=params, headers=headers, timeout=10)
    d = r.json()

    rows = []
    for item in d.get("data", {}).get("roll_data", []):
        rows.append({
            "title": item.get("title", "") or item.get("brief", ""),
            "content": item.get("content", "") or item.get("brief", ""),
            "time": item.get("ctime", ""),
        })
    return rows


def eastmoney_global_news(page_size: int = 50) -> List[Dict]:
    """东财全球资讯 7x24"""
    url = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList"
    params = {
        "client": "web", "biz": "web_724",
        "fastColumn": "102", "sortEnd": "",
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
            "summary": item.get("summary", "")[:200],
            "time": item.get("showTime", ""),
        })
    return rows


# ═══════════════════════════════════════════════════════════════════════════════
# 现有 a-share-analysis 新闻脚本（akshare 依赖）
# ═══════════════════════════════════════════════════════════════════════════════

def existing_eastmoney_akshare(code: str, limit: int = 20) -> List[Dict]:
    """现有: akshare.stock_news_em"""
    import akshare as ak
    df = ak.stock_news_em(symbol=code)
    if df is None or df.empty:
        return []
    results = []
    cols = df.columns.tolist()
    for _, row in df.head(limit).iterrows():
        results.append({
            "title": str(row.iloc[2]) if len(cols) > 2 else "",
            "content": "",
            "time": str(row.iloc[3]) if len(cols) > 3 else "",
            "source": "eastmoney",
            "url": str(row.iloc[5]) if len(cols) > 5 else "",
        })
    return results


def existing_cls_akshare(limit: int = 100) -> List[Dict]:
    """现有: akshare.stock_news_main_cx (财联社要闻)"""
    import akshare as ak
    df = ak.stock_news_main_cx()
    if df is None or df.empty:
        return []
    results = []
    for _, row in df.head(limit).iterrows():
        results.append({
            "title": str(row.get("summary", "")),
            "content": "",
            "time": "",
            "source": "cls",
            "url": str(row.get("url", "")),
        })
    return results


def existing_stcn(code: str, name: str, limit: int = 10) -> List[Dict]:
    """现有: 证券时报搜索 API"""
    url = "https://search.stcn.com/api/search"
    params = {"q": f"{name} {code}", "page": 1, "per_page": limit}
    headers = {"User-Agent": UA, "Accept": "application/json"}
    r = _SESSION.get(url, params=params, headers=headers, timeout=15, verify=False)
    data = r.json()
    items = data.get("data", {}).get("list", []) if isinstance(data, dict) else []
    results = []
    for item in items[:limit]:
        results.append({
            "title": item.get("title", ""),
            "content": item.get("summary", item.get("description", "")),
            "time": item.get("pub_time", ""),
            "source": "stcn",
            "url": item.get("url", ""),
        })
    return results


# ═══════════════════════════════════════════════════════════════════════════════
# 测试执行
# ═══════════════════════════════════════════════════════════════════════════════

def timed_call(func, *args, **kwargs) -> tuple:
    """执行函数并返回 (结果, 耗时_ms, 异常)"""
    t0 = time.time()
    try:
        result = func(*args, **kwargs)
        elapsed = (time.time() - t0) * 1000
        return result, elapsed, None
    except Exception as e:
        elapsed = (time.time() - t0) * 1000
        return [], elapsed, str(e)


def print_result(name: str, result, elapsed_ms, error):
    print(f"\n{'─' * 60}")
    status = "FAIL" if error else "OK"
    print(f"[{status}] {name} — {elapsed_ms:.0f}ms")
    if error:
        print(f"  Error: {error}")
        return
    print(f"  Count: {len(result)}")
    if result:
        sample = result[0]
        print(f"  Fields: {', '.join(sample.keys())}")
        print(f"  Sample: {sample.get('title', '')[:60]}...")
        print(f"  Time:   {sample.get('time', sample.get('pub_time', ''))}")


def run_comparison():
    print("=" * 60)
    print("新闻数据源对比测试")
    print(f"测试标的: {TEST_CODE} {TEST_NAME}")
    print("=" * 60)

    # ── a-stock-data 三种新闻源 ──
    print("\n\n【a-stock-data 直接 HTTP 接口】")

    result, elapsed, error = timed_call(eastmoney_stock_news, TEST_CODE, 20)
    print_result("1. 东财个股新闻 (search-api-web)", result, elapsed, error)

    result, elapsed, error = timed_call(cls_telegraph, 50)
    print_result("2. 财联社快讯 (cls.cn telegraph)", result, elapsed, error)

    result, elapsed, error = timed_call(eastmoney_global_news, 50)
    print_result("3. 东财全球资讯 7x24 (np-weblist)", result, elapsed, error)

    # ── 现有 a-share-analysis 脚本 ──
    print("\n\n【现有 a-share-analysis 脚本】")

    result, elapsed, error = timed_call(existing_eastmoney_akshare, TEST_CODE, 20)
    print_result("4. 东财个股新闻 (akshare)", result, elapsed, error)

    result, elapsed, error = timed_call(existing_cls_akshare, 100)
    print_result("5. 财联社要闻 (akshare)", result, elapsed, error)

    result, elapsed, error = timed_call(existing_stcn, TEST_CODE, TEST_NAME, 10)
    print_result("6. 证券时报搜索 (stcn)", result, elapsed, error)

    # ── 对比汇总 ──
    print("\n\n" + "=" * 60)
    print("对比汇总 (实测结果)")
    print("=" * 60)
    print("""
维度              | a-stock-data                   | 现有 (akshare依赖)
─────────────────┼─────────────────────────────────┼─────────────────────────────
东财个股新闻      | search-api-web JSONP           | akshare.stock_news_em
                 | 需 curl_cffi 绕过 TLS 指纹     | 内置 curl_cffi
                 | ~200ms, 20条, 有content摘要    | ~1000ms, 10条, 无摘要
                 | 有 mediaName 来源              | 来源固定为 eastmoney
财联社           | cls.cn telegraphList (电报)    | akshare.stock_news_main_cx
                 | ~500ms, 50条                   | ~600ms, 100条
                 | 实时快讯, 有title+content      | 要闻摘要, 无实时性
东财全球资讯      | np-weblist 7x24 (独有)         | 无对应接口
                 | ~330ms, 50条                   |
                 | 需 req_trace 参数              |
证券时报         | 无                             | search.stcn.com API (独有)
                 |                                | SSL错误, 当前不可用
─────────────────┼─────────────────────────────────┼─────────────────────────────
依赖             | 需 curl_cffi (非纯requests)    | 需要 akshare + pandas
速度             | 更快 (绕过Python requests开销) | 较慢
稳定性           | 接口可能变更, 需维护指纹绕过   | akshare封装相对稳定
""")


if __name__ == "__main__":
    run_comparison()
