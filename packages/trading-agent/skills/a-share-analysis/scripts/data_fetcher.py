#!/usr/bin/env python3
"""
A股数据获取模块（本地优先 + 网络 fallback）
- 实时行情：优先本地 SQLite quotes 表，fallback 东方财富 API
- K线数据：优先本地 SQLite klines 表，fallback 东方财富 API
- 财务报表：优先本地 SQLite fundamentals 表，fallback 东方财富 F10
- 股东/分红：仅 akshare 网络获取
- 新增 session 内存缓存，大幅提速二次查询
"""

import argparse
import json
import sys
import time
import os
import sqlite3
from datetime import datetime, timedelta
from typing import Optional, Callable
from functools import wraps
from concurrent.futures import ThreadPoolExecutor, as_completed

# Add stock-data skill scripts to path for hybrid data sourcing
_STOCK_DATA_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "stock-data", "scripts")
if _STOCK_DATA_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _STOCK_DATA_SCRIPTS_DIR)

try:
    import akshare as ak
    import pandas as pd
except ImportError:
    print("错误: 请先安装依赖库")
    print("pip install akshare pandas")
    sys.exit(1)

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

try:
    from jq_data import normalize_code, fetch_latest, get_kline_data
    HAS_STOCK_DATA = True
except Exception:
    HAS_STOCK_DATA = False

# Session-level in-memory cache (same-day only)
_SESSION_CACHE = {}

# ── Local SQLite database helpers ─────────────────────────────────────────────

_LOCAL_DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")


def _get_market_from_code(code: str) -> int:
    """Infer market from code prefix: 1=SH, 0=SZ."""
    return 1 if code.startswith(("60", "68", "90")) else 0


