#!/usr/bin/env python3
"""
A-Share Analysis 全市场数据每日定时同步脚本
===============================================
同步内容: stocks, quotes, klines, fundamentals, industries, concepts, stock_news, market_news
运行建议: 每天 01:20 (A股收盘后数据稳定时段)
用法:     python daily_sync.py [--validate-only] [--phase PHASE]

依赖:     akshare, pandas, requests, beautifulsoup4, mootdx
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
import urllib.request
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
    conn.execute("PRAGMA journal_mode=WAL;")
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

    # industry_indicators
    cur.execute("""
        CREATE TABLE IF NOT EXISTS industry_indicators (
            code TEXT NOT NULL,
            date TEXT NOT NULL,
            period_days INTEGER NOT NULL,
            momentum_return REAL,
            momentum_rank INTEGER,
            has_momentum INTEGER,
            updated_at TEXT,
            PRIMARY KEY (code, date, period_days)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_indicators_date
        ON industry_indicators(date, period_days)
    """)

    # factor_ic (generic factor effectiveness)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS factor_ic (
            date TEXT NOT NULL,
            factor_name TEXT NOT NULL,
            ic_value REAL,
            sample_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (date, factor_name)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_factor_ic_lookup
        ON factor_ic(factor_name, date)
    """)

    # industry_synthetic_klines
    cur.execute("""
        CREATE TABLE IF NOT EXISTS industry_synthetic_klines (
            code TEXT NOT NULL,
            standard TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL,
            constituent_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (code, standard, date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_synthetic_klines_lookup
        ON industry_synthetic_klines(code, standard, date)
    """)

    conn.commit()
    conn.close()
    logger.info("Database tables ensured.")


# ── Phase 1: Sync Stocks ───────────────────────────────────────────────────

def _is_a_share(code: str) -> bool:
    """Strict A-share 6-digit code filter. Excludes funds, bonds, B-shares."""
    if not code or len(code) != 6 or not code.isdigit():
        return False
    # Shanghai main board + STAR market
    if code.startswith(("600", "601", "602", "603", "605", "688", "689")):
        return True
    # Shenzhen main board + SME + ChiNext
    if code.startswith(("000", "001", "002", "003", "300", "301")):
        return True
    return False


