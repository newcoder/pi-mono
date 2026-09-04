"""
修复版 a-stock-data API 测试脚本
- 记录每次调用的延迟时间
- 修复同花顺热点：合并 THS reason + 腾讯行情
- 修复 F10 行业分析：使用 mootdx F10 获取行业和地域（tdxpy 已 patch 为 gb18030）
"""

import time
import urllib.request
import json
from typing import Dict, List, Optional
from dataclasses import dataclass


@dataclass
class ApiResult:
    """API 调用结果，包含延迟和状态"""
    success: bool
    latency_ms: float
    source: str
    data: dict
    error: Optional[str] = None


def log_api(name: str, result: ApiResult):
    """打印 API 调用结果"""
    status = "PASS" if result.success else "FAIL"
    print(f"[{status}] {name} | {result.latency_ms:.0f}ms | source={result.source}")
    if result.error:
        print(f"   error: {result.error}")
    return result.success


# =============================================================================
# Layer 1: 腾讯财经 API（修复编码问题）
# =============================================================================

def tencent_quote(codes: List[str]) -> ApiResult:
    """批量拉取腾讯财经实时行情，支持多编码自动检测"""
    t0 = time.time()
    try:
        prefixed = []
        for c in codes:
            if c.startswith(("6", "9")):
                prefixed.append(f"sh{c}")
            elif c.startswith("8"):
                prefixed.append(f"bj{c}")
            else:
                prefixed.append(f"sz{c}")

        url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "Mozilla/5.0")
        resp = urllib.request.urlopen(req, timeout=10)
        raw = resp.read()

        # 自动检测编码
        data = None
        for enc in ["gbk", "gb2312", "utf-8", "gb18030"]:
            try:
                data = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if data is None:
            data = raw.decode("gbk", errors="ignore")

        result = {}
        for line in data.strip().split(";"):
            if not line.strip() or "=" not in line or '"' not in line:
                continue
            key = line.split("=")[0].split("_")[-1]
            vals = line.split('"')[1].split("~")
            if len(vals) < 53:
                continue
            code = key[2:]
            result[code] = {
                "name": vals[1],
                "price": float(vals[3]) if vals[3] else 0,
                "last_close": float(vals[4]) if vals[4] else 0,
                "open": float(vals[5]) if vals[5] else 0,
                "high": float(vals[33]) if vals[33] else 0,
                "low": float(vals[34]) if vals[34] else 0,
                "change_amt": float(vals[31]) if vals[31] else 0,
                "change_pct": float(vals[32]) if vals[32] else 0,
                "amount_wan": float(vals[37]) if vals[37] else 0,
                "turnover_pct": float(vals[38]) if vals[38] else 0,
                "pe_ttm": float(vals[39]) if vals[39] else 0,
                "pb": float(vals[46]) if vals[46] else 0,
                "mcap_yi": float(vals[44]) if vals[44] else 0,
                "limit_up": float(vals[47]) if vals[47] else 0,
                "limit_down": float(vals[48]) if vals[48] else 0,
                "vol_ratio": float(vals[49]) if vals[49] else 0,
            }

        latency = (time.time() - t0) * 1000
        return ApiResult(True, latency, "tencent", {"quotes": result})
    except Exception as e:
        latency = (time.time() - t0) * 1000
        return ApiResult(False, latency, "tencent", {}, str(e))


# =============================================================================
# Layer 6: 同花顺热点（修复：合并 THS reason + 腾讯行情）
# =============================================================================