def _query_local_db(sql: str, params: tuple = ()) -> list:
    """Execute a read-only query against the local market.db."""
    if not os.path.exists(_LOCAL_DB_PATH):
        return []
    try:
        conn = sqlite3.connect(_LOCAL_DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception:
        return []


def _get_stock_info_from_local_db(code: str) -> dict:
    """Fetch latest quote from local quotes table."""
    market = _get_market_from_code(code)
    rows = _query_local_db(
        "SELECT * FROM quotes WHERE code = ? AND market = ? ORDER BY snapshot_date DESC LIMIT 1",
        (code, market),
    )
    if not rows:
        return {"error": "no local quote data"}
    r = rows[0]
    return {
        "code": r.get("code"),
        "name": r.get("name"),
        "latest_price": safe_float(r.get("latest")),
        "open": safe_float(r.get("open")),
        "high": safe_float(r.get("high")),
        "low": safe_float(r.get("low")),
        "prev_close": safe_float(r.get("prev_close")),
        "volume": safe_float(r.get("volume")),
        "turnover": safe_float(r.get("turnover")),
        "change_pct": safe_float(r.get("change_pct")),
        "market_cap": safe_float(r.get("total_cap")),
        "float_cap": safe_float(r.get("float_cap")),
        "pe_ttm": safe_float(r.get("pe")),
        "pb": safe_float(r.get("pb")),
        "52w_high": safe_float(r.get("high_52w")),
        "52w_low": safe_float(r.get("low_52w")),
        "_source": "local_db",
    }


def _get_financial_data_from_local_db(code: str) -> dict:
    """Fetch fundamentals from local fundamentals table."""
    market = _get_market_from_code(code)
    rows = _query_local_db(
        "SELECT * FROM fundamentals WHERE code = ? AND market = ? ORDER BY report_date DESC LIMIT 12",
        (code, market),
    )
    if not rows:
        return {"error": "no local fundamentals data"}

    balance_sheet = []
    income_statement = []
    cash_flow = []

    for r in rows:
        report_date = r.get("report_date", "")
        bs_row = {
            "REPORT_DATE": report_date,
            "TOTAL_ASSETS": r.get("total_assets"),
            "TOTAL_LIABILITIES": r.get("total_liabilities"),
            "TOTAL_EQUITY": r.get("total_equity"),
            "TOTAL_PARENT_EQUITY": r.get("parent_equity"),
            "TOTAL_CURRENT_ASSETS": r.get("total_current_assets"),
            "TOTAL_CURRENT_LIAB": r.get("total_current_liab"),
            "INVENTORY": r.get("inventory"),
            "FIXED_ASSET": r.get("fixed_asset"),
            "ACCOUNTS_RECE": r.get("accounts_rece"),
            "MONETARY_FUNDS": r.get("monetary_funds"),
            "SHORT_LOAN": r.get("short_loan"),
            "LONG_LOAN": r.get("long_loan"),
        }
        balance_sheet.append(bs_row)

        inc_row = {
            "REPORT_DATE": report_date,
            "TOTAL_OPERATE_INCOME": r.get("total_revenue"),
            "OPERATE_INCOME": r.get("operate_revenue"),
            "TOTAL_OPERATE_COST": r.get("total_operate_cost"),
            "OPERATE_COST": r.get("operate_cost"),
            "OPERATE_PROFIT": r.get("operate_profit"),
            "TOTAL_PROFIT": r.get("total_profit"),
            "NETPROFIT": r.get("net_profit"),
            "PARENT_NETPROFIT": r.get("parent_net_profit"),
            "BASIC_EPS": r.get("eps"),
            "DILUTED_EPS": r.get("diluted_eps"),
        }
        income_statement.append(inc_row)

        cf_row = {
            "REPORT_DATE": report_date,
            "NETCASH_OPERATE": r.get("operate_cash_flow"),
            "NETCASH_INVEST": r.get("invest_cash_flow"),
            "NETCASH_FINANCE": r.get("finance_cash_flow"),
            "CCE_ADD": r.get("net_cash_increase"),
        }
        cash_flow.append(cf_row)

    return {
        "balance_sheet": balance_sheet,
        "income_statement": income_statement,
        "cash_flow": cash_flow,
        "_source": "local_db",
    }


def _get_price_data_from_local_db(code: str, days: int = 60) -> dict:
    """Fetch klines from local klines table."""
    market = _get_market_from_code(code)
    rows = _query_local_db(
        "SELECT * FROM klines WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq' ORDER BY date DESC LIMIT ?",
        (code, market, days),
    )
    if not rows:
        return {"error": "no local kline data"}

    rows.reverse()  # ascending order
    klines = []
    for r in rows:
        klines.append({
            "date": r.get("date"),
            "open": safe_float(r.get("open")),
            "close": safe_float(r.get("close")),
            "high": safe_float(r.get("high")),
            "low": safe_float(r.get("low")),
            "volume": safe_float(r.get("volume")),
            "money": safe_float(r.get("turnover")),
            "pre_close": safe_float(r.get("pre_close")),
        })

    latest = klines[-1]
    df_slice = klines[-days:] if len(klines) >= days else klines
    highs = [k["high"] for k in df_slice if k["high"] is not None]
    lows = [k["low"] for k in df_slice if k["low"] is not None]
    tail_20 = klines[-20:] if len(klines) >= 20 else klines
    tail_volumes = [k["volume"] for k in tail_20 if k["volume"] is not None]

    close_p = safe_float(latest.get("close"))
    pre_close = safe_float(latest.get("pre_close"))
    change_pct = None
    if close_p is not None and pre_close is not None and pre_close != 0:
        change_pct = round((close_p - pre_close) / pre_close * 100, 4)

    return {
        "latest_price": close_p,
        "latest_date": str(latest.get("date", "")).split()[0],
        "price_change_pct": change_pct,
        "volume": safe_float(latest.get("volume")),
        "turnover": safe_float(latest.get("money")),
        "high_60d": max(highs) if highs else None,
        "low_60d": min(lows) if lows else None,
        "avg_volume_20d": sum(tail_volumes) / len(tail_volumes) if tail_volumes else None,
        "price_data": klines[-30:] if len(klines) >= 30 else klines,
        "_source": "local_db",
    }


def retry_on_failure(max_retries: int = 3, delay: float = 1.0):
    """网络请求重试装饰器"""
    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_error = None
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_error = e
                    if attempt < max_retries - 1:
                        time.sleep(delay * (attempt + 1))
            return {"error": f"重试{max_retries}次后失败: {str(last_error)}"}
        return wrapper
    return decorator


def safe_float(value) -> Optional[float]:
    """安全转换为浮点数"""
    if value is None or value == '' or value == '--':
        return None
    try:
        if pd.isna(value):
            return None
        if isinstance(value, str):
            value = value.replace('%', '').replace(',', '').replace('亿', '')
        return float(value)
    except (ValueError, TypeError):
        return None


def _to_akshare_symbol(code: str) -> str:
    """Convert 6-digit code to SH600519 / SZ000001 format for akshare financial APIs."""
    if code.startswith(('60', '68', '90')):
        return f"SH{code}"
    return f"SZ{code}"


def _to_akshare_lower_symbol(code: str) -> str:
    """Convert 6-digit code to sh600519 / sz000001 format for akshare holder APIs."""
    if code.startswith(('60', '68', '90')):
        return f"sh{code}"
    return f"sz{code}"


def _latest_report_date() -> str:
    """Return the most recent available quarter-end date string (YYYYMMDD) for holder APIs.
    Assumes ~45 days after quarter end for report release."""
    from datetime import date, timedelta
    now = date.today()
    # Quarters in reverse chronological order
    quarters = [
        (12, 31), (9, 30), (6, 30), (3, 31)
    ]
    for year in [now.year, now.year - 1]:
        for qm, qd in quarters:
            q_end = date(year, qm, qd)
            q_publish = q_end + timedelta(days=45)
            if now >= q_publish:
                return f"{year}{qm:02d}{qd:02d}"
    return f"{now.year - 1}1231"


# ── Eastmoney fast API helpers ───────────────────────────────────────────────

_EASTMONEY_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}


def _market_prefix(code: str) -> str:
    """Return 'sh' or 'sz' prefix for Eastmoney APIs."""
    return "sh" if code.startswith(('60', '68', '90')) else "sz"


def _get_eastmoney_quote(code: str, timeout: float = 8.0) -> dict:
    """Fetch real-time quote from Eastmoney API (~0.5-1s)."""
    if not HAS_REQUESTS:
        return {"error": "requests not installed"}
    market = 1 if _market_prefix(code) == "sh" else 0
    secid = f"{market}.{code}"
    api_url = (
        "https://push2.eastmoney.com/api/qt/stock/get"
        "?ut=bd1d9ddb04089700cf9c27f6f7426281"
        "&fltt=2&invt=2&volt=2"
        "&fields=f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f57,f58,f60,f61,f116,f117,f162,f163,f164,f170,f171,f173,f177,f183,f184,f185,f186,f187,f188,f189,f190"
        f"&secid={secid}&_="
    )
    try:
        r = requests.get(api_url, headers=_EASTMONEY_HEADERS, timeout=timeout)
        r.encoding = "utf-8"
        data = r.json()
        d = data.get("data", {})
        return {
            "code": d.get("f57") or code,
            "name": d.get("f58"),
            "latest_price": safe_float(d.get("f43")),
            "open": safe_float(d.get("f46")),
            "high": safe_float(d.get("f44")),
            "low": safe_float(d.get("f45")),
            "prev_close": safe_float(d.get("f60")),
            "volume": safe_float(d.get("f47")),
            "turnover": safe_float(d.get("f48")),
            "change_pct": safe_float(d.get("f170")),
            "market_cap": safe_float(d.get("f116")),
            "float_cap": safe_float(d.get("f117")),
            "pe_ttm": safe_float(d.get("f162")),
            "pb": safe_float(d.get("f183")),
            "52w_high": safe_float(d.get("f51")),
            "52w_low": safe_float(d.get("f52")),
            "_source": "eastmoney",
        }
    except Exception as e:
        return {"error": str(e)}