@_phase("stocks")
def sync_stocks() -> dict:
    """Sync full stock list. Priority: akshare -> mootdx fallback."""
    conn = get_db()
    try:
        cur = conn.cursor()
        now = datetime.now().isoformat()
        count = 0

        # Try akshare first
        stocks = []
        try:
            import akshare as ak
            df = ak.stock_zh_a_spot_em()
            for _, row in df.iterrows():
                code = str(row.get("代码", "")).strip()
                name = str(row.get("名称", "")).strip()
                if not _is_a_share(code):
                    continue
                market = 1 if code.startswith(("60", "68")) else 0
                stocks.append({"code": code, "market": market, "name": name})
            logger.info(f"Fetched {len(stocks)} stocks from akshare.")
        except Exception as e:
            logger.warning(f"akshare stock list failed: {e}")

        # Fallback: mootdx stock_all (includes non-A-shares, needs filtering)
        if not stocks:
            try:
                from mootdx.quotes import Quotes
                client = Quotes.factory(market="std")
                df = client.stock_all()
                if df is not None and not df.empty:
                    for _, row in df.iterrows():
                        code = str(row.get("code", "")).strip()
                        if not _is_a_share(code):
                            continue
                        market = 1 if code.startswith(("60", "68")) else 0
                        name = str(row.get("name", "") or "").strip()
                        stocks.append({"code": code, "market": market, "name": name})
                    logger.info(f"Fetched {len(stocks)} stocks from mootdx.")
            except Exception as e:
                logger.warning(f"mootdx stock list failed: {e}")

        if not stocks:
            raise RuntimeError("Failed to fetch stock list from all sources")

        for stock in stocks:
            code = stock["code"]
            market = stock["market"]
            name = stock.get("name")
            if not name:
                name = "(unknown)"
            # list_date not available from these APIs
            cur.execute(
                """INSERT OR REPLACE INTO stocks (code, market, name, list_date, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (code, market, name, None, now)
            )
            count += 1

        conn.commit()
        logger.info(f"Synced {count} stocks.")
        return {"count": count}
    finally:
        conn.close()


# ── Phase 2: Sync Quotes ───────────────────────────────────────────────────

def _is_a_share_trading_hours() -> bool:
    """Check if current time is within A-share trading hours (Mon-Fri 09:30-11:30, 13:00-15:00)."""
    now = datetime.now()
    if now.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    hm = now.hour * 100 + now.minute
    # Trading sessions: 0930-1130, 1300-1500
    return (930 <= hm <= 1130) or (1300 <= hm <= 1500)


def _sync_quotes_from_tencent() -> dict:
    """Fetch real-time quotes from Tencent Finance API (qt.gtimg.cn).

    Batches stocks into groups of ~700 to avoid URL length limits.
    Returns rich fields including PE, PB, market cap, turnover, etc.
    """
    conn = get_db()
    try:
        cur = conn.cursor()
        today = datetime.now().strftime('%Y-%m-%d')
        now = datetime.now().isoformat()

        # Get all stock codes from DB
        stocks = conn.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
        if not stocks:
            raise RuntimeError("No stocks found in DB")

        def _prefix(code: str) -> str:
            if code.startswith(("60", "68", "90")):
                return f"sh{code}"
            elif code.startswith(("8", "4", "92")):
                return f"bj{code}"
            else:
                return f"sz{code}"

        def _safe_float(v):
            if v is None or v == '' or v == '-':
                return None
            try:
                return float(v)
            except (ValueError, TypeError):
                return None

        batch_size = 700
        total_inserted = 0
        total_fetched = 0

        for i in range(0, len(stocks), batch_size):
            batch = stocks[i:i + batch_size]
            prefixed = [_prefix(s["code"]) for s in batch]
            url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)

            try:
                req = urllib.request.Request(url)
                req.add_header("User-Agent", "Mozilla/5.0")
                resp = urllib.request.urlopen(req, timeout=15)
                raw = resp.read()
            except Exception as e:
                logger.warning(f"  Tencent API batch {i}-{i+len(batch)} failed: {e}")
                continue

            # Decode response (gbk/gb18030)
            data = None
            for enc in ["gb18030", "gbk", "utf-8"]:
                try:
                    data = raw.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            if data is None:
                data = raw.decode("gbk", errors="ignore")

            for line in data.strip().split(";"):
                if not line.strip() or "=" not in line or '"' not in line:
                    continue
                key = line.split("=")[0].split("_")[-1]
                vals = line.split('"')[1].split("~")
                if len(vals) < 53:
                    continue

                code = key[2:] if len(key) > 2 else key
                # Determine market from code prefix in response key
                market = 1 if key.startswith("sh") else 0

                name = vals[1] if len(vals) > 1 else None
                latest = _safe_float(vals[3])   # 当前价
                last_close = _safe_float(vals[4])  # 昨收
                open_p = _safe_float(vals[5])   # 开盘价
                high = _safe_float(vals[33])    # 最高价
                low = _safe_float(vals[34])     # 最低价
                change_pct = _safe_float(vals[32])  # 涨跌幅
                # vals[36] = 总成交量(手), convert to shares
                volume = _safe_float(vals[36])
                if volume is not None:
                    volume = volume * 100
                turnover = _safe_float(vals[37])  # 成交金额(元)
                pe = _safe_float(vals[39])      # 市盈率(TTM)
                pb = _safe_float(vals[46])      # 市净率
                mcap_yi = _safe_float(vals[44])  # 流通市值(亿)
                total_cap_yi = _safe_float(vals[45])  # 总市值(亿)

                cur.execute(
                    """INSERT OR REPLACE INTO quotes
                       (code, market, snapshot_date, name, latest, open, high, low, prev_close,
                        volume, turnover, change_pct, pe, pb, total_cap, float_cap, high_52w, low_52w, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        code, market, today, name,
                        latest, open_p, high, low, last_close,
                        volume, turnover, change_pct,
                        pe, pb,
                        total_cap_yi, mcap_yi,
                        None, None,  # 52w high/low not available from Tencent
                        now
                    )
                )
                total_inserted += 1

            total_fetched += len(batch)
            if (i // batch_size + 1) % 2 == 0:
                logger.info(f"  Tencent quotes progress: {total_fetched}/{len(stocks)} stocks, {total_inserted} inserted")

        conn.commit()
        logger.info(f"Synced {total_inserted} quotes for {today} from Tencent API.")
        return {"count": total_inserted, "date": today, "source": "tencent"}
    finally:
        conn.close()


def _sync_quotes_from_klines() -> dict:
    """Fallback: derive quotes from latest klines when akshare is unavailable."""
    conn = get_db()
    try:
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
        logger.info(f"Derived {count} quotes from klines ({latest_kline_date}).")
        return {"count": count, "date": latest_kline_date, "source": "klines_fallback"}
    finally:
        conn.close()


@_phase("quotes")
def sync_quotes() -> dict:
    """Sync daily quotes. Priority: Tencent API > akshare > klines fallback."""

    # Step 1: Try Tencent API first (fast, works outside trading hours, rich fields)
    logger.info("Fetching quotes from Tencent API (qt.gtimg.cn)...")
    try:
        return _sync_quotes_from_tencent()
    except Exception as e:
        logger.warning(f"  Tencent API failed: {e}")

    # Step 2: Fall back to akshare (trading hours only, has 52w high/low)
    logger.info("Falling back to akshare...")
    try:
        import akshare as ak
    except ImportError:
        logger.warning("  akshare not installed. Falling back to klines.")
        return _sync_quotes_from_klines()

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
        logger.warning("akshare unavailable. Falling back to klines-derived quotes...")
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
    """Sync daily klines for all stocks. Uses mootdx (TCP direct) / akshare. No JoinQuant dependency."""
    from batch_get_kline import batch_get_kline

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

    try:
        # Process in batches of 50
        batch_size = 50
        for i in range(0, total, batch_size):
            batch = stocks[i:i + batch_size]
            batch_dicts = [{"code": s["code"], "market": s["market"]} for s in batch]

            try:
                klines = batch_get_kline(batch_dicts, start_date=start_date, end_date=end_date,
                                          period="daily", adjust="bfq")

                if not klines:
                    failed += len(batch)
                    continue

                for k in klines:
                    code = k["code"]
                    market = k["market"]
                    date_str = k["date"]
                    if not date_str:
                        continue

                    conn.execute(
                        """INSERT OR REPLACE INTO klines
                           (code, market, period, adjust, date, open, high, low, close,
                            volume, turnover, change_pct, change_amount, amplitude, pre_close)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (code, market, 'daily', 'bfq', date_str,
                         k.get("open"), k.get("high"), k.get("low"), k.get("close"),
                         k.get("volume"), k.get("amount"),
                         k.get("change_pct"), k.get("change_amount"), k.get("amplitude"),
                         k.get("pre_close"))
                    )
                    total_rows += 1

                synced += len(batch)

                if (i // batch_size + 1) % 10 == 0:
                    conn.commit()
                    logger.info(f"  Klines progress: {min(i + batch_size, total)}/{total} stocks, {total_rows} rows")

            except Exception as e:
                logger.warning(f"  Batch {i}-{i+batch_size} failed: {e}")
                failed += len(batch)

        conn.commit()
        logger.info(f"Klines done: {synced} stocks synced, {failed} failed, {total_rows} rows inserted.")
        return {"synced": synced, "failed": failed, "rows": total_rows}
    finally:
        conn.close()


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


# ── Phase 6: Sync Industry Momentum ──────────────────────────────────────────

@_phase("industry_momentum")
def sync_industry_momentum() -> dict:
    """Calculate industry momentum factor and IC from industry_klines."""
    try:
        import calc_industry_momentum
        result = calc_industry_momentum.calc_all(get_db(), periods=[20], forwards=[5])
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Industry momentum calculation failed: {e}")


@_phase("size_ic")
def sync_size_ic() -> dict:
    """Calculate size (market cap) factor IC from klines and fundamentals."""
    try:
        import calc_size_ic
        result = calc_size_ic.calc_all(get_db(), forwards=[5, 10, 20])
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Size IC calculation failed: {e}")


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


# ── Phase 10: Data Quality Sampling ────────────────────────────────────────

@_phase("data_quality")
def run_data_quality_sampling() -> dict:
    """Run random data quality sampling via data_quality_sampler.py."""
    import subprocess

    script_path = os.path.join(_SCRIPT_DIR, "data_quality_sampler.py")
    if not os.path.exists(script_path):
        logger.warning("data_quality_sampler.py not found, skipping data quality check")
        return {"skipped": True, "reason": "script not found"}

    report_path = os.path.join(_LOG_DIR, f"data_quality_{_TODAY}.json")
    prompt_path = os.path.join(_LOG_DIR, f"data_quality_{_TODAY}_prompt.txt")

    logger.info("Running data quality random sampling (5 stocks, 3 dates each)...")
    try:
        result = subprocess.run(
            [sys.executable, script_path, "--stocks", "5", "--dates", "3", "--output", report_path],
            capture_output=True,
            text=True,
            timeout=60,
            encoding="utf-8",
        )
        if result.returncode != 0:
            logger.warning(f"data_quality_sampler.py exited with code {result.returncode}")
            logger.debug(result.stderr)
            return {"status": "failed", "returncode": result.returncode}

        # Parse summary from stdout
        stdout = result.stdout
        logger.info("Data quality sampling completed.")

        # Try to extract stock count and balance info from stdout
        stocks_checked = stdout.count("股票:")
        balanced = stdout.count("[平衡]")
        unbalanced = stdout.count("[不平衡]")

        summary = {
            "status": "success",
            "stocks_checked": stocks_checked,
            "balanced": balanced,
            "unbalanced": unbalanced,
            "report_path": report_path,
            "prompt_path": prompt_path,
        }

        if unbalanced > 0:
            logger.warning(f"Data quality: {unbalanced} unbalanced financial statements found!")
        else:
            logger.info(f"Data quality: {balanced} balanced statements checked, no issues.")

        # Save LLM prompt for manual review if needed
        if os.path.exists(report_path):
            # Generate prompt file
            try:
                import data_quality_sampler
                with open(report_path, "r", encoding="utf-8") as f:
                    report_data = json.load(f)
                prompt = data_quality_sampler.generate_llm_prompt(report_data)
                with open(prompt_path, "w", encoding="utf-8") as f:
                    f.write(prompt)
                logger.info(f"LLM prompt saved to: {prompt_path}")
            except Exception as e:
                logger.debug(f"Failed to generate LLM prompt: {e}")

        return summary
    except subprocess.TimeoutExpired:
        logger.warning("data_quality_sampler.py timed out after 60s")
        return {"status": "timeout"}
    except Exception as e:
        logger.warning(f"Data quality sampling failed: {e}")
        return {"status": "failed", "error": str(e)}


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
        ("industry_momentum", sync_industry_momentum),
        ("size_ic", sync_size_ic),
        ("industries", sync_industries),
        ("concepts", sync_concepts),
        ("stock_news", sync_stock_news),
        ("market_news", sync_market_news),
        ("validation", run_validation),
        ("data_quality", run_data_quality_sampling),
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

    phases = None
    if args.phase:
        # Support both --phase stocks --phase quotes and --phase stocks,quotes,klines
        phases = []
        for p in args.phase:
            phases.extend([s.strip() for s in p.split(",") if s.strip()])
    if args.skip_fundamentals and not phases:
        phases = ["stocks", "quotes", "klines", "industry_momentum", "size_ic", "industries", "concepts", "stock_news", "market_news", "validation"]

    run_all_phases(phases)


if __name__ == "__main__":
    main()
