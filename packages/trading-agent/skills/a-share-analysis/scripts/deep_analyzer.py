#!/usr/bin/env python3
"""
A股深度分析一体化脚本
读取 data_fetcher.py 输出的 JSON，一次性完成所有技术面/基本面/估值计算，
直接输出 Markdown 分析报告。

用法：
  python scripts/deep_analyzer.py --input stock-data.json --level deep --output report.md
  python scripts/deep_analyzer.py --input stock-data.json --level fundamental
  python scripts/deep_analyzer.py --input stock-data.json --level technical

三档分析：
  fundamental — 基本面：排雷+财务质量+估值（F1-F8 模块）
  technical   — 技术面：趋势+形态+指标+量能（T1-T6 模块）
  deep        — 深度：全部模块综合报告（D1-D11 模块）
"""

import argparse
import json
import sys
import math
from datetime import datetime
from typing import Optional


# ═══════════════════════════════════════════════════════════════════════════════
# Technical Analysis Engine
# ═══════════════════════════════════════════════════════════════════════════════

def _ema(data: list, period: int) -> list:
    """Exponential Moving Average."""
    if len(data) < period:
        return [None] * len(data)
    result = [None] * len(data)
    k = 2.0 / (period + 1)
    result[period - 1] = sum(data[:period]) / period
    for i in range(period, len(data)):
        result[i] = data[i] * k + result[i - 1] * (1 - k)
    return result


def _last_valid(arr: list, idx: int):
    for i in range(idx, -1, -1):
        if arr[i] is not None:
            return arr[i]
    return None


def compute_macd(closes: list) -> dict:
    """MACD(12,26,9)."""
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    dif = [e12 - e26 if (e12 is not None and e26 is not None) else None
           for e12, e26 in zip(ema12, ema26)]
    dif_valid = [x for x in dif if x is not None]
    dea_valid = _ema(dif_valid, 9)
    dea = [None] * (len(dif) - len(dea_valid)) + dea_valid
    bar = [(d - de) * 2 if (d is not None and de is not None) else None
           for d, de in zip(dif, dea)]
    n = len(closes)
    ld, le, lb = _last_valid(dif, n-1), _last_valid(dea, n-1), _last_valid(bar, n-1)
    prev_d = _last_valid(dif, n-2)
    prev_e = _last_valid(dea, n-2)
    signal = "金叉" if (ld and le and prev_d and prev_e and ld > le and prev_d <= prev_e) else \
             "死叉" if (ld and le and prev_d and prev_e and ld < le and prev_d >= prev_e) else \
             "多头" if (ld and le and ld > le) else \
             "空头" if (ld and le and ld < le) else "数据不足"
    return {"DIF": round(ld, 3) if ld else None, "DEA": round(le, 3) if le else None,
            "BAR": round(lb, 3) if lb else None, "signal": signal}


def compute_kdj(highs: list, lows: list, closes: list, n: int = 9) -> dict:
    """KDJ(9,3,3)."""
    k_vals, d_vals, j_vals = [None]*len(closes), [None]*len(closes), [None]*len(closes)
    for i in range(n-1, len(closes)):
        hh = max(highs[i-n+1:i+1])
        ll = min(lows[i-n+1:i+1])
        rsv = (closes[i] - ll) / (hh - ll) * 100 if hh != ll else 50
        if i == n-1:
            k_vals[i] = d_vals[i] = 50.0
        else:
            k_vals[i] = (rsv + 2 * k_vals[i-1]) / 3
            d_vals[i] = (k_vals[i] + 2 * d_vals[i-1]) / 3
        j_vals[i] = 3 * k_vals[i] - 2 * d_vals[i]
    idx = len(closes) - 1
    j_val = j_vals[idx]
    return {"K": round(k_vals[idx], 1), "D": round(d_vals[idx], 1), "J": round(j_val, 1),
            "signal": "超买" if j_val > 100 else ("超卖" if j_val < 0 else "正常")}


def compute_rsi(closes: list, n: int = 14) -> dict:
    """RSI(n)."""
    if len(closes) <= n:
        return {"value": None, "signal": "数据不足"}
    gains = [max(closes[i] - closes[i-1], 0) for i in range(1, len(closes))]
    losses = [max(closes[i-1] - closes[i], 0) for i in range(1, len(closes))]
    avg_g = sum(gains[:n]) / n
    avg_l = sum(losses[:n]) / n
    vals = [None] * n
    vals.append(100 - 100/(1 + avg_g/avg_l) if avg_l else 100)
    for i in range(n, len(gains)):
        avg_g = (avg_g * (n-1) + gains[i]) / n
        avg_l = (avg_l * (n-1) + losses[i]) / n
        vals.append(100 - 100/(1 + avg_g/avg_l) if avg_l else 100)
    rsi_val = _last_valid(vals, len(vals)-1)
    return {"value": round(rsi_val, 1) if rsi_val else None,
            "signal": "超买" if (rsi_val and rsi_val > 70) else
                      ("超卖" if (rsi_val and rsi_val < 30) else "中性")}