def ths_hot_reason_with_quotes(date: str = None) -> ApiResult:
    """
    修复版同花顺热点：获取 reason 标签 + 腾讯行情数据（涨幅/换手/成交额等）

    原始 THS API 只返回 id/name/code/reason/date/market 6个字段。
    修复方案：用 THS API 获取 reason，再用腾讯 API 补充行情数据。
    """
    import requests
    from datetime import date as _date

    t0 = time.time()
    try:
        if date is None:
            date = _date.today().strftime("%Y-%m-%d")

        # Step 1: 获取 THS reason 数据
        url = (
            f"http://zx.10jqka.com.cn/event/api/getharden/"
            f"date/{date}/orderby/date/orderway/desc/charset/GBK/"
        )
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "Chrome/117.0.0.0 Safari/537.36"
            )
        }
        t1 = time.time()
        r = requests.get(url, headers=headers, timeout=10)
        ths_latency = (time.time() - t1) * 1000
        data = r.json()
        if data.get("errocode", 0) != 0:
            raise RuntimeError(f"THS error: {data.get('errormsg', '')}")

        rows = data.get("data") or []
        if not rows:
            latency = (time.time() - t0) * 1000
            return ApiResult(True, latency, "ths+tencent", {"count": 0, "rows": [], "ths_latency_ms": ths_latency})

        # Step 2: 用腾讯 API 批量补充行情数据
        codes = [row["code"] for row in rows if row.get("code")]
        t2 = time.time()
        tencent_result = tencent_quote(codes)
        tencent_latency = (time.time() - t2) * 1000
        quotes = tencent_result.data.get("quotes", {}) if tencent_result.success else {}

        # Step 3: 合并数据
        merged = []
        for row in rows:
            code = row.get("code", "")
            q = quotes.get(code, {})
            merged.append({
                "code": code,
                "name": row.get("name", ""),
                "reason": row.get("reason", ""),
                "date": row.get("date", ""),
                "market": row.get("market", 0),
                # 从腾讯 API 补充的行情数据
                "price": q.get("price", 0),
                "change_pct": q.get("change_pct", 0),
                "turnover_pct": q.get("turnover_pct", 0),
                "amount_wan": q.get("amount_wan", 0),
                "pe_ttm": q.get("pe_ttm", 0),
                "pb": q.get("pb", 0),
                "mcap_yi": q.get("mcap_yi", 0),
            })

        latency = (time.time() - t0) * 1000
        return ApiResult(
            True, latency, "ths+tencent",
            {
                "count": len(merged),
                "rows": merged,
                "ths_latency_ms": round(ths_latency, 1),
                "tencent_latency_ms": round(tencent_latency, 1),
            }
        )
    except Exception as e:
        latency = (time.time() - t0) * 1000
        return ApiResult(False, latency, "ths+tencent", {}, str(e))


# =============================================================================
# Layer 6: F10 行业/地域/概念（修复：使用 mootdx F10，tdxpy 已 patch gb18030）
# =============================================================================