def _get_eastmoney_company_type(symbol_lower: str) -> str:
    if not HAS_REQUESTS or not HAS_BS4:
        raise RuntimeError("requests and bs4 required")
    url = "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index"
    params = {"type": "web", "code": symbol_lower}
    r = requests.get(url, params=params, headers=_EASTMONEY_HEADERS, timeout=10)
    r.encoding = "utf-8"
    soup = BeautifulSoup(r.text, features="lxml")
    ctype_input = soup.find(attrs={"id": "hidctype"})
    if ctype_input and ctype_input.get("value"):
        return ctype_input["value"]
    raise ValueError("Could not find companyType on Eastmoney F10 page.")


def _get_eastmoney_latest_report_date(endpoint: str, company_type: str, code: str) -> str:
    if not HAS_REQUESTS:
        raise RuntimeError("requests required")
    url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
    params = {"companyType": company_type, "reportDateType": "0", "code": code}
    r = requests.get(url, params=params, headers=_EASTMONEY_HEADERS, timeout=10)
    data = r.json()
    if "data" in data and data["data"]:
        return data["data"][0]["REPORT_DATE"]
    return None


def _get_eastmoney_statement(endpoint: str, company_type: str, code: str, report_date: str) -> dict:
    if not HAS_REQUESTS:
        raise RuntimeError("requests required")
    url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
    params = {
        "companyType": company_type,
        "reportDateType": "0",
        "reportType": "1",
        "code": code,
        "dates": report_date,
    }
    r = requests.get(url, params=params, headers=_EASTMONEY_HEADERS, timeout=10)
    data = r.json()
    return data.get("data", [{}])[0]


def _fetch_eastmoney_statement_single(stmt_name: str, cfg: dict, company_type: str, code_upper: str) -> tuple:
    """Fetch a single financial statement from Eastmoney F10."""
    try:
        report_date = _get_eastmoney_latest_report_date(cfg["date_ep"], company_type, code_upper)
        if not report_date:
            return (stmt_name, {"error": "No report date found"})
        rec = _get_eastmoney_statement(cfg["data_ep"], company_type, code_upper, report_date)
        parsed = {}
        for key, label in cfg["fields"].items():
            raw = rec.get(key)
            parsed[label] = safe_float(raw) if raw is not None else "-"
        return (stmt_name, {
            "report_date": report_date[:10],
            "data": parsed,
        })
    except Exception as e:
        return (stmt_name, {"error": str(e)})


def get_eastmoney_fundamentals(code: str) -> dict:
    """Fetch latest financial statements from Eastmoney F10 (~3-5s)."""
    if not HAS_REQUESTS or not HAS_BS4:
        return {"error": "requests and bs4 required"}
    prefix = _market_prefix(code)
    symbol_lower = f"{prefix}{code}"
    code_upper = f"{prefix.upper()}{code}"

    try:
        company_type = _get_eastmoney_company_type(symbol_lower)
    except Exception as e:
        return {"error": f"Failed to get company type: {e}"}

    statements = {
        "利润表": {
            "date_ep": "lrbDateAjaxNew",
            "data_ep": "lrbAjaxNew",
            "fields": {
                "TOTAL_OPERATE_INCOME": "营业总收入",
                "OPERATE_INCOME": "营业收入",
                "TOTAL_OPERATE_COST": "营业总成本",
                "OPERATE_COST": "营业成本",
                "OPERATE_PROFIT": "营业利润",
                "TOTAL_PROFIT": "利润总额",
                "NETPROFIT": "净利润",
                "PARENT_NETPROFIT": "归母净利润",
                "BASIC_EPS": "基本每股收益",
                "DILUTED_EPS": "稀释每股收益",
            },
        },
        "资产负债表": {
            "date_ep": "zcfzbDateAjaxNew",
            "data_ep": "zcfzbAjaxNew",
            "fields": {
                "TOTAL_ASSETS": "资产总计",
                "TOTAL_LIABILITIES": "负债合计",
                "TOTAL_EQUITY": "所有者权益合计",
                "PARENT_EQUITY": "归母所有者权益",
                "TOTAL_LIAB_EQUITY": "负债和所有者权益总计",
            },
        },
        "现金流量表": {
            "date_ep": "xjllbDateAjaxNew",
            "data_ep": "xjllbAjaxNew",
            "fields": {
                "SALES_SERVICES": "销售商品、提供劳务收到的现金",
                "NETCASH_OPERATE": "经营活动产生的现金流量净额",
                "NETCASH_INVEST": "投资活动产生的现金流量净额",
                "NETCASH_FINANCE": "筹资活动产生的现金流量净额",
                "CASH_EQU_INCREASE": "现金及现金等价物净增加额",
            },
        },
    }

    results = {
        "stock_code": code,
        "market": prefix.upper(),
        "company_type": company_type,
    }

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(_fetch_eastmoney_statement_single, stmt_name, cfg, company_type, code_upper): stmt_name
            for stmt_name, cfg in statements.items()
        }
        for future in as_completed(futures):
            stmt_name, stmt_result = future.result()
            results[stmt_name] = stmt_result

    return results


def get_cache_path(code: str, data_type: str) -> str:
    """获取缓存文件路径"""
    cache_dir = os.path.join(os.path.dirname(__file__), '.cache')
    os.makedirs(cache_dir, exist_ok=True)
    today = datetime.now().strftime('%Y%m%d')
    return os.path.join(cache_dir, f"{code}_{data_type}_{today}.json")


