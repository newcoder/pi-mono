#!/usr/bin/env python3
"""
A-Share Analysis 全市场数据每日定时同步脚本
===============================================
同步内容: stocks, quotes, klines, fundamentals, industries, concepts, stock_news, market_news
运行建议: 每天 01:20 (A股收盘后数据稳定时段)
用法:     python daily_sync.py [--validate-only] [--phase PHASE]

依赖:     jqdatasdk, akshare, pandas, requests, beautifulsoup4
"""

import argparse
import json
import os
import sys
import io
import sqlite3
import time
import traceback
import logging
import warnings
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Tuple

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# ── Paths ──────────────────────────────────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_DIR = os.path.join(os.path.expanduser("~"), ".agents", "skills", "a-share-analysis", "scripts")
if _SKILL_DIR not in sys.path:
    sys.path.insert(0, _SKILL_DIR)

_DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")
_LOG_DIR = os.path.expanduser("~/.trading-agent/logs")
os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
os.makedirs(_LOG_DIR, exist_ok=True)

# ── Logging setup ──────────────────────────────────────────────────────────
_TODAY = datetime.now().strftime('%Y%m%d')
_LOG_FILE = os.path.join(_LOG_DIR, f"sync_{_TODAY}.log")

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(_LOG_FILE, encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger('daily_sync')

# ── Result tracking ────────────────────────────────────────────────────────
_sync_results = {
    "start_time": datetime.now().isoformat(),
    "phases": {},
    "errors": [],
    "warnings": [],
}


def _phase(name: str):
    """Decorator to wrap a sync phase with timing and error handling."""
    def decorator(func):
        def wrapper(*args, **kwargs):
            logger.info(f"\n{'='*60}")
            logger.info(f"PHASE: {name}")
            logger.info(f"{'='*60}")
            start = time.time()
            result = {"status": "success", "detail": {}}
            try:
                detail = func(*args, **kwargs)
                if detail:
                    result["detail"] = detail
            except Exception as e:
                result["status"] = "failed"
                result["error"] = str(e)
                result["traceback"] = traceback.format_exc()
                _sync_results["errors"].append({"phase": name, "error": str(e)})
                logger.error(f"Phase '{name}' failed: {e}")
                logger.debug(traceback.format_exc())
            finally:
                elapsed = time.time() - start
                result["elapsed_seconds"] = round(elapsed, 2)
                _sync_results["phases"][name] = result
                status_icon = "✓" if result["status"] == "success" else "✗"
                logger.info(f"Phase '{name}' {status_icon} in {elapsed:.1f}s")
            return result
        return wrapper
    return decorator


# ── DB helpers ─────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_tables():
    """Ensure all required tables exist."""
    conn = get_db()
    cur = conn.cursor()
    now = datetime.now().isoformat()

    # stocks
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stocks (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            name TEXT,
            industry TEXT,
            list_date TEXT,
            updated_at TEXT,
            PRIMARY KEY (code, market)
        )
    """)

    # quotes
    cur.execute("""
        CREATE TABLE IF NOT EXISTS quotes (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            snapshot_date TEXT NOT NULL,
            name TEXT,
            latest REAL,
            open REAL,
            high REAL,
            low REAL,
            prev_close REAL,
            volume REAL,
            turnover REAL,
            change_pct REAL,
            pe REAL,
            pb REAL,
            total_cap REAL,
            float_cap REAL,
            high_52w REAL,
            low_52w REAL,
            updated_at TEXT,
            PRIMARY KEY (code, market, snapshot_date)
        )
    """)

    # klines
    cur.execute("""
        CREATE TABLE IF NOT EXISTS klines (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            period TEXT NOT NULL,
            adjust TEXT NOT NULL,
            date TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume REAL,
            turnover REAL,
            change_pct REAL,
            change_amount REAL,
            amplitude REAL,
            pre_close REAL,
            PRIMARY KEY (code, market, period, adjust, date)
        )
    """)

    # fundamentals
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fundamentals (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            report_date TEXT NOT NULL,
            total_revenue REAL,
            operate_revenue REAL,
            operate_cost REAL,
            total_operate_cost REAL,
            operate_profit REAL,
            total_profit REAL,
            net_profit REAL,
            parent_net_profit REAL,
            eps REAL,
            diluted_eps REAL,
            research_expense REAL,
            sale_expense REAL,
            manage_expense REAL,
            finance_expense REAL,
            interest_expense REAL,
            income_tax REAL,
            total_assets REAL,
            total_liabilities REAL,
            total_equity REAL,
            parent_equity REAL,
            total_current_assets REAL,
            total_current_liab REAL,
            inventory REAL,
            accounts_rece REAL,
            fixed_asset REAL,
            short_loan REAL,
            long_loan REAL,
            total_noncurrent_liab REAL,
            monetary_funds REAL,
            operate_cash_flow REAL,
            invest_cash_flow REAL,
            finance_cash_flow REAL,
            net_cash_increase REAL,
            construct_long_asset REAL,
            updated_at TEXT,
            PRIMARY KEY (code, market, report_date)
        )
    """)

    # industries
    cur.execute("""
        CREATE TABLE IF NOT EXISTS industries (
            industry_code TEXT NOT NULL,
            name TEXT,
            standard TEXT NOT NULL,
            level INTEGER,
            parent_code TEXT,
            start_date TEXT,
            updated_at TEXT,
            PRIMARY KEY (industry_code, standard)
        )
    """)

    # stock_industries
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_industries (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            industry_code TEXT NOT NULL,
            standard TEXT NOT NULL,
            updated_at TEXT,
            PRIMARY KEY (code, market, industry_code, standard)
        )
    """)

    # concept_stocks
    cur.execute("""
        CREATE TABLE IF NOT EXISTS concept_stocks (
            concept TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT,
            updated_at TEXT,
            PRIMARY KEY (concept, code)
        )
    """)

    conn.commit()
    conn.close()
    logger.info("Database tables ensured.")


# ── Phase 1: Sync Stocks ───────────────────────────────────────────────────

@_phase("stocks")
def sync_stocks() -> dict:
    """Sync full stock list from JoinQuant."""
    from jq_data import get_all_stocks, normalize_code
    import jqdatasdk as jq

    if not jq.is_auth():
        jq.auth('13758103948', 'DingPanBao2021')

    df = get_all_stocks()
    if df is None or len(df) == 0:
        raise RuntimeError("Failed to fetch stock list from JoinQuant")

    conn = get_db()
    cur = conn.cursor()
    now = datetime.now().isoformat()
    count = 0

    for jq_code, row in df.iterrows():
        code = str(jq_code).split('.')[0]
        market = 1 if str(jq_code).endswith('XSHG') else 0
        name = row.get('display_name', '')
        start_date = row.get('start_date')
        list_date = str(start_date)[:10] if start_date is not None else None

        cur.execute(
            """INSERT OR REPLACE INTO stocks (code, market, name, list_date, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (code, market, name, list_date, now)
        )
        count += 1

    conn.commit()
    conn.close()
    logger.info(f"Synced {count} stocks.")
    return {"count": count}