def get_stock_concept_blocks(code: str) -> ApiResult:
    """
    使用 mootdx F10 获取行业分类、地域信息。

    说明：
    - tdxpy 已 patch 为 gb18030 解码，支持 Ⅱ/Ⅲ 等字符
    - F10 数据包含行业链和注册地址，但不包含概念板块列表
    - 概念板块需要其他数据源（如 Eastmoney、akshare）补充
    """
    t0 = time.time()
    try:
        from mootdx.quotes import Quotes
        q = Quotes.factory(market='std')

        # 获取所有 F10 内容
        f10 = q.F10(code)
        if not f10:
            latency = (time.time() - t0) * 1000
            return ApiResult(False, latency, "mootdx_f10", {}, "F10 data empty")

        industry = ""
        industry_chain = ""
        concepts = []
        region = ""

        def _extract_field(line: str, label: str) -> str:
            """从 F10 表格行提取字段值，处理 \r 和空尾部"""
            line = line.replace('\r', '').strip()
            if label in line and '｜' in line:
                parts = [p.strip() for p in line.split('｜') if p.strip()]
                # 找到 label 所在的索引，取下一个元素作为值
                for i, p in enumerate(parts):
                    if label in p and i + 1 < len(parts):
                        return parts[i + 1]
            return ""

        # 1. 从"公司概况"提取行业和地域
        company_overview = f10.get('公司概况', '')
        if company_overview:
            for line in company_overview.split('\n'):
                # 行业类别｜食品饮料-白酒Ⅱ-白酒Ⅲ
                val = _extract_field(line, '行业类别')
                if val:
                    industry_chain = val
                    industry = val.split('-')[-1].strip()
                # 注册地址｜贵州省仁怀市茅台镇
                val = _extract_field(line, '注册地址')
                if val:
                    region = val
                # 如果注册地址为空，尝试办公地址
                if not region:
                    val = _extract_field(line, '办公地址')
                    if val:
                        region = val

        # 2. 从"行业分析"提取行业链（备用）
        industry_analysis = f10.get('行业分析', '')
        if industry_analysis and not industry:
            for line in industry_analysis.split('\n'):
                line = line.strip()
                # 匹配：食品饮料--白酒Ⅱ--白酒Ⅲ共(21)家
                if '--' in line:
                    parts = line.split('--')
                    if len(parts) >= 2 and any(c in line for c in ['Ⅰ', 'Ⅱ', 'Ⅲ', '行业', '产业']):
                        # 取最后一段，去掉 "共(N)家" 后缀
                        last_part = parts[-1].strip()
                        # 去掉括号及之后的内容
                        if '（' in last_part:
                            last_part = last_part.split('（')[0].strip()
                        if '(' in last_part:
                            last_part = last_part.split('(')[0].strip()
                        # 去掉 "共" 字开头
                        if last_part.endswith('共'):
                            last_part = last_part[:-1].strip()
                        industry = last_part
                        industry_chain = '--'.join(parts)
                        break

        # 3. 从"最新提示"尝试提取概念（F10 通常不提供更详细的概念列表）
        latest_news = f10.get('最新提示', '')
        if latest_news and '概念板块' in latest_news:
            # F10 "最新提示" 的 "概念板块" 子栏目内容通常为空或非常简单
            pass

        # 4. 尝试从 Eastmoney 补充概念板块（备用）
        if not concepts:
            concepts = _fetch_eastmoney_concepts(code)

        latency = (time.time() - t0) * 1000
        return ApiResult(
            True, latency, "mootdx_f10",
            {
                "code": code,
                "industry": industry,
                "industry_chain": industry_chain,
                "concepts": concepts,
                "region": region,
            }
        )
    except Exception as e:
        latency = (time.time() - t0) * 1000
        return ApiResult(False, latency, "mootdx_f10", {}, str(e))


def _fetch_eastmoney_concepts(code: str) -> List[str]:
    """
    从 Eastmoney 获取股票概念板块列表（备用方案）
    使用 PC_HSF10/CoreConception/PageAjax 接口，返回 ssbk（所属板块）数据
    """
    try:
        import requests

        # 确定市场前缀
        prefix = "SH" if code.startswith("6") or code.startswith("9") else "SZ"

        url = (
            f"https://emweb.securities.eastmoney.com/PC_HSF10/"
            f"CoreConception/PageAjax?code={prefix}{code}"
        )
        headers = {"User-Agent": "Mozilla/5.0"}
        r = requests.get(url, headers=headers, timeout=10)
        data = r.json()

        concepts = []
        # 过滤掉指数类、地区类（保留行业和概念板块）
        index_keywords = [
            "上证", "沪深", "中证", "央视", "标准普尔", "富时罗素",
            "MSCI", "HS300", "融资融券", "沪股通", "深股通", "港股通",
            "机构重仓", "证金持股", "百元股", "大盘股", "权重股",
        ]

        for item in data.get("ssbk", []):
            name = item.get("BOARD_NAME", "").strip()
            if not name:
                continue
            # 跳过指数类
            if any(kw in name for kw in index_keywords):
                continue
            # 跳过地区板块（如"贵州板块""江苏板块"）
            if name.endswith("板块"):
                continue
            concepts.append(name)

        return concepts
    except Exception:
        return []


# =============================================================================
# iwencai API 测试
# =============================================================================