def load_cache(code: str, data_type: str) -> Optional[dict]:
    """加载缓存数据（当天有效）——优先内存，其次磁盘"""
    cache_key = f"{code}_{data_type}"
    today = datetime.now().strftime('%Y%m%d')
    if cache_key in _SESSION_CACHE:
        cached = _SESSION_CACHE[cache_key]
        if cached.get("_cache_date") == today:
            return cached["data"]

    cache_path = get_cache_path(code, data_type)
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            _SESSION_CACHE[cache_key] = {"_cache_date": today, "data": data}
            return data
        except (json.JSONDecodeError, IOError):
            return None
    return None


def save_cache(code: str, data_type: str, data: dict):
    """保存缓存数据——同时写内存和磁盘"""
    today = datetime.now().strftime('%Y%m%d')
    cache_key = f"{code}_{data_type}"
    _SESSION_CACHE[cache_key] = {"_cache_date": today, "data": data}

    cache_path = get_cache_path(code, data_type)
    try:
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, default=str)
    except IOError:
        pass


def _get_stock_info_from_stock_data(code: str) -> dict:
    """Use JoinQuant fetch_latest for fast real-time quote data."""
    if not HAS_STOCK_DATA:
        return {"error": "stock-data skill not available"}
    _ensure_auth()
    try:
        jq_code = normalize_code(code)
        df = fetch_latest(jq_code, fq='pre')
        if df is None or df.empty:
            return {"error": "empty quote from stock-data"}
        row = df.iloc[0]
        close_p = safe_float(row.get("close"))
        pre_close = safe_float(row.get("pre_close"))
        change_pct = None
        if close_p is not None and pre_close is not None and pre_close != 0:
            change_pct = round((close_p - pre_close) / pre_close * 100, 4)
        return {
            "code": code,
            "latest_price": close_p,
            "change_pct": change_pct,
            "open": safe_float(row.get("open")),
            "high": safe_float(row.get("high")),
            "low": safe_float(row.get("low")),
            "volume": safe_float(row.get("volume")),
            "turnover": safe_float(row.get("money")),
            "_source": "stock-data"
        }
    except Exception as e:
        return {"error": str(e)}


def _get_stock_info_from_akshare(code: str) -> dict:
    """Use akshare for comprehensive basic info."""
    try:
        df = ak.stock_individual_info_em(symbol=code)
        info = {}
        for _, row in df.iterrows():
            info[row['item']] = row['value']
        return {
            "code": code,
            "name": info.get("股票简称", ""),
            "industry": info.get("行业", ""),
            "market_cap": safe_float(info.get("总市值")),
            "float_cap": safe_float(info.get("流通市值")),
            "total_shares": safe_float(info.get("总股本")),
            "float_shares": safe_float(info.get("流通股")),
            "pe_ttm": safe_float(info.get("市盈率(动态)")),
            "pb": safe_float(info.get("市净率")),
            "listing_date": info.get("上市时间", ""),
            "_source": "akshare"
        }
    except Exception as e:
        return {"code": code, "error": str(e)}


def _get_stock_info_from_jq_enrichment(code: str) -> dict:
    """Use JoinQuant get_security_info/get_industry for fast static fields."""
    if not HAS_STOCK_DATA:
        return {"error": "stock-data skill not available"}
    _ensure_auth()
    try:
        import jqdatasdk as jq
        jq_code = normalize_code(code)
        info = jq.get_security_info(jq_code)
        result = {
            "name": info.display_name if info and info.display_name else None,
            "listing_date": info.start_date.strftime('%Y-%m-%d') if info and hasattr(info, 'start_date') and info.start_date else None,
        }
        # Industry info
        try:
            today = datetime.now().strftime('%Y-%m-%d')
            ind = jq.get_industry(security=[jq_code], date=today)
            jq_ind = ind.get(jq_code, {})
            # Prefer sw_l1, fallback to jq_l1
            for key in ['sw_l1', 'jq_l1', 'zjw']:
                if key in jq_ind:
                    result["industry"] = jq_ind[key].get('industry_name')
                    break
        except Exception:
            pass
        return result
    except Exception as e:
        return {"error": str(e)}


@retry_on_failure(max_retries=2, delay=1.0)
def get_stock_info(code: str) -> dict:
    """获取股票基本信息（优先本地 SQLite，Eastmoney 补全缺失字段，akshare 最终兜底）"""
    # 1. Primary: local SQLite quotes table (~0.01s)
    result = _get_stock_info_from_local_db(code)
    if "error" not in result and result.get("latest_price") is not None:
        # Try to enrich with local stock info (industry, listing_date)
        try:
            market = _get_market_from_code(code)
            stock_rows = _query_local_db(
                "SELECT name, industry, list_date FROM stocks WHERE code = ? AND market = ? LIMIT 1",
                (code, market),
            )
            if stock_rows:
                sr = stock_rows[0]
                if not result.get("name"):
                    result["name"] = sr.get("name")
                if not result.get("industry"):
                    result["industry"] = sr.get("industry")
                if not result.get("listing_date"):
                    result["listing_date"] = sr.get("list_date")
        except Exception:
            pass
        return result

    # 2. Fallback: Eastmoney fast quote for all fields (~0.5-1s)
    em_quote = _get_eastmoney_quote(code, timeout=3.0)
    if "error" not in em_quote:
        return em_quote

    # 3. Final fallback to slow akshare
    ak_result = _get_stock_info_from_akshare(code)
    if "error" not in ak_result:
        return ak_result

    return result if result else {"code": code, "error": "所有数据源均不可用"}