# ── Phase 2: Sync Quotes ───────────────────────────────────────────────────

def _is_a_share_trading_hours() -> bool:
    """Check if current time is within A-share trading hours (Mon-Fri 09:30-11:30, 13:00-15:00)."""
    now = datetime.now()
    if now.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    hm = now.hour * 100 + now.minute
    # Trading sessions: 0930-1130, 1300-1500
    return (930 <= hm <= 1130) or (1300 <= hm <= 1500)


def _sync_quotes_from_klines() -> dict:
    """Fallback: derive quotes from latest klines when akshare is unavailable."""
    conn = get_db()
    today = datetime.now().strftime('%Y-%m-%d')
    now = datetime.now().isoformat()

    # Get latest date from klines
    row = conn.execute(
        "SELECT MAX(date) as max_date FROM klines WHERE period = 'daily' AND adjust = 'bfq'"
    ).fetchone()
    latest_kline_date = row["max_date"] if row else None

    if not latest_kline_date:
        raise RuntimeError("No kline data available for fallback quotes")

    logger.info(f"Deriving quotes from klines date {latest_kline_date}...")

    cur = conn.cursor()
    klines = conn.execute(
        """SELECT code, market, date, open, high, low, close as latest, volume,
                  turnover, change_pct, pre_close
           FROM klines
           WHERE period = 'daily' AND adjust = 'bfq' AND date = ?""",
        (latest_kline_date,)
    ).fetchall()

    count = 0
    for k in klines:
        code = k["code"]
        market = k["market"]
        # For snapshot_date, use today if kline is today's data, else use kline date
        snapshot_date = today if latest_kline_date == today else latest_kline_date

        cur.execute(
            """INSERT OR REPLACE INTO quotes
               (code, market, snapshot_date, name, latest, open, high, low, prev_close,
                volume, turnover, change_pct, pe, pb, total_cap, float_cap, high_52w, low_52w, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                code, market, snapshot_date, None,
                k["latest"], k["open"], k["high"], k["low"], k["pre_close"],
                k["volume"], k["turnover"], k["change_pct"],
                None, None, None, None, None, None,
                now
            )
        )
        count += 1

    conn.commit()
    conn.close()
    logger.info(f"Derived {count} quotes from klines ({latest_kline_date}).")
    return {"count": count, "date": latest_kline_date, "source": "klines_fallback"}


@_phase("quotes")
def sync_quotes() -> dict:
    """Sync daily quotes. Uses akshare during trading hours, falls back to klines otherwise."""
    is_trading = _is_a_share_trading_hours()

    if not is_trading:
        logger.info("Non-trading hours: skipping akshare, using klines fallback for quotes.")
        return _sync_quotes_from_klines()

    # Trading hours: try akshare first
    try:
        import akshare as ak
    except ImportError:
        logger.warning("akshare not installed. Falling back to klines.")
        return _sync_quotes_from_klines()

    logger.info("Trading hours: fetching all-market quotes from akshare...")
    # Clear proxy env to avoid connection issues
    for key in list(os.environ.keys()):
        if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy'):
            os.environ.pop(key, None)

    df = None
    for attempt in range(3):
        try:
            df = ak.stock_zh_a_spot_em()
            if df is not None and not df.empty:
                break
        except Exception as e:
            logger.warning(f"  akshare quote fetch attempt {attempt+1}/3 failed: {e}")
            if attempt < 2:
                time.sleep(5)

    if df is None or df.empty:
        logger.warning("akshare unavailable during trading hours. Falling back to klines-derived quotes...")
        return _sync_quotes_from_klines()

    conn = get_db()
    cur = conn.cursor()
    today = datetime.now().strftime('%Y-%m-%d')
    now = datetime.now().isoformat()
    count = 0

    def _market_from_code(code: str) -> int:
        return 1 if str(code).startswith(("60", "68", "90")) else 0

    def _safe_float(v):
        if v is None or v == '' or v == '-':
            return None
        try:
            return float(v)
        except (ValueError, TypeError):
            return None

    for _, row in df.iterrows():
        code = str(row.get("代码", "")).strip()
        if not code or not code.isdigit():
            continue
        market = _market_from_code(code)
        name = row.get("名称", "")

        latest = _safe_float(row.get("最新价"))
        if latest is None:
            latest = _safe_float(row.get("收盘价"))

        cur.execute(
            """INSERT OR REPLACE INTO quotes
               (code, market, snapshot_date, name, latest, open, high, low, prev_close,
                volume, turnover, change_pct, pe, pb, total_cap, float_cap, high_52w, low_52w, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                code, market, today, name,
                latest,
                _safe_float(row.get("开盘价")),
                _safe_float(row.get("最高价")),
                _safe_float(row.get("最低价")),
                _safe_float(row.get("昨收")),
                _safe_float(row.get("成交量")),
                _safe_float(row.get("成交额")),
                _safe_float(row.get("涨跌幅")),
                _safe_float(row.get("市盈率-动态") or row.get("动态市盈率")),
                _safe_float(row.get("市净率")),
                _safe_float(row.get("总市值")),
                _safe_float(row.get("流通市值")),
                _safe_float(row.get("52周最高")),
                _safe_float(row.get("52周最低")),
                now
            )
        )
        count += 1

    conn.commit()
    conn.close()
    logger.info(f"Synced {count} quotes for {today} from akshare.")
    return {"count": count, "date": today, "source": "akshare"}