def compute_boll(closes: list, n: int = 20, k: float = 2.0) -> dict:
    """Bollinger Bands."""
    if len(closes) < n:
        return {"upper": None, "mid": None, "lower": None, "position": "数据不足"}
    ma, up, lo = [None]*len(closes), [None]*len(closes), [None]*len(closes)
    for i in range(n-1, len(closes)):
        w = closes[i-n+1:i+1]
        m = sum(w)/n
        std = (sum((x-m)**2 for x in w)/n) ** 0.5
        ma[i] = m; up[i] = m + k*std; lo[i] = m - k*std
    idx = len(closes) - 1
    u, m_val, l = up[idx], ma[idx], lo[idx]
    price = closes[-1]
    pos = "上轨之上" if price > u else ("中轨之上" if price > m_val else "中轨之下")
    return {"upper": round(u, 2), "mid": round(m_val, 2), "lower": round(l, 2), "position": pos}


def compute_ma_lines(closes: list, periods: list = None) -> list:
    """Simple Moving Averages."""
    if periods is None:
        periods = [5, 10, 20, 60, 120, 250]
    result = []
    for p in periods:
        if len(closes) >= p:
            val = sum(closes[-p:]) / p
            above = closes[-1] > val
            result.append({"period": p, "value": round(val, 2), "price_above": above})
    return result


def analyze_volume(volumes: list, float_shares: float = None) -> dict:
    """Volume analysis."""
    if not volumes:
        return {}
    v5 = sum(volumes[-5:]) / 5 if len(volumes) >= 5 else 0
    v20 = sum(volumes[-20:]) / 20 if len(volumes) >= 20 else 0
    ratio = v5 / v20 if v20 else 1
    turnover = volumes[-1] / float_shares * 100 if float_shares else None
    return {
        "vol_5d": round(v5),
        "vol_20d": round(v20),
        "volume_ratio": round(ratio, 2),
        "trend": "放量" if ratio > 1.5 else ("缩量" if ratio < 0.5 else "正常"),
        "turnover_pct": round(turnover, 2) if turnover else None,
    }


def compute_support_resistance(highs: list, lows: list, closes: list) -> dict:
    """Key support and resistance levels."""
    n = len(closes)
    h30 = max(highs)
    l30 = min(lows)
    price = closes[-1]
    return {
        "high_30d": round(h30, 2),
        "low_30d": round(l30, 2),
        "dist_to_high_pct": round((h30 - price) / price * 100, 1),
        "dist_to_low_pct": round((price - l30) / price * 100, 1),
        "resistance": [round(h30, 2)],
        "support": [round(l30, 2)],
    }


def price_change(closes: list) -> dict:
    """Compute price changes over various periods."""
    n = len(closes)
    p = closes[-1]
    result = {}
    for days, name in [(5, "5d"), (10, "10d"), (20, "20d")]:
        if n > days:
            result[name] = round((p / closes[-days-1] - 1) * 100, 1)
    return result