def _fetch_single_statement(args):
    """Helper for parallel financial statement fetching."""
    key, fetch_func, code, max_records = args
    try:
        df = fetch_func(symbol=_to_akshare_symbol(code))
        if df is not None and not df.empty:
            return key, df.head(max_records).to_dict(orient='records')
        return key, []
    except Exception as e:
        return f"{key}_error", str(e)


def get_financial_data(code: str, years: int = 1) -> dict:
    """获取财务数据（资产负债表、利润表、现金流量表）。
    优先使用本地 SQLite fundamentals 表，缺失时 fallback 到 Eastmoney F10 / akshare。
    """
    # 1. Primary: local SQLite fundamentals table (~0.01s)
    local = _get_financial_data_from_local_db(code)
    if "error" not in local:
        all_ok = local.get("balance_sheet") and local.get("income_statement") and local.get("cash_flow")
        if all_ok:
            # If user wants more historical depth than local has, fallback to network
            if years <= 1 or len(local["balance_sheet"]) >= min(years * 4, 12):
                return local

    # 2. Fallback: Eastmoney F10 (~4-8s, latest quarter only)
    result = {
        "balance_sheet": [],
        "income_statement": [],
        "cash_flow": []
    }
    try:
        em = get_eastmoney_fundamentals(code)
        if "error" not in em:
            if "资产负债表" in em and "error" not in em.get("资产负债表", {}):
                result["balance_sheet"].append({
                    "report_date": em["资产负债表"]["report_date"],
                    **em["资产负债表"]["data"]
                })
            if "利润表" in em and "error" not in em.get("利润表", {}):
                result["income_statement"].append({
                    "report_date": em["利润表"]["report_date"],
                    **em["利润表"]["data"]
                })
            if "现金流量表" in em and "error" not in em.get("现金流量表", {}):
                result["cash_flow"].append({
                    "report_date": em["现金流量表"]["report_date"],
                    **em["现金流量表"]["data"]
                })
    except Exception:
        pass

    all_ok = (
        result.get("balance_sheet")
        and result.get("income_statement")
        and result.get("cash_flow")
    )
    if all_ok and years <= 1:
        return result

    # 3. Final fallback: akshare for historical depth (~60s)
    max_records = min(years * 4, 12)
    fetch_configs = [
        ("balance_sheet", ak.stock_balance_sheet_by_report_em),
        ("income_statement", ak.stock_profit_sheet_by_report_em),
        ("cash_flow", ak.stock_cash_flow_sheet_by_report_em),
    ]

    tasks = [(key, func, code, max_records) for key, func in fetch_configs]
    with ThreadPoolExecutor(max_workers=3) as executor:
        future_map = {executor.submit(_fetch_single_statement, t): t[0] for t in tasks}
        for future in as_completed(future_map):
            try:
                return_key, return_value = future.result(timeout=120.0)
                if return_key.endswith("_error"):
                    result[return_key] = return_value
                else:
                    result[return_key] = return_value
            except Exception as e:
                group_name = future_map[future]
                result[f"{group_name}_error"] = str(e)

    return result


def get_financial_indicators(code: str, limit: int = 8) -> dict:
    """获取财务指标，优先使用快速API，失败时降级到备用API"""
    apis = [ak.stock_financial_abstract, ak.stock_financial_analysis_indicator]

    for api in apis:
        try:
            df = api(symbol=code)
            if df is not None and not df.empty:
                return df.head(limit).to_dict(orient='records')
        except Exception:
            continue

    return []


# ── Data normalization helpers ───────────────────────────────────────────────

_FINANCIAL_FIELD_MAP = {
    # Income statement
    "TOTAL_OPERATE_INCOME": "营业总收入",
    "OPERATE_INCOME": "营业收入",
    "TOTAL_OPERATE_COST": "营业总成本",
    "OPERATE_COST": "营业成本",
    "OPERATE_PROFIT": "营业利润",
    "TOTAL_PROFIT": "利润总额",
    "NETPROFIT": "净利润",
    "PARENT_NETPROFIT": "归母净利润",
    "BASIC_EPS": "基本每股收益",
    "DILUTED_EPS": "稀释每股收益",
    "SALES_SERVICES": "销售商品提供劳务收到的现金",
    # Balance sheet
    "TOTAL_ASSETS": "资产总计",
    "TOTAL_LIABILITIES": "负债合计",
    "TOTAL_EQUITY": "所有者权益合计",
    "TOTAL_PARENT_EQUITY": "归母所有者权益",
    "TOTAL_LIAB_EQUITY": "负债和所有者权益总计",
    # Cash flow
    "NETCASH_OPERATE": "经营活动产生的现金流量净额",
    "NETCASH_INVEST": "投资活动产生的现金流量净额",
    "NETCASH_FINANCE": "筹资活动产生的现金流量净额",
    "CCE_ADD": "现金及现金等价物净增加额",
    "END_CCE": "期末现金及现金等价物余额",
}


def _add_chinese_aliases(records: list) -> list:
    """Add Chinese key aliases to financial statement records (保留原英文键)."""
    if not records:
        return records
    for rec in records:
        for en_key, cn_key in _FINANCIAL_FIELD_MAP.items():
            if en_key in rec and cn_key not in rec:
                rec[cn_key] = rec[en_key]
    return records


def _compute_growth_rates(vertical: list, result: dict) -> list:
    """Compute revenue and profit growth rates from statement sequence."""
    if len(vertical) < 2:
        return vertical
    for i in range(len(vertical) - 1):
        curr = vertical[i]
        prev = vertical[i + 1]
        rev_c = safe_float(curr.get("营业总收入"))
        rev_p = safe_float(prev.get("营业总收入"))
        if rev_c is not None and rev_p and rev_p != 0:
            curr["营业收入增长率"] = round((rev_c - rev_p) / rev_p * 100, 2)
        prof_c = safe_float(curr.get("净利润"))
        prof_p = safe_float(prev.get("净利润"))
        if prof_c is not None and prof_p and prof_p != 0:
            curr["净利润增长率"] = round((prof_c - prof_p) / prof_p * 100, 2)
    return vertical