# ── Phase 3: Sync Klines ───────────────────────────────────────────────────

@_phase("klines")
def sync_klines() -> dict:
    """Sync daily klines for all stocks from JoinQuant (incremental)."""
    from jq_data import normalize_code, fetch
    import jqdatasdk as jq
    import pandas as pd

    if not jq.is_auth():
        jq.auth('13758103948', 'DingPanBao2021')

    conn = get_db()

    # Get all stocks
    stocks = conn.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
    if not stocks:
        conn.close()
        raise RuntimeError("No stocks found. Run Phase 1 first.")

    total = len(stocks)
    logger.info(f"Syncing klines for {total} stocks...")

    # Determine date range: from 90 days ago to today
    end_date = datetime.now().strftime('%Y-%m-%d')
    start_date = (datetime.now() - timedelta(days=90)).strftime('%Y-%m-%d')

    synced = 0
    failed = 0
    total_rows = 0

    # Process in batches of 50 (jq panel fetch limit considerations)
    batch_size = 50
    for i in range(0, total, batch_size):
        batch = stocks[i:i + batch_size]
        jq_codes = []
        code_map = {}
        for s in batch:
            code = s["code"]
            market = s["market"]
            jq_code = normalize_code(code)
            jq_codes.append(jq_code)
            code_map[jq_code] = (code, market)

        try:
            df = jq.get_price(jq_codes, start_date=start_date, end_date=end_date,
                       frequency='daily', fq=None, fields=['open', 'close', 'low', 'high', 'volume', 'money', 'pre_close'],
                       panel=True, skip_paused=False)

            if df is None or len(df) == 0:
                failed += len(batch)
                continue

            # Normalize panel DataFrame
            if isinstance(df.columns, pd.MultiIndex):
                df = df.stack(level=1).reset_index()
                if 'level_1' in df.columns:
                    df.rename(columns={'level_1': 'code'}, inplace=True)
                if 'level_0' in df.columns:
                    df.rename(columns={'level_0': 'date'}, inplace=True)

            for _, row in df.iterrows():
                jq_code = row.get('code')
                if pd.isna(jq_code):
                    continue
                code, market = code_map.get(jq_code, (str(jq_code).split('.')[0], 0))

                date_str = str(row.get('date') or row.get('time', '')).split(' ')[0]
                if not date_str:
                    continue

                open_p = float(row['open']) if pd.notna(row.get('open')) else None
                close_p = float(row['close']) if pd.notna(row.get('close')) else None
                low_p = float(row['low']) if pd.notna(row.get('low')) else None
                high_p = float(row['high']) if pd.notna(row.get('high')) else None
                volume = float(row['volume']) if pd.notna(row.get('volume')) else None
                money = float(row['money']) if pd.notna(row.get('money')) else None
                pre_close = float(row['pre_close']) if pd.notna(row.get('pre_close')) else None

                change_amount = None
                change_pct = None
                amplitude = None
                if close_p is not None and pre_close is not None and pre_close != 0:
                    change_amount = round(close_p - pre_close, 4)
                    change_pct = round((close_p - pre_close) / pre_close * 100, 4)
                    if high_p is not None and low_p is not None:
                        amplitude = round((high_p - low_p) / pre_close * 100, 4)

                conn.execute(
                    """INSERT OR REPLACE INTO klines
                       (code, market, period, adjust, date, open, high, low, close,
                        volume, turnover, change_pct, change_amount, amplitude, pre_close)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (code, market, 'daily', 'bfq', date_str, open_p, high_p, low_p, close_p,
                     volume, money, change_pct, change_amount, amplitude, pre_close)
                )
                total_rows += 1

            synced += len(batch)

            if (i // batch_size + 1) % 10 == 0:
                conn.commit()
                logger.info(f"  Klines progress: {min(i + batch_size, total)}/{total} stocks, {total_rows} rows")

        except Exception as e:
            logger.warning(f"  Batch {i}-{i+batch_size} failed: {e}")
            failed += len(batch)

        time.sleep(0.3)  # rate limit

    conn.commit()
    conn.close()
    logger.info(f"Klines done: {synced} stocks synced, {failed} failed, {total_rows} rows inserted.")
    return {"synced": synced, "failed": failed, "rows": total_rows}


# ── Phase 4: Sync Fundamentals ─────────────────────────────────────────────

@_phase("fundamentals")
def sync_fundamentals() -> dict:
    """Sync latest quarterly fundamentals for all stocks from Eastmoney F10."""
    import requests
    from bs4 import BeautifulSoup

    conn = get_db()
    stocks = conn.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
    conn.close()

    total = len(stocks)
    logger.info(f"Syncing fundamentals for {total} stocks (this may take 30-60min)...")

    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://quote.eastmoney.com/",
    }

    def _market_prefix(code: str) -> str:
        return "sh" if code.startswith(("60", "68", "90")) else "sz"

    def _get_company_type(symbol_lower: str) -> Optional[str]:
        try:
            url = "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index"
            r = requests.get(url, params={"type": "web", "code": symbol_lower},
                             headers=HEADERS, timeout=10)
            r.encoding = "utf-8"
            soup = BeautifulSoup(r.text, features="lxml")
            ctype_input = soup.find(attrs={"id": "hidctype"})
            if ctype_input and ctype_input.get("value"):
                return ctype_input["value"]
        except Exception:
            pass
        return None

    def _get_report_dates(endpoint: str, company_type: str, code: str) -> list:
        try:
            url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
            params = {"companyType": company_type, "reportDateType": "0", "code": code}
            r = requests.get(url, params=params, headers=HEADERS, timeout=10)
            data = r.json()
            if "data" in data and data["data"]:
                return [item["REPORT_DATE"] for item in data["data"] if "REPORT_DATE" in item]
        except Exception:
            pass
        return []

    def _fetch_statement(endpoint: str, company_type: str, code: str, report_dates: list) -> list:
        try:
            url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
            all_records = []
            for i in range(0, len(report_dates), 5):
                chunk = report_dates[i:i + 5]
                params = {
                    "companyType": company_type,
                    "reportDateType": "0",
                    "reportType": "1",
                    "code": code,
                    "dates": ",".join(chunk),
                }
                r = requests.get(url, params=params, headers=HEADERS, timeout=15)
                data = r.json()
                all_records.extend(data.get("data", []))
            return all_records
        except Exception:
            return []

    def _safe_float(v):
        if v is None or v == '' or v == '-':
            return None
        try:
            return float(v)
        except (ValueError, TypeError):
            return None

    statements_cfg = {
        "lrb": {
            "date_ep": "lrbDateAjaxNew",
            "data_ep": "lrbAjaxNew",
            "fields": {
                "TOTAL_OPERATE_INCOME": "total_revenue",
                "OPERATE_INCOME": "operate_revenue",
                "TOTAL_OPERATE_COST": "total_operate_cost",
                "OPERATE_COST": "operate_cost",
                "OPERATE_PROFIT": "operate_profit",
                "TOTAL_PROFIT": "total_profit",
                "NETPROFIT": "net_profit",
                "PARENT_NETPROFIT": "parent_net_profit",
                "BASIC_EPS": "eps",
                "DILUTED_EPS": "diluted_eps",
                "RESEARCH_EXPENSE": "research_expense",
                "SALE_EXPENSE": "sale_expense",
                "MANAGE_EXPENSE": "manage_expense",
                "FINANCE_EXPENSE": "finance_expense",
                "INTEREST_EXPENSE": "interest_expense",
                "INCOME_TAX": "income_tax",
            }
        },
        "zcfzb": {
            "date_ep": "zcfzbDateAjaxNew",
            "data_ep": "zcfzbAjaxNew",
            "fields": {
                "TOTAL_ASSETS": "total_assets",
                "TOTAL_LIABILITIES": "total_liabilities",
                "TOTAL_EQUITY": "total_equity",
                "PARENT_EQUITY": "parent_equity",
                "TOTAL_LIAB_EQUITY": "total_liab_equity",
                "TOTAL_CURRENT_ASSETS": "total_current_assets",
                "TOTAL_CURRENT_LIAB": "total_current_liab",
                "INVENTORY": "inventory",
                "ACCOUNTS_RECE": "accounts_rece",
                "FIXED_ASSET": "fixed_asset",
                "SHORT_LOAN": "short_loan",
                "LONG_LOAN": "long_loan",
                "TOTAL_NONCURRENT_LIAB": "total_noncurrent_liab",
                "MONETARYFUNDS": "monetary_funds",
            }
        },
        "xjllb": {
            "date_ep": "xjllbDateAjaxNew",
            "data_ep": "xjllbAjaxNew",
            "fields": {
                "NETCASH_OPERATE": "operate_cash_flow",
                "NETCASH_INVEST": "invest_cash_flow",
                "NETCASH_FINANCE": "finance_cash_flow",
                "CASH_EQU_INCREASE": "net_cash_increase",
                "CONSTRUCT_LONG_ASSET": "construct_long_asset",
            }
        },
    }

    def _sync_one_stock(code: str, market: int) -> dict:
        prefix = _market_prefix(code)
        symbol_lower = f"{prefix}{code}"
        code_upper = f"{prefix.upper()}{code}"
        now = datetime.now().isoformat()

        company_type = _get_company_type(symbol_lower)
        if not company_type:
            return {"code": code, "status": "skip", "reason": "no_company_type"}

        # Get latest report dates for each statement
        report_dates_map = {}
        for key, cfg in statements_cfg.items():
            dates = _get_report_dates(cfg["date_ep"], company_type, code_upper)
            if dates:
                report_dates_map[key] = dates[:2]  # sync latest 2 periods

        if not report_dates_map:
            return {"code": code, "status": "skip", "reason": "no_report_dates"}

        records_map = {}
        for key, cfg in statements_cfg.items():
            if key not in report_dates_map:
                continue
            records = _fetch_statement(cfg["data_ep"], company_type, code_upper, report_dates_map[key])
            records_map[key] = records

        conn = get_db()
        inserted = 0
        for report_dates in report_dates_map.values():
            for rd in report_dates:
                rd_short = rd[:10]
                # Check if already exists
                existing = conn.execute(
                    "SELECT 1 FROM fundamentals WHERE code = ? AND market = ? AND report_date = ?",
                    (code, market, rd_short)
                ).fetchone()
                if existing:
                    continue

                # Build row data
                row_data = {"code": code, "market": market, "report_date": rd_short}
                for key, cfg in statements_cfg.items():
                    rec = None
                    for r in records_map.get(key, []):
                        if r.get("REPORT_DATE", "")[:10] == rd_short:
                            rec = r
                            break
                    if rec:
                        for api_key, db_col in cfg["fields"].items():
                            row_data[db_col] = _safe_float(rec.get(api_key))

                # Insert
                cols = list(row_data.keys()) + ["updated_at"]
                vals = list(row_data.values()) + [now]
                placeholders = ",".join(["?"] * len(vals))
                col_str = ",".join(cols)
                try:
                    conn.execute(
                        f"INSERT INTO fundamentals ({col_str}) VALUES ({placeholders})",
                        vals
                    )
                    inserted += 1
                except Exception as e:
                    logger.debug(f"  Insert failed for {code} {rd_short}: {e}")

        conn.commit()
        conn.close()
        return {"code": code, "status": "ok", "inserted": inserted}

    synced = 0
    failed = 0
    skipped = 0
    total_inserted = 0

    # Use ThreadPool for fundamentals (network I/O bound)
    max_workers = 8
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_sync_one_stock, s["code"], s["market"]): s for s in stocks}
        for idx, future in enumerate(as_completed(futures)):
            try:
                res = future.result(timeout=30)
                if res["status"] == "ok":
                    synced += 1
                    total_inserted += res.get("inserted", 0)
                elif res["status"] == "skip":
                    skipped += 1
                else:
                    failed += 1
            except Exception as e:
                failed += 1
                logger.debug(f"  Future error: {e}")

            if (idx + 1) % 200 == 0:
                logger.info(f"  Fundamentals progress: {idx+1}/{total} (ok={synced}, skip={skipped}, fail={failed}, inserted={total_inserted})")

    logger.info(f"Fundamentals done: {synced} ok, {skipped} skipped, {failed} failed, {total_inserted} records inserted.")
    return {"synced": synced, "skipped": skipped, "failed": failed, "inserted": total_inserted}


# ── Phase 5: Sync Indicators ───────────────────────────────────────────────

@_phase("indicators")
def sync_indicators() -> dict:
    """Calculate fundamental indicators from fundamentals table."""
    try:
        import calc_fundamental_indicators
        result = calc_fundamental_indicators.calc_all(get_db())
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Indicators calculation failed: {e}")


# ── Phase 6: Sync Industries ───────────────────────────────────────────────

@_phase("industries")
def sync_industries() -> dict:
    """Sync industry classifications via existing sync_industries_jq.py."""
    try:
        import sync_industries_jq
        result = sync_industries_jq.sync_all_standards()
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Industry sync failed: {e}")


# ── Phase 6: Sync Concepts ─────────────────────────────────────────────────

@_phase("concepts")
def sync_concepts() -> dict:
    """Sync concept stocks via existing sync_concepts_jq.py."""
    try:
        import sync_concepts_jq
        result = sync_concepts_jq.sync_all_concepts()
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Concept sync failed: {e}")


# ── Phase 7: Sync Stock News ───────────────────────────────────────────────

@_phase("stock_news")
def sync_stock_news() -> dict:
    """Sync stock news via existing news_sync.py (batch mode)."""
    try:
        import news_sync
        conn = news_sync.get_db()
        rows = conn.execute("SELECT code, name FROM stocks ORDER BY code").fetchall()
        conn.close()
        codes_names = [(r["code"], r["name"] or "") for r in rows]
        logger.info(f"Batch syncing news for {len(codes_names)} stocks...")
        result = news_sync.sync_batch(codes_names, limit_per_source=5)
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Stock news sync failed: {e}")


# ── Phase 8: Sync Market News ──────────────────────────────────────────────

@_phase("market_news")
def sync_market_news() -> dict:
    """Sync market-wide news via existing market_news_sync.py."""
    try:
        import market_news_sync
        result = market_news_sync.sync_market_news(limit=200)
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Market news sync failed: {e}")


# ── Phase 9: Validation ────────────────────────────────────────────────────

@_phase("validation")
def run_validation() -> dict:
    """Run data completeness validation."""
    import sync_validator
    report = sync_validator.validate_all()
    logger.info("Validation report:\n" + json.dumps(report, ensure_ascii=False, indent=2, default=str))
    _sync_results["validation"] = report

    # Check critical failures
    critical_issues = []
    for check_name, check_data in report.items():
        if isinstance(check_data, dict) and check_data.get("status") == "FAIL":
            critical_issues.append(f"{check_name}: {check_data.get('message', '')}")

    if critical_issues:
        msg = "CRITICAL VALIDATION FAILURES:\n" + "\n".join(f"  - {i}" for i in critical_issues)
        logger.error(msg)
        _sync_results["errors"].append({"phase": "validation", "error": msg})
        # Don't raise exception — let the script finish so other data is preserved

    return report


# ── Main ───────────────────────────────────────────────────────────────────

def run_all_phases(phases: Optional[List[str]] = None):
    """Run all or selected sync phases."""
    ensure_tables()

    all_phases = [
        ("stocks", sync_stocks),
        ("quotes", sync_quotes),
        ("klines", sync_klines),
        ("fundamentals", sync_fundamentals),
        ("indicators", sync_indicators),
        ("industries", sync_industries),
        ("concepts", sync_concepts),
        ("stock_news", sync_stock_news),
        ("market_news", sync_market_news),
        ("validation", run_validation),
    ]

    for name, func in all_phases:
        if phases and name not in phases:
            logger.info(f"Skipping phase: {name}")
            continue
        func()

    # Final summary
    _sync_results["end_time"] = datetime.now().isoformat()
    total_elapsed = (
        datetime.fromisoformat(_sync_results["end_time"])
        - datetime.fromisoformat(_sync_results["start_time"])
    ).total_seconds()
    _sync_results["total_elapsed_seconds"] = round(total_elapsed, 2)

    logger.info(f"\n{'='*60}")
    logger.info("SYNC COMPLETE")
    logger.info(f"{'='*60}")
    logger.info(f"Total time: {total_elapsed/60:.1f} minutes")
    logger.info(f"Phases run: {len(_sync_results['phases'])}")
    logger.info(f"Errors: {len(_sync_results['errors'])}")
    if _sync_results["errors"]:
        logger.info("Error details:")
        for e in _sync_results["errors"]:
            logger.info(f"  [{e['phase']}] {e['error']}")

    # Save summary JSON
    summary_path = os.path.join(_LOG_DIR, f"sync_summary_{_TODAY}.json")
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(_sync_results, f, ensure_ascii=False, indent=2, default=str)
    logger.info(f"Summary saved to: {summary_path}")

    # Exit code: 0 if no critical errors, 1 otherwise
    has_critical = any(e["phase"] == "validation" for e in _sync_results["errors"])
    if has_critical:
        logger.error("Exiting with code 1 due to validation failures.")
        sys.exit(1)
    return _sync_results


def main():
    parser = argparse.ArgumentParser(description="A-Share Analysis Daily Data Sync")
    parser.add_argument("--phase", action="append", help="Run specific phase(s)")
    parser.add_argument("--validate-only", action="store_true", help="Only run validation")
    parser.add_argument("--skip-fundamentals", action="store_true", help="Skip fundamentals (slow)")
    args = parser.parse_args()

    if args.validate_only:
        ensure_tables()
        run_validation()
        return

    phases = args.phase
    if args.skip_fundamentals and not phases:
        phases = ["stocks", "quotes", "klines", "industries", "concepts", "stock_news", "market_news", "validation"]

    run_all_phases(phases)


if __name__ == "__main__":
    main()