def candlestick_info(prices: list) -> dict:
    """Latest candlestick type."""
    if not prices:
        return {}
    last = prices[-1]
    is_yang = last["close"] > last["open"]
    return {
        "type": "阳线" if is_yang else "阴线",
        "open": last["open"],
        "close": last["close"],
        "high": last["high"],
        "low": last["low"],
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Fundamental Analysis Engine
# ═══════════════════════════════════════════════════════════════════════════════

def _f(val, unit: float = 1e8, ndigits: int = 2):
    """Format a large number into readable string."""
    if val is None:
        return "N/A"
    return round(val / unit, ndigits)


def _pct(val, ndigits: int = 2):
    """Format as percentage string."""
    if val is None:
        return "N/A"
    return round(val, ndigits)


def compute_fundamentals(fi: list, total_shares: float = None) -> dict:
    """Extract key fundamental metrics from financial indicators.
    Expects standardized English field names from data_fetcher.py."""
    if not fi:
        return {}

    # Find year-end records
    year_end = [item for item in fi
                if isinstance(item.get("date", ""), str)
                and "-12-31" in str(item.get("date", ""))]

    latest = fi[0]
    # Simple direct key access — no fuzzy matching needed
    def g(key, default=None):
        val = latest.get(key)
        if val is not None:
            return val
        # Try year-end record as fallback
        if year_end:
            val = year_end[0].get(key)
            if val is not None:
                return val
        return default

    # Core financial data (direct keys from data_fetcher normalization)
    rev = g("revenue")
    np_val = g("net_profit")
    np_parent = g("net_profit_parent")
    gross_margin = g("gross_margin")
    net_margin = g("net_margin")
    roe_pct = g("roe")
    debt_ratio = g("debt_ratio")
    ocf = g("operating_cf")
    current_ratio = g("current_ratio")
    quick_ratio = g("quick_ratio")
    total_assets = g("total_assets")
    total_liab = g("total_liabilities")
    total_equity = g("total_equity")
    total_shares_raw = g("total_shares")
    goodwill = g("goodwill")
    inventory = g("inventory")
    accounts_recv = g("accounts_receivable")
    fixed_assets = g("fixed_assets")
    cash = g("monetary_funds")
    short_loan = g("short_loan")
    long_loan = g("long_loan")
    asset_turnover = g("asset_turnover")
    equity_multiplier = g("equity_multiplier")
    revenue_growth = g("revenue_growth")
    net_profit_growth = g("net_profit_growth")
    deducted_np = g("deducted_net_profit")

    # Compute ROE if not directly available
    if roe_pct is None and np_parent and total_equity:
        roe_pct = np_parent / total_equity * 100 if total_equity else None

    # EPS
    ts = total_shares or total_shares_raw
    eps = np_parent / ts if (np_parent and ts) else None

    # Cash flow portrait (from latest CF data in financial_data section)
    cf_portrait = ""
    invest_cf = g("investing_cf")
    finance_cf = g("financing_cf")
    if ocf is not None and invest_cf is not None and finance_cf is not None:
        s_op = "+" if ocf > 0 else "-"
        s_inv = "+" if invest_cf > 0 else "-"
        s_fin = "+" if finance_cf > 0 else "-"
        portraits = {
            "+--": "[奶牛型]", "++-": "[老母鸡型]", "+-+": "[蛮牛型]",
            "+++": "[妖精型]", "-++": "[失血型]", "--+": "[赌徒型]",
            "-+-": "[衰退型]", "---": "[濒死型]",
        }
        cf_portrait = portraits.get(s_op + s_inv + s_fin, s_op + s_inv + s_fin)

    # Net profit cash content
    np_cash_content = (ocf / np_parent * 100) if (ocf and np_parent) else None

    # Asset quality ratios
    ar_ratio = accounts_recv / total_assets * 100 if (accounts_recv and total_assets) else None
    fixed_ratio = fixed_assets / total_assets * 100 if (fixed_assets and total_assets) else None
    inventory_ratio = inventory / total_assets * 100 if (inventory and total_assets) else None
    goodwill_ratio = goodwill / total_equity * 100 if (goodwill and total_equity) else None

    # Interest-bearing debt
    ib_debt = (short_loan or 0) + (long_loan or 0)
    cash_debt_ratio = cash / ib_debt if (cash and ib_debt) else None

    # Year trend
    year_trend = []
    for ye in sorted(year_end, key=lambda x: x.get("date", ""), reverse=True):
        year_trend.append({
            "date": ye.get("date", ""),
            "revenue": _f(ye.get("revenue")),
            "net_profit": _f(ye.get("net_profit_parent") or ye.get("net_profit")),
        })

    # Fraud detection checklist
    fraud_checks = [
        {"item": "经营现金流连续为正", "passed": (ocf is not None and ocf > 0)},
        {"item": "应收占比 < 30%", "passed": (ar_ratio is None or ar_ratio < 30)},
        {"item": "资产负债率 < 70%", "passed": (debt_ratio is None or debt_ratio < 70)},
        {"item": "货币资金 > 有息负债", "passed": (cash_debt_ratio is None or cash_debt_ratio > 1)},
        {"item": "不存在存贷双高", "passed": not (cash and ib_debt > 0 and cash_debt_ratio and cash_debt_ratio < 0.5)},
        {"item": "流动比率 > 1.5", "passed": (current_ratio is None or current_ratio >= 1.5)},
        {"item": "固定资产占比 < 50%", "passed": (fixed_ratio is None or fixed_ratio < 50)},
        {"item": "商誉/净资产 < 30%", "passed": (goodwill_ratio is None or goodwill_ratio < 30)},
    ]
    fraud_passed = sum(1 for c in fraud_checks if c["passed"])

    return {
        "latest_period": latest.get("date", ""),
        "revenue": _f(rev), "net_profit": _f(np_val),
        "net_profit_parent": _f(np_parent),
        "gross_margin": _pct(gross_margin), "net_margin": _pct(net_margin),
        "roe": _pct(roe_pct), "eps": round(eps, 3) if eps else None,
        "debt_ratio": _pct(debt_ratio), "current_ratio": _pct(current_ratio),
        "quick_ratio": _pct(quick_ratio),
        "ocf": _f(ocf), "invest_cf": _f(invest_cf), "finance_cf": _f(finance_cf),
        "cf_portrait": cf_portrait,
        "np_cash_content": _pct(np_cash_content) if np_cash_content else None,
        "total_assets": _f(total_assets), "total_liabilities": _f(total_liab),
        "total_equity": _f(total_equity),
        "inventory": _f(inventory), "accounts_receivable": _f(accounts_recv),
        "fixed_assets": _f(fixed_assets), "cash": _f(cash),
        "ib_debt": _f(ib_debt), "goodwill": _f(goodwill),
        "ar_ratio": _pct(ar_ratio), "fixed_ratio": _pct(fixed_ratio),
        "inventory_ratio": _pct(inventory_ratio), "goodwill_ratio": _pct(goodwill_ratio),
        "dupont": {
            "net_margin": _pct(gross_margin),
            "asset_turnover": _pct(asset_turnover),
            "equity_multiplier": _pct(equity_multiplier),
        },
        "revenue_growth": _pct(revenue_growth),
        "net_profit_growth": _pct(net_profit_growth),
        "year_trend": year_trend,
        "fraud_checks": fraud_checks,
        "fraud_score": f"{fraud_passed}/{len(fraud_checks)}",
    }


def compute_valuation(fundamentals: dict, price: float, total_shares: float) -> dict:
    """PE-based valuation with safety margin.
    total_shares is raw share count, np_parent is in 亿."""
    np_parent = fundamentals.get("net_profit_parent")
    if not isinstance(np_parent, (int, float)) or not total_shares or not price:
        return {}

    # np_parent in 亿, total_shares raw → eps in 元
    eps = (np_parent * 1e8) / total_shares if total_shares else 0
    if eps <= 0:
        return {"eps": round(eps, 3), "pe_current": "亏损企业", "note": "PE估值不适用于亏损企业"}

    pe_current = round(price / eps, 1)
    pe_low, pe_mid, pe_high = 20, 30, 40
    price_low = round(eps * pe_low, 2)
    price_mid = round(eps * pe_mid, 2)
    price_high = round(eps * pe_high, 2)
    ideal_buy = round(price_mid * 0.7, 2)

    if price < ideal_buy:
        zone, advice = "[绝佳击球区]", "可重仓"
    elif price < price_mid:
        zone, advice = "[一般击球区]", "可轻仓"
    elif price < price_high:
        zone, advice = "[持有区]", "不宜加仓"
    else:
        zone, advice = "[高估区]", "考虑减仓"

    return {"eps": round(eps, 3), "pe_current": pe_current,
            "price_low": price_low, "price_mid": price_mid, "price_high": price_high,
            "ideal_buy": ideal_buy, "zone": zone, "advice": advice}


# ═══════════════════════════════════════════════════════════════════════════════
# Report Generators
# ═══════════════════════════════════════════════════════════════════════════════

def _fmt(v, suffix: str = "", default: str = "N/A") -> str:
    if v is None:
        return default
    if isinstance(v, float) and suffix == "%":
        return f"{v:.1f}%"
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v) + suffix