def _compute_missing_ratios(result: dict) -> list:
    """Compute common financial ratios from statements when indicators are missing."""
    fd = result.get("financial_data", {})
    bs = fd.get("balance_sheet", [])
    inc = fd.get("income_statement", [])
    if not bs or not inc:
        return []

    ratios = []
    # Pair records by report_date (take latest available from each)
    for i in range(min(len(bs), len(inc), 8)):
        b = bs[i]
        p = inc[i]
        row = {"日期": str(b.get("REPORT_DATE", ""))[:10]}

        total_assets = safe_float(b.get("TOTAL_ASSETS"))
        total_liab = safe_float(b.get("TOTAL_LIABILITIES"))
        current_assets = safe_float(b.get("TOTAL_CURRENT_ASSETS"))
        current_liab = safe_float(b.get("TOTAL_CURRENT_LIAB"))
        inventory = safe_float(b.get("INVENTORY"))
        parent_equity = safe_float(b.get("TOTAL_PARENT_EQUITY"))
        revenue = safe_float(p.get("TOTAL_OPERATE_INCOME"))
        operate_cost = safe_float(p.get("OPERATE_COST"))
        net_profit = safe_float(p.get("NETPROFIT"))
        parent_net_profit = safe_float(p.get("PARENT_NETPROFIT"))

        if revenue and revenue != 0:
            if operate_cost is not None:
                row["销售毛利率"] = round((revenue - operate_cost) / revenue * 100, 2)
            if net_profit is not None:
                row["销售净利率"] = round(net_profit / revenue * 100, 2)
            if total_assets and total_assets != 0:
                row["总资产周转率"] = round(revenue / total_assets, 4)
        if parent_equity and parent_equity != 0:
            if parent_net_profit is not None:
                row["净资产收益率"] = round(parent_net_profit / parent_equity * 100, 2)
            if total_assets and total_assets != 0:
                row["权益乘数"] = round(total_assets / parent_equity, 4)
        if total_assets and total_assets != 0 and total_liab is not None:
            row["资产负债率"] = round(total_liab / total_assets * 100, 2)
        if current_liab and current_liab != 0:
            if current_assets is not None:
                row["流动比率"] = round(current_assets / current_liab, 2)
            if current_assets is not None and inventory is not None:
                row["速动比率"] = round((current_assets - inventory) / current_liab, 2)
        ratios.append(row)
    return ratios


def _normalize_financial_data(result: dict) -> dict:
    """Normalize raw akshare data into downstream-friendly format."""
    fd = result.get("financial_data", {})
    # Add Chinese aliases to statements
    for key in ["balance_sheet", "income_statement", "cash_flow"]:
        if key in fd and isinstance(fd[key], list):
            fd[key] = _add_chinese_aliases(fd[key])

    # Transpose financial_indicators from horizontal to vertical
    indicators = result.get("financial_indicators", [])
    vertical = []
    if indicators and len(indicators) > 0:
        # Detect date columns (8-digit numeric strings)
        sample_keys = list(indicators[0].keys())
        date_cols = [k for k in sample_keys if isinstance(k, str) and k.isdigit() and len(k) == 8]
        meta_cols = [k for k in sample_keys if k not in date_cols]
        name_col = None
        for mc in meta_cols:
            if "指标" in mc:
                name_col = mc
                break
        if name_col and date_cols:
            for dc in sorted(date_cols, reverse=True):
                row = {"日期": f"{dc[:4]}-{dc[4:6]}-{dc[6:]}"}
                for ind in indicators:
                    ind_name = ind.get(name_col, "")
                    if ind_name:
                        row[ind_name] = safe_float(ind.get(dc))
                vertical.append(row)

    # If common ratios are missing, compute them from statements
    has_ratios = False
    if vertical:
        first = vertical[0]
        has_ratios = any(k in first for k in ["净资产收益率", "销售毛利率", "资产负债率"])
    if not has_ratios:
        computed = _compute_missing_ratios(result)
        if computed:
            # Merge computed ratios with existing vertical records by date
            vert_map = {r.get("日期", ""): r for r in vertical}
            for cr in computed:
                d = cr.get("日期", "")
                if d in vert_map:
                    vert_map[d].update(cr)
                else:
                    vertical.append(cr)
            vertical.sort(key=lambda x: x.get("日期", ""), reverse=True)

    # Compute YoY growth rates from statement data
    vertical = _compute_growth_rates(vertical, result)

    if vertical:
        result["financial_indicators"] = vertical
    return result


def _get_valuation_from_akshare(code: str) -> dict:
    """Fetch valuation from akshare (reliable but slower)."""
    df = ak.stock_individual_info_em(symbol=code)
    info = {}
    for _, row in df.iterrows():
        info[row['item']] = row['value']
    return {
        "latest": {
            "pe_ttm": safe_float(info.get("市盈率(动态)")),
            "pb": safe_float(info.get("市净率")),
            "market_cap": safe_float(info.get("总市值")),
            "float_cap": safe_float(info.get("流通市值")),
            "total_shares": safe_float(info.get("总股本")),
            "float_shares": safe_float(info.get("流通股")),
        },
        "_source": "akshare",
    }