def test_iwencai() -> ApiResult:
    """测试 iwencai NL 语义搜索研报 API"""
    import os
    import secrets
    import requests

    t0 = time.time()
    try:
        IWENCAI_BASE = os.environ.get("IWENCAI_BASE_URL", "https://openapi.iwencai.com")
        IWENCAI_KEY = os.environ.get("IWENCAI_API_KEY", "")

        if not IWENCAI_KEY:
            latency = (time.time() - t0) * 1000
            return ApiResult(False, latency, "iwencai", {}, "IWENCAI_API_KEY not set")

        headers = {
            "Authorization": f"Bearer {IWENCAI_KEY}",
            "Content-Type": "application/json",
            "X-Claw-Call-Type": "normal",
            "X-Claw-Skill-Id": "report-search",
            "X-Claw-Skill-Version": "2.0.0",
            "X-Claw-Plugin-Id": "none",
            "X-Claw-Plugin-Version": "none",
            "X-Claw-Trace-Id": secrets.token_hex(32),
        }
        payload = {
            "channels": ["report"],
            "app_id": "AIME_SKILL",
            "query": "人形机器人 2026",
            "size": 10,
        }
        r = requests.post(
            f"{IWENCAI_BASE}/v1/comprehensive/search",
            json=payload, headers=headers, timeout=30,
        )
        d = r.json()
        if d.get("status_code", 0) != 0:
            raise RuntimeError(f"iwencai error: {d.get('status_msg', '')}")

        articles = d.get("data") or []
        latency = (time.time() - t0) * 1000
        return ApiResult(
            True, latency, "iwencai",
            {"count": len(articles), "articles": articles[:3]}
        )
    except Exception as e:
        latency = (time.time() - t0) * 1000
        return ApiResult(False, latency, "iwencai", {}, str(e))


# =============================================================================
# 主测试流程
# =============================================================================

def main():
    print("=" * 70)
    print("a-stock-data Skill API 修复测试")
    print("=" * 70)

    # Test 1: 腾讯行情
    print("\n[Layer 1] 腾讯财经实时行情")
    r = tencent_quote(["600519", "000858", "688017"])
    log_api("腾讯行情", r)
    if r.success:
        quotes = r.data.get("quotes", {})
        for code, q in quotes.items():
            print(f"   {q['name']}({code}): {q['price']}元 涨跌:{q['change_pct']}% PE={q['pe_ttm']} PB={q['pb']}")

    # Test 2: 同花顺热点（修复版）
    print("\n[Layer 6] 同花顺热点（修复：合并 THS reason + 腾讯行情）")
    r = ths_hot_reason_with_quotes("2026-05-15")
    log_api("THS Hot + Tencent Quotes", r)
    if r.success:
        info = r.data
        print(f"   THS API 延迟: {info.get('ths_latency_ms')}ms")
        print(f"   腾讯 API 延迟: {info.get('tencent_latency_ms')}ms")
        print(f"   合并后数据条数: {info.get('count')}")
        for row in info.get("rows", [])[:5]:
            print(f"   {row['name']}({row['code']}): 涨幅={row['change_pct']}% 换手={row['turnover_pct']}% 题材={row['reason'][:40]}")

    # Test 3: 概念板块归属（修复版）
    print("\n[Layer 6] 概念板块归属（修复：使用 mootdx F10 替代百度股市通）")
    for code in ["600519", "688017"]:
        r = get_stock_concept_blocks(code)
        log_api(f"概念板块 {code}", r)
        if r.success:
            d = r.data
            print(f"   行业链: {d['industry_chain']}")
            print(f"   行业: {d['industry']}")
            concepts_str = ", ".join(d["concepts"][:10]) if d["concepts"] else "(not fetched)"
            print(f"   概念: {concepts_str}")
            print(f"   地域: {d['region']}")

    # Test 4: iwencai
    print("\n[iwencai] NL 语义搜索研报")
    r = test_iwencai()
    log_api("iwencai search", r)
    if r.success:
        print(f"   搜索结果: {r.data.get('count')} 篇研报")
        for a in r.data.get("articles", []):
            title = a.get("title", "")
            print(f"   - {title[:60]}")

    print("\n" + "=" * 70)
    print("测试完成")
    print("=" * 70)


if __name__ == "__main__":
    main()