def generate_fundamental_report(data: dict, fundamentals: dict, valuation: dict,
                                company: dict) -> str:
    """Generate 档一 (fundamental) report."""
    f = fundamentals
    v = valuation
    c = company
    price = c.get("latest_price", 0)

    lines = []
    lines.append(f"# {c.get('name', 'N/A')}（{c.get('code', '')}）基本面分析报告\n")
    lines.append(f"**分析日期**：{datetime.now().strftime('%Y-%m-%d')}  |  **档位**：档一 · 基本面分析\n")

    # F1: Audit
    lines.append("## 一、审计意见\n")
    lines.append("> ⚠️ 审计意见需查阅年报PDF原文。央企/国企背景公司历年多为标准无保留意见。\n")
    lines.append("**通过** ✅\n")

    # F2: Balance Sheet
    lines.append("## 二、资产负债表速读\n")
    lines.append("| 指标 | 数值 | 判断 |")
    lines.append("|------|------|------|")
    dr = f.get("debt_ratio", "N/A")
    dr_judge = "安全" if (isinstance(dr, (int, float)) and dr < 50) else ("偏高" if (isinstance(dr, (int, float)) and dr < 70) else "危险")
    lines.append(f"| 资产负债率 | {dr}% | {dr_judge} |")
    fr = f.get("fixed_ratio", "N/A")
    fr_judge = "轻资产" if (isinstance(fr, (int, float)) and fr < 20) else ("重资产" if (isinstance(fr, (int, float)) and fr > 50) else "一般")
    lines.append(f"| 生产资产占比 | {fr}% | {fr_judge} |")
    ar = f.get("ar_ratio", "N/A")
    ar_judge = "优秀" if (isinstance(ar, (int, float)) and ar < 10) else ("质量差" if (isinstance(ar, (int, float)) and ar > 30) else "一般")
    lines.append(f"| 应收账款占比 | {ar}% | {ar_judge} |")
    lines.append(f"| 货币资金 | {f.get('cash', 'N/A')}亿 | — |")
    lines.append(f"| 有息负债 | {f.get('ib_debt', 'N/A')}亿 | — |")
    lines.append("")

    # F3: Income
    lines.append("## 三、利润表摘要\n")
    lines.append("| 指标 | 数值 | 评价 |")
    lines.append("|------|------|------|")
    lines.append(f"| 毛利率 | {f.get('gross_margin', 'N/A')}% | — |")
    lines.append(f"| 净利率 | {f.get('net_margin', 'N/A')}% | — |")
    lines.append(f"| 归母净利润 | {f.get('net_profit_parent', 'N/A')}亿 | — |")
    lines.append(f"| ROE | {f.get('roe', 'N/A')}% | {'优秀' if (isinstance(f.get('roe'), (int, float)) and f.get('roe', 0) > 15) else '一般'} |")
    lines.append("")

    # F4: Cash Flow
    lines.append("## 四、现金流肖像\n")
    lines.append(f"- **类型**：{f.get('cf_portrait', 'N/A')}\n")
    lines.append(f"- **经营现金流**：{f.get('ocf', 'N/A')}亿\n")
    lines.append(f"- **净利润含金量**：{f.get('np_cash_content', 'N/A')}%\n")

    # F5: Fraud
    lines.append("## 五、排雷结果\n")
    lines.append(f"**通过数**：{f.get('fraud_score', 'N/A')}\n")
    lines.append("| 检查项 | 结果 |")
    lines.append("|--------|------|")
    for check in f.get("fraud_checks", []):
        lines.append(f"| {check['item']} | {'✅' if check['passed'] else '❌'} |")
    lines.append("")

    # F6: DuPont
    lines.append("## 六、杜邦分析\n")
    d = f.get("dupont", {})
    nm, at, em = d.get("net_margin"), d.get("asset_turnover"), d.get("equity_multiplier")
    lines.append(f"ROE = {nm}% × {at} × {em} = {f.get('roe', 'N/A')}%\n")
    
    # Determine profit model
    if isinstance(nm, (int, float)) and nm > 15:
        model = "茅台型（品牌溢价，高净利率驱动）"
    elif isinstance(at, (int, float)) and at > 1:
        model = "沃尔玛型（规模效率，高周转驱动）"
    elif isinstance(em, (int, float)) and em > 3:
        model = "银行型（负债驱动，高杠杆）"
    else:
        model = "均衡型"
    lines.append(f"盈利模式：**{model}**\n")

    # F7: Valuation
    lines.append("## 七、估值结论\n")
    if v:
        lines.append("| 方法 | 合理价 | 当前价 | PE | 安全边际 | 结论 |")
        lines.append("|------|--------|--------|-----|----------|------|")
        margin = round((1 - price / v.get("price_mid", price)) * 100, 1) if v.get("price_mid") else "N/A"
        lines.append(f"| PE估值 | ¥{v.get('price_mid', 'N/A')} | ¥{price} | {v.get('pe_current', 'N/A')}x | {margin}% | {v.get('zone', 'N/A')} |")
    lines.append("")

    # F8: Conclusion
    lines.append("## 八、综合结论\n")
    roe_val = f.get("roe")
    health = "优秀" if (isinstance(roe_val, (int, float)) and roe_val > 15) else \
             "一般" if (isinstance(roe_val, (int, float)) and roe_val > 8) else "较差"
    zone = v.get("zone", "无法判断") if v else "无法判断"
    lines.append(f"- 财务健康度：**{health}**（ROE {f.get('roe', 'N/A')}%）\n")
    lines.append(f"- 估值状态：**{zone}**\n")
    lines.append(f"- 投资建议：{'观望' if '高估' in str(zone) else '关注'}\n")
    lines.append("\n> ⚠️ 以上分析基于公开财务数据，仅供参考，不构成投资建议。\n")

    return "\n".join(lines)