def get_valuation_data(code: str) -> dict:
    """获取估值数据（Eastmoney 与 akshare 竞速，取先成功的结果）"""
    def _eastmoney_task():
        em = _get_eastmoney_quote(code)
        if "error" not in em:
            return {
                "latest": {
                    "pe_ttm": em.get("pe_ttm"),
                    "pb": em.get("pb"),
                    "market_cap": em.get("market_cap"),
                    "float_cap": em.get("float_cap"),
                    "52w_high": em.get("52w_high"),
                    "52w_low": em.get("52w_low"),
                },
                "_source": "eastmoney",
            }
        return {"error": em.get("error", "unknown")}

    def _akshare_task():
        try:
            return _get_valuation_from_akshare(code)
        except Exception as e:
            return {"error": str(e)}

    executor = ThreadPoolExecutor(max_workers=2)
    futures = [executor.submit(_eastmoney_task), executor.submit(_akshare_task)]
    try:
        for future in as_completed(futures):
            result = future.result()
            if "error" not in result:
                return result
    finally:
        executor.shutdown(wait=False)

    return {"error": "估值数据获取失败", "note": "将使用基本信息中的估值"}


@retry_on_failure(max_retries=2, delay=1.0)
def get_holder_data(code: str) -> dict:
    """获取股东信息（Top10 流通股东，akshare 股东户数接口极慢已移除）"""
    result = {}

    try:
        df_top10 = ak.stock_gdfx_top_10_em(symbol=_to_akshare_lower_symbol(code), date=_latest_report_date())
        if df_top10 is not None and not df_top10.empty:
            result["top_10_holders"] = df_top10.head(10).to_dict(orient='records')
    except Exception as e:
        result["top_10_holders_error"] = str(e)

    return result


@retry_on_failure(max_retries=2, delay=1.0)
def get_dividend_data(code: str) -> dict:
    """获取分红数据，优先使用主API，失败时降级到备用API"""
    apis = [
        lambda c: ak.stock_dividend_cninfo(symbol=c),
        lambda c: ak.stock_history_dividend_detail(symbol=c, indicator="分红"),
    ]

    for api in apis:
        try:
            df = api(code)
            if df is not None and not df.empty:
                return {
                    "dividend_history": df.to_dict(orient='records'),
                    "dividend_count": len(df)
                }
        except Exception:
            continue

    return {"dividend_history": [], "dividend_count": 0}


@retry_on_failure(max_retries=2, delay=1.0)
def _get_price_data_from_stock_data(code: str, days: int = 60) -> dict:
    """Use stock-data (JoinQuant) for K-line OHLCV data."""
    if not HAS_STOCK_DATA:
        return {"error": "stock-data skill not available"}
    _ensure_auth()
    try:
        end_date = datetime.now().strftime('%Y%m%d')
        start_date = (datetime.now() - timedelta(days=days + 5)).strftime('%Y%m%d')
        jq_code = normalize_code(code)
        df = get_kline_data(
            jq_code,
            start_date=start_date,
            end_date=end_date,
            frequency="daily",
            fq="pre",
        )
        if df is None or df.empty:
            return {"error": "empty klines from stock-data"}
        klines = df.to_dict(orient='records')
        if not klines:
            return {"error": "empty klines from stock-data"}
        for k in klines:
            if "date" in k and hasattr(k["date"], "strftime"):
                k["date"] = k["date"].strftime('%Y-%m-%d')
        latest = klines[-1]
        df_slice = klines[-days:] if len(klines) >= days else klines
        highs = [k["high"] for k in df_slice if k.get("high") is not None]
        lows = [k["low"] for k in df_slice if k.get("low") is not None]
        tail_20 = klines[-20:] if len(klines) >= 20 else klines
        tail_volumes = [k["volume"] for k in tail_20 if k.get("volume") is not None]
        close_p = safe_float(latest.get("close"))
        pre_close = safe_float(latest.get("pre_close"))
        change_pct = None
        if close_p is not None and pre_close is not None and pre_close != 0:
            change_pct = round((close_p - pre_close) / pre_close * 100, 4)
        return {
            "latest_price": close_p,
            "latest_date": str(latest.get("date", "")).split()[0],
            "price_change_pct": change_pct,
            "volume": safe_float(latest.get("volume")),
            "turnover": safe_float(latest.get("money")),
            "high_60d": max(highs) if highs else None,
            "low_60d": min(lows) if lows else None,
            "avg_volume_20d": sum(tail_volumes) / len(tail_volumes) if tail_volumes else None,
            "price_data": klines[-30:] if len(klines) >= 30 else klines,
            "_source": "stock-data"
        }
    except Exception as e:
        return {"error": str(e)}


def _get_price_data_from_akshare(code: str, days: int = 60) -> dict:
    """Use akshare for price data fallback."""
    try:
        end_date = datetime.now().strftime('%Y%m%d')
        start_date = (datetime.now() - timedelta(days=days)).strftime('%Y%m%d')

        df = ak.stock_zh_a_hist(symbol=code, period="daily",
                                start_date=start_date, end_date=end_date, adjust="qfq")
        if df is not None and not df.empty:
            latest = df.iloc[-1]
            return {
                "latest_price": safe_float(latest['收盘']),
                "latest_date": str(latest['日期']),
                "price_change_pct": safe_float(latest['涨跌幅']),
                "volume": safe_float(latest['成交量']),
                "turnover": safe_float(latest['成交额']),
                "high_60d": safe_float(df['最高'].max()),
                "low_60d": safe_float(df['最低'].min()),
                "avg_volume_20d": safe_float(df.tail(20)['成交量'].mean()),
                "price_data": df.tail(30).to_dict(orient='records'),
                "_source": "akshare"
            }
        return {"error": "empty data from akshare"}
    except Exception as e:
        return {"error": str(e)}


@retry_on_failure(max_retries=2, delay=1.0)
def get_price_data(code: str, days: int = 60) -> dict:
    """获取价格数据（优先本地 SQLite klines 表，fallback 东方财富/akshare）"""
    # 1. Primary: local SQLite klines table (~0.01s)
    result = _get_price_data_from_local_db(code, days)
    if "error" not in result:
        return result

    # 2. Fallback: stock-data (JoinQuant) / akshare
    result = _get_price_data_from_stock_data(code, days)
    if "error" not in result:
        return result
    return _get_price_data_from_akshare(code, days)


@retry_on_failure(max_retries=2, delay=1.0)
def get_index_constituents(index_name: str) -> list:
    """获取指数成分股"""
    index_map = {
        "hs300": "000300",
        "zz500": "000905",
        "zz1000": "000852",
        "cyb": "399006",
        "kcb": "000688"
    }

    index_code = index_map.get(index_name)
    if not index_code:
        return []

    try:
        df = ak.index_stock_cons(symbol=index_code)
        if df is not None and not df.empty:
            return df['品种代码'].tolist()
        return []
    except Exception as e:
        print(f"获取指数成分股失败: {e}")
        return []


def get_all_a_stocks() -> list:
    """获取全部A股代码"""
    try:
        df = ak.stock_zh_a_spot()
        if df is not None and not df.empty:
            return df['代码'].tolist()
        return []
    except Exception as e:
        print(f"获取全部A股失败: {e}")
        return []


def _ensure_auth():
    """Authenticate JoinQuant in current thread (jqdatasdk auth is thread-local)."""
    if HAS_STOCK_DATA:
        try:
            import jqdatasdk as jq
            if not jq.is_auth():
                jq.auth('13758103948', 'DingPanBao2021')
        except Exception:
            pass


def _fetch_group(name, code, years, data_type="all"):
    """Helper for parallel fetch groups."""
    _ensure_auth()
    if name == "basic":
        return {"basic_info": get_stock_info(code)}
    elif name == "financial":
        return {
            "financial_data": get_financial_data(code, years),
            "financial_indicators": get_financial_indicators(code),
        }
    elif name == "valuation":
        return {
            "valuation": get_valuation_data(code),
            "price": get_price_data(code),
        }
    elif name == "holder":
        return {
            "holder": get_holder_data(code),
            "dividend": get_dividend_data(code),
        }
    return {}


def fetch_stock_data(code: str, data_type: str = "all", years: int = 1, use_cache: bool = True) -> dict:
    """获取单只股票的数据（默认 1 年财报），内部按数据类型并行拉取。

    data_type 说明：
    - all: basic + financial + valuation（不包含 holder，避免超长等待）
    - complete: basic + financial + valuation + holder（完整数据）
    - basic / financial / valuation / holder: 单独获取某一类数据
    """
    if use_cache:
        cached = load_cache(code, data_type)
        if cached:
            return cached

    result = {
        "code": code,
        "fetch_time": datetime.now().isoformat(),
        "data_type": data_type
    }

    # Determine which groups to fetch
    groups = []
    if data_type in ["all", "complete", "basic"]:
        groups.append("basic")
    if data_type in ["all", "complete", "financial"]:
        groups.append("financial")
    if data_type in ["all", "complete", "valuation"]:
        groups.append("valuation")
    if data_type in ["complete", "holder"]:
        groups.append("holder")

    _ensure_auth()

    # Serial fetch: jqdatasdk has a 1-connection limit per account, so any
    # groups that use JoinQuant (basic, valuation) must not run in parallel.
    # Running all groups serially also avoids proxy/connection pool contention.
    for g in groups:
        try:
            result.update(_fetch_group(g, code, years, data_type))
        except Exception as e:
            result[f"{g}_error"] = str(e)

    # Normalize raw akshare data for downstream analyzers
    result = _normalize_financial_data(result)

    if use_cache:
        save_cache(code, data_type, result)

    return result


def fetch_multiple_stocks(codes: list, data_type: str = "basic") -> dict:
    """获取多只股票数据"""
    result = {
        "fetch_time": datetime.now().isoformat(),
        "stocks": [],
        "success_count": 0,
        "fail_count": 0
    }

    total = len(codes)
    for i, code in enumerate(codes):
        print(f"[{i+1}/{total}] 获取 {code}...")
        try:
            stock_data = fetch_stock_data(code, data_type, use_cache=True)
            if "error" not in stock_data.get("basic_info", {}):
                result["stocks"].append(stock_data)
                result["success_count"] += 1
            else:
                result["fail_count"] += 1
        except Exception as e:
            print(f"  获取失败: {e}")
            result["fail_count"] += 1

        if i < total - 1:
            time.sleep(0.5)

    return result


def main():
    parser = argparse.ArgumentParser(description="A股数据获取工具（混合数据源优化版）")
    parser.add_argument("--code", type=str, help="股票代码 (如: 600519)")
    parser.add_argument("--codes", type=str, help="多个股票代码，逗号分隔 (如: 600519,000858)")
    parser.add_argument("--data-type", type=str, default="basic",
                       choices=["all", "basic", "financial", "valuation", "holder"],
                       help="数据类型 (默认: basic)")
    parser.add_argument("--years", type=int, default=1, help="获取多少年的历史数据 (默认: 1)")
    parser.add_argument("--scope", type=str, help="筛选范围: hs300/zz500/cyb/kcb/all")
    parser.add_argument("--no-cache", action="store_true", help="不使用缓存")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    result = {}

    if args.code:
        result = fetch_stock_data(args.code, args.data_type, args.years,
                                   use_cache=not args.no_cache)
    elif args.codes:
        codes = [c.strip() for c in args.codes.split(",")]
        result = fetch_multiple_stocks(codes, args.data_type)
    elif args.scope:
        if args.scope == "all":
            codes = get_all_a_stocks()
        else:
            codes = get_index_constituents(args.scope)
        result = {"scope": args.scope, "stocks": codes, "count": len(codes)}
    else:
        print("请提供 --code, --codes 或 --scope 参数")
        sys.exit(1)

    output = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"\n数据已保存到: {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