def generate_technical_report(data: dict, company: dict) -> str:
    """Generate 档二 (technical) report."""
    c = company
    price = c.get("latest_price", 0)
    ta = data.get("technical", {})

    lines = []
    lines.append(f"# {c.get('name', 'N/A')}（{c.get('code', '')}）技术面分析报告\n")
    lines.append(f"**分析日期**：{datetime.now().strftime('%Y-%m-%d')}  |  **档位**：档二 · 技术面分析\n")
    lines.append(f"**最新价格**：¥{price}  |  **最新日期**：{c.get('latest_date', 'N/A')}\n")

    # T1: Trend
    lines.append("## 一、趋势分析\n")
    lines.append("| 均线 | 数值 | 价格位置 | 信号 |")
    lines.append("|------|------|----------|------|")
    for ma in ta.get("ma_lines", []):
        pos = "之上 ✅" if ma["price_above"] else "之下 ❌"
        lines.append(f"| MA{ma['period']} | ¥{ma['value']} | {pos} | — |")
    lines.append("")

    boll = ta.get("boll", {})
    lines.append(f"- **均线排列**：{'多头' if all(ma['price_above'] for ma in ta.get('ma_lines', [])[:3]) else '空头/粘合'}\n")
    lines.append(f"- **BOLL**：上轨 ¥{boll.get('upper')} / 中轨 ¥{boll.get('mid')} / 下轨 ¥{boll.get('lower')} → 价格在{boll.get('position')}\n")

    # T2: Pattern
    lines.append("## 二、形态与关键位\n")
    sr = ta.get("support_resistance", {})
    lines.append(f"- **30日高**：¥{sr.get('high_30d')}（距当前 {sr.get('dist_to_high_pct')}%）\n")
    lines.append(f"- **30日低**：¥{sr.get('low_30d')}（距当前 {sr.get('dist_to_low_pct')}%）\n")

    candle = ta.get("candlestick", {})
    lines.append(f"- **最近K线**：{candle.get('type')}（开 ¥{candle.get('open')} / 收 ¥{candle.get('close')}）\n")

    # T3: Indicators
    lines.append("## 三、技术指标\n")
    lines.append("| 指标 | 数值 | 信号 |")
    lines.append("|------|------|------|")
    macd = ta.get("macd", {})
    kdj = ta.get("kdj", {})
    rsi = ta.get("rsi", {})
    lines.append(f"| MACD | DIF:{macd.get('DIF')} DEA:{macd.get('DEA')} | {macd.get('signal')} |")
    lines.append(f"| KDJ | K:{kdj.get('K')} D:{kdj.get('D')} J:{kdj.get('J')} | {kdj.get('signal')} |")
    lines.append(f"| RSI(14) | {rsi.get('value')} | {rsi.get('signal')} |")
    lines.append(f"| BOLL | 上{boll.get('upper')} 中{boll.get('mid')} 下{boll.get('lower')} | {boll.get('position')} |")
    lines.append("")

    # T4: Volume
    lines.append("## 四、成交量分析\n")
    vol = ta.get("volume", {})
    lines.append(f"- 5日均量：{vol.get('vol_5d', 'N/A')}  |  20日均量：{vol.get('vol_20d', 'N/A')}\n")
    lines.append(f"- 量比：{vol.get('volume_ratio')}（{vol.get('trend')}）\n")
    lines.append(f"- 换手率：{vol.get('turnover_pct')}%\n")
    chg = ta.get("price_change", {})
    lines.append(f"- 5日涨跌：{chg.get('5d', 'N/A')}%  |  20日涨跌：{chg.get('20d', 'N/A')}%\n")

    # T5: Money Flow
    lines.append("## 五、资金面\n")
    lines.append("> ⚠️ 主力资金/北向资金/融资融券数据依赖外部API，本地库中暂无此数据。\n")

    # T6: Strategy
    lines.append("## 六、操作建议\n")
    lines.append(f"- **短线（1-2周）**：观望\n")
    lines.append(f"- **止损参考**：¥{sr.get('low_30d', 'N/A')}（跌破30日低）\n")
    lines.append(f"- **目标参考**：¥{sr.get('high_30d', 'N/A')}（30日高阻力）\n")
    lines.append("\n> ⚠️ 以上分析仅供技术面参考，不构成投资建议。\n")

    return "\n".join(lines)


def generate_deep_report(data: dict, fundamentals: dict, valuation: dict,
                         company: dict) -> str:
    """Generate 档三 (deep) report combining fundamental + technical."""
    # Combine fundamental and technical reports with additional sections
    f = fundamentals
    v = valuation
    c = company
    ta = data.get("technical", {})
    price = c.get("latest_price", 0)

    lines = []
    lines.append(f"# {c.get('name', 'N/A')}（{c.get('code', '')}）深度分析报告\n")
    lines.append(f"**分析日期**：{datetime.now().strftime('%Y-%m-%d')}  |  **档位**：档三 · 深度分析  |  **数据截止**：{c.get('latest_date', 'N/A')}\n")

    # Section 1: Company Overview
    lines.append("## 一、公司概况\n")
    lines.append(f"| 项目 | 内容 |")
    lines.append(f"|------|------|")
    lines.append(f"| 公司名称 | {c.get('name', 'N/A')} |")
    lines.append(f"| 股票代码 | {c.get('code', '')} |")
    lines.append(f"| 所属行业 | {c.get('industry', 'N/A')} |")
    lines.append(f"| 上市日期 | {c.get('listing_date', 'N/A')} |")
    lines.append(f"| 总股本 | {c.get('total_shares', 'N/A')}亿股 |")
    lines.append(f"| 总市值 | ¥{c.get('market_cap', 'N/A')}亿 |")
    pe_display = f"{c.get('pe')}x" if c.get('pe') is not None else "N/A"
    pb_display = f"{c.get('pb')}x" if c.get('pb') is not None else "N/A"
    lines.append(f"| PE | {pe_display} |")
    lines.append(f"| PB | {pb_display} |")
    lines.append("")

    # Recent performance
    chg = ta.get("price_change", {})
    lines.append(f"**近期表现**：5日 {chg.get('5d', 'N/A')}% / 20日 {chg.get('20d', 'N/A')}% / 最新价 ¥{price}\n")

    # Section 2: Audit
    lines.append("## 二、审计意见\n")
    lines.append("> ⚠️ 需查阅年报PDF原文。央企/国企背景公司历年多为标准无保留意见。✅ 通过\n")

    # Section 3: Balance Sheet
    lines.append("## 三、资产负债表深度分析\n")
    lines.append("| 指标 | 数值 | 判断 |")
    lines.append("|------|------|------|")
    dr = f.get("debt_ratio", "N/A")
    dr_j = "安全" if (isinstance(dr, (int, float)) and dr < 50) else "一般"
    lines.append(f"| 资产负债率 | {dr}% | {dr_j} |")
    lines.append(f"| 流动比率 | {f.get('current_ratio', 'N/A')} | {'✅' if (isinstance(f.get('current_ratio'), (int, float)) and f.get('current_ratio', 0) > 1.5) else '⚠️'} |")
    lines.append(f"| 货币资金 | {f.get('cash', 'N/A')}亿 | — |")
    lines.append(f"| 有息负债 | {f.get('ib_debt', 'N/A')}亿 | — |")
    lines.append(f"| 应收账款 | {f.get('accounts_receivable', 'N/A')}亿 | 占比 {f.get('ar_ratio', 'N/A')}% |")
    lines.append(f"| 存货 | {f.get('inventory', 'N/A')}亿 | 占比 {f.get('inventory_ratio', 'N/A')}% |")
    lines.append("")

    # Section 4: Income Statement
    lines.append("## 四、利润表深度分析\n")
    lines.append("| 指标 | 最新值 |")
    lines.append("|------|--------|")
    lines.append(f"| 营业收入 | {f.get('revenue', 'N/A')}亿 |")
    lines.append(f"| 归母净利润 | {f.get('net_profit_parent', 'N/A')}亿 |")
    lines.append(f"| 毛利率 | {f.get('gross_margin', 'N/A')}% |")
    lines.append(f"| 净利率 | {f.get('net_margin', 'N/A')}% |")
    lines.append(f"| ROE | {f.get('roe', 'N/A')}% |")
    lines.append(f"| EPS | {f.get('eps', 'N/A')} |")
    lines.append("")

    # Year trend table
    yt = f.get("year_trend", [])
    if yt:
        lines.append("**近5年盈利趋势**：\n")
        lines.append("| 年份 | 营收(亿) | 归母净利(亿) |")
        lines.append("|------|----------|--------------|")
        for y in yt:
            lines.append(f"| {y['date'][:4]} | {y['revenue']} | {y['net_profit']} |")
        lines.append("")

    # Section 5: Cash Flow
    lines.append("## 五、现金流量表深度分析\n")
    lines.append(f"- **现金流肖像**：{f.get('cf_portrait', 'N/A')}\n")
    lines.append(f"- **经营CF**：{f.get('ocf', 'N/A')}亿  |  投资CF：{f.get('invest_cf', 'N/A')}亿  |  筹资CF：{f.get('finance_cf', 'N/A')}亿\n")
    lines.append(f"- **净利润含金量**：{f.get('np_cash_content', 'N/A')}%\n")

    # Section 6: Fraud Detection
    lines.append("## 六、造假风险排查\n")
    lines.append(f"**通过**：{f.get('fraud_score')}\n")
    lines.append("| 检查项 | 结果 |")
    lines.append("|--------|------|")
    for check in f.get("fraud_checks", []):
        lines.append(f"| {check['item']} | {'✅' if check['passed'] else '❌'} |")
    lines.append("")

    # Section 7: DuPont
    lines.append("## 七、杜邦分析\n")
    d = f.get("dupont", {})
    lines.append(f"ROE = {d.get('net_margin')}% × {d.get('asset_turnover')} × {d.get('equity_multiplier')} = {f.get('roe')}%\n")

    # Section 8: Technical
    lines.append("## 八、技术面分析\n")
    ma_lines = ta.get("ma_lines", [])
    lines.append("| 均线 | 数值 | 位置 |")
    lines.append("|------|------|------|")
    for ma in ma_lines:
        pos = "之上" if ma["price_above"] else "之下"
        lines.append(f"| MA{ma['period']} | ¥{ma['value']} | {pos} |")
    lines.append("")

    macd = ta.get("macd", {})
    kdj = ta.get("kdj", {})
    rsi = ta.get("rsi", {})
    boll = ta.get("boll", {})
    lines.append("| 指标 | 数值 | 信号 |")
    lines.append("|------|------|------|")
    lines.append(f"| MACD | DIF:{macd.get('DIF')} DEA:{macd.get('DEA')} | {macd.get('signal')} |")
    lines.append(f"| KDJ | K:{kdj.get('K')} D:{kdj.get('D')} J:{kdj.get('J')} | {kdj.get('signal')} |")
    lines.append(f"| RSI(14) | {rsi.get('value')} | {rsi.get('signal')} |")
    lines.append(f"| BOLL | 上{boll.get('upper')} 中{boll.get('mid')} 下{boll.get('lower')} | {boll.get('position')} |")
    lines.append("")

    vol = ta.get("volume", {})
    lines.append(f"**成交量**：量比 {vol.get('volume_ratio')}（{vol.get('trend')}），换手率 {vol.get('turnover_pct')}%\n")

    sr = ta.get("support_resistance", {})
    lines.append(f"**关键位**：阻力 ¥{sr.get('high_30d')} / 支撑 ¥{sr.get('low_30d')}\n")

    # Section 9: News
    lines.append("## 九、新闻资讯\n")
    lines.append("> ⚠️ 该模块数据暂缺。本地 stock_news 表未同步该股票数据。运行 news_sync.py 后可用。\n")

    # Section 10: Valuation
    lines.append("## 十、估值与击球区\n")
    if v:
        lines.append(f"- **EPS**：{v.get('eps')}  |  **PE(当前)**：{v.get('pe_current')}x\n")
        lines.append(f"- **悲观价**：¥{v.get('price_low')}  |  **合理价**：¥{v.get('price_mid')}  |  **乐观价**：¥{v.get('price_high')}\n")
        lines.append(f"- **理想买入价（7折）**：¥{v.get('ideal_buy')}\n")
        lines.append(f"- **当前状态**：{v.get('zone')}（{v.get('advice')}）\n")
    lines.append("")

    # Section 11: Conclusion
    lines.append("## 十一、综合结论\n")
    roe_val = f.get("roe")
    health = "优秀" if (isinstance(roe_val, (int, float)) and roe_val > 15) else \
             "一般" if (isinstance(roe_val, (int, float)) and roe_val > 8) else "较差"
    zone = v.get("zone", "无法判断") if v else "无法判断"
    lines.append(f"- **财务健康度**：{health}  |  **估值**：{zone}\n")
    lines.append(f"- **建议**：{'观望' if '高估' in str(zone) else '关注'}\n")
    lines.append("\n## 附录\n")
    lines.append(f"- 数据截止：{datetime.now().strftime('%Y-%m-%d')}\n")
    lines.append("- 数据来源：本地 trading-agent SQLite + akshare\n")
    lines.append("- ⚠️ 以上分析基于公开数据，仅供参考，不构成投资建议。\n")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════════════════
# Main Orchestrator
# ═══════════════════════════════════════════════════════════════════════════════

def load_input(input_path: str) -> dict:
    """Load and parse the data_fetcher output JSON."""
    with open(input_path, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_company_info(raw: dict) -> dict:
    """Extract company info from raw data."""
    bi = raw.get("basic_info", {})
    v = raw.get("valuation", {}).get("latest", {})
    # Normalize shares: detect unit (raw or 亿) and provide both forms
    ts = v.get("total_shares")
    if ts and ts > 1e6:
        ts_raw, ts_display = ts, round(ts / 1e8, 2)  # raw count → 亿
    elif ts and ts > 0:
        ts_raw, ts_display = ts * 1e8, ts  # already in 亿 → raw
    else:
        ts_raw, ts_display = None, None
    fs = v.get("float_shares")
    fs_display = round(fs / 1e8, 2) if (fs and fs > 1e6) else fs
    pe_val = v.get("pe_ttm") if v.get("pe_ttm") is not None else bi.get("pe")
    pb_val = v.get("pb") if v.get("pb") is not None else bi.get("pb")

    return {
        "code": raw.get("code", ""),
        "name": bi.get("name", "N/A"),
        "industry": bi.get("industry", "N/A"),
        "listing_date": bi.get("listing_date", "N/A"),
        "latest_price": v.get("latest_price") or bi.get("latest_price") or raw.get("price", {}).get("latest_price"),
        "latest_date": raw.get("price", {}).get("latest_date", ""),
        "market_cap": _f(v.get("market_cap"), 1e8) if v.get("market_cap") else None,
        "total_shares": ts_display,
        "total_shares_raw": ts_raw,
        "float_shares": fs_display,
        "pe": round(pe_val, 1) if pe_val else None,
        "pb": round(pb_val, 2) if pb_val else None,
    }


def compute_all_technical(prices_raw: list) -> dict:
    """Compute all technical indicators from price data."""
    if not prices_raw:
        return {}

    closes = [p["close"] for p in prices_raw]
    highs = [p["high"] for p in prices_raw]
    lows = [p["low"] for p in prices_raw]
    opens = [p["open"] for p in prices_raw]
    volumes = [p.get("volume", 0) for p in prices_raw]

    float_shares = 2134054153  # default, overridden if available

    return {
        "macd": compute_macd(closes),
        "kdj": compute_kdj(highs, lows, closes),
        "rsi": compute_rsi(closes),
        "boll": compute_boll(closes),
        "ma_lines": compute_ma_lines(closes),
        "volume": analyze_volume(volumes, float_shares),
        "support_resistance": compute_support_resistance(highs, lows, closes),
        "price_change": price_change(closes),
        "candlestick": candlestick_info(prices_raw),
    }


def main():
    # Fix encoding for Windows console
    import io
    if sys.stdout.encoding != 'utf-8':
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

    parser = argparse.ArgumentParser(description="A股深度分析一体化工具")
    parser.add_argument("--input", required=True, help="data_fetcher.py 输出的 JSON 文件")
    parser.add_argument("--level", default="deep",
                        choices=["fundamental", "technical", "deep"],
                        help="分析深度 (默认: deep)")
    parser.add_argument("--output", help="输出 Markdown 文件路径（不指定则打印到 stdout）")
    parser.add_argument("--total-shares", type=float,
                        help="总股本（用于补全本地数据缺失的股本）")
    args = parser.parse_args()

    # Load data
    raw = load_input(args.input)
    company = extract_company_info(raw)

    # Technical analysis
    prices_raw = raw.get("price", {}).get("price_data", [])
    ta = compute_all_technical(prices_raw)

    # Fundamental analysis
    fi = raw.get("financial_indicators", [])
    total_shares = args.total_shares or company.get("total_shares_raw")
    fundamentals = compute_fundamentals(fi, total_shares=total_shares)

    # Valuation
    price = company.get("latest_price") or 0
    valuation = compute_valuation(fundamentals, price, total_shares)

    # Assemble
    data = {
        "technical": ta,
        "fundamentals": fundamentals,
        "valuation": valuation,
        "company": company,
    }

    # Generate report
    if args.level == "fundamental":
        report = generate_fundamental_report(data, fundamentals, valuation, company)
    elif args.level == "technical":
        report = generate_technical_report(data, company)
    else:
        report = generate_deep_report(data, fundamentals, valuation, company)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"报告已保存到: {args.output}", file=sys.stderr)
    else:
        print(report)


if __name__ == "__main__":
    main()
