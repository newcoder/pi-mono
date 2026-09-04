#!/usr/bin/env python3
"""
Database utilities for NL stock screener.
Connects to trading-agent's local SQLite database.
"""
import os
import sys
import json
import sqlite3
import subprocess
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple
import pandas as pd

# Path to a-share-analysis scripts (used for get_quote.py / get_kline.py)
_A_SHARE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "a-share-analysis", "scripts")

DB_PATH = os.path.join(os.path.expanduser("~"), ".trading-agent", "data", "market.db")


def get_db() -> sqlite3.Connection:
    """Get SQLite connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_indicators_table(conn: sqlite3.Connection):
    """Create indicators cache table if not exists."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS indicators (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            period TEXT NOT NULL,
            indicator_name TEXT NOT NULL,
            indicator_value TEXT,
            computed_date TEXT,
            updated_at TEXT,
            PRIMARY KEY (code, market, period, indicator_name)
        )
    """)
    conn.commit()


def get_stock_list(scope: str = "all") -> List[Dict]:
    """
    Get stock list based on scope.
    Returns list of {code, name, market} dicts.
    """
    conn = get_db()
    try:
        if scope == "all":
            rows = conn.execute("SELECT code, name, market FROM stocks ORDER BY code").fetchall()
            if not rows:
                # Fallback to klines daily as canonical stock universe
                rows = conn.execute(
                    "SELECT DISTINCT code, market FROM klines WHERE period='daily' AND adjust='bfq' ORDER BY code"
                ).fetchall()
                return [{"code": r["code"], "name": "", "market": r["market"]} for r in rows]
            return [{"code": r["code"], "name": r["name"], "market": r["market"]} for r in rows]

        # Index scopes via akshare
        if scope in ("hs300", "zz500", "zz1000", "cyb", "kcb"):
            try:
                import akshare as ak
                index_map = {
                    "hs300": "000300",
                    "zz500": "000905",
                    "zz1000": "000852",
                    "cyb": "399006",
                    "kcb": "000688",
                }
                df = ak.index_stock_cons(symbol=index_map[scope])
                codes = df["品种代码"].astype(str).tolist()
                result = []
                for code in codes:
                    code = code.strip()
                    if not code:
                        continue
                    market = 1 if code.startswith(("60", "68", "90")) else 0
                    result.append({"code": code, "name": "", "market": market})
                return result
            except Exception as e:
                print(f"Warning: failed to get index stocks for {scope}: {e}", file=sys.stderr)
                return []

        if scope.startswith("custom:"):
            codes = [c.strip() for c in scope.replace("custom:", "").split(",") if c.strip()]
            return [{"code": c, "name": "", "market": 1 if c.startswith("6") else 0} for c in codes]

        # Industry scope: "industry:食品饮料I" or "industry:食品饮料"
        if scope.startswith("industry:"):
            industry_name = scope.replace("industry:", "").strip()
            # Try exact match first, then fallback to LIKE prefix match across all levels
            rows = conn.execute(
                """SELECT s.code, s.name, s.market
                   FROM stocks s
                   JOIN stock_industries si ON s.code = si.code AND s.market = si.market
                   JOIN industries i ON si.industry_code = i.industry_code AND si.standard = i.standard
                   WHERE i.name = ?
                   ORDER BY s.code""",
                (industry_name,)
            ).fetchall()
            if not rows:
                # Fallback: try LIKE prefix match (e.g., "通信设备" matches "通信设备II")
                rows = conn.execute(
                    """SELECT s.code, s.name, s.market
                       FROM stocks s
                       JOIN stock_industries si ON s.code = si.code AND s.market = si.market
                       JOIN industries i ON si.industry_code = i.industry_code AND si.standard = i.standard
                       WHERE i.name LIKE ? || '%'
                       ORDER BY s.code""",
                    (industry_name,)
                ).fetchall()
            return [{"code": r["code"], "name": r["name"], "market": r["market"]} for r in rows]

        # Concept scope: "concept:石墨烯"
        if scope.startswith("concept:"):
            concept_name = scope.replace("concept:", "").strip()
            rows = conn.execute(
                """SELECT s.code, s.name, s.market
                   FROM stocks s
                   JOIN concept_stocks cs ON s.code = cs.code
                   WHERE cs.concept = ?
                   ORDER BY s.code""",
                (concept_name,)
            ).fetchall()
            return [{"code": r["code"], "name": r["name"], "market": r["market"]} for r in rows]

        return []
    finally:
        conn.close()


def get_klines(code: str, market: int, period: str = "daily", adjust: str = "bfq", days: int = 120) -> Optional[pd.DataFrame]:
    """
    Get kline data from local DB as DataFrame.
    Returns None if no data.
    """
    conn = get_db()
    try:
        # Calculate start date
        end = datetime.now().strftime("%Y-%m-%d")
        start = (datetime.now() - timedelta(days=days * 2)).strftime("%Y-%m-%d")

        rows = conn.execute(
            """SELECT date, open, high, low, close, volume, turnover, change_pct, pre_close
               FROM klines
               WHERE code = ? AND market = ? AND period = ? AND adjust = ?
                 AND date >= ? AND date <= ?
               ORDER BY date""",
            (code, market, period, adjust, start, end)
        ).fetchall()

        if not rows:
            return None

        df = pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume", "turnover", "change_pct", "pre_close"])
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df["open"] = pd.to_numeric(df["open"], errors="coerce")
        df["high"] = pd.to_numeric(df["high"], errors="coerce")
        df["low"] = pd.to_numeric(df["low"], errors="coerce")
        df["volume"] = pd.to_numeric(df["volume"], errors="coerce")
        return df
    finally:
        conn.close()


def sync_kline_if_missing(code: str, market: int, period: str = "daily", adjust: str = "bfq", days: int = 120) -> bool:
    """
    Sync kline data from a-share-analysis get_kline.py if local DB is missing or stale.
    Returns True if data is now available.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT MAX(date) as max_date FROM klines WHERE code = ? AND market = ? AND period = ? AND adjust = ?",
            (code, market, period, adjust)
        ).fetchone()

        latest = row["max_date"] if row else None
        today = datetime.now().strftime("%Y-%m-%d")

        need_sync = False
        if not latest:
            need_sync = True
        else:
            latest_dt = datetime.strptime(latest, "%Y-%m-%d")
            if (datetime.now() - latest_dt).days > 3:
                need_sync = True

        if not need_sync:
            return True

        print(f"  Syncing kline for {code} ({period}, {adjust})...")

        end = datetime.now().strftime("%Y-%m-%d")
        start = (datetime.now() - timedelta(days=days * 2)).strftime("%Y-%m-%d")
        period_arg = {"weekly": "week", "monthly": "month"}.get(period, period)

        script = os.path.join(_A_SHARE_DIR, "get_kline.py")
        try:
            proc = subprocess.run(
                [sys.executable, script, code, "--market", str(market),
                 "--period", period_arg, "--adjust", adjust,
                 "--start", start.replace("-", ""), "--end", end.replace("-", "")],
                capture_output=True, text=True, encoding="utf-8", timeout=60
            )
            if proc.returncode != 0:
                print(f"    get_kline.py failed: {proc.stderr}", file=sys.stderr)
                return False

            data = json.loads(proc.stdout)
            klines = data.get("klines", [])
            if not klines:
                print(f"    No klines returned for {code}")
                return False

            for k in klines:
                date_str = str(k.get("date", "")).split(" ")[0]
                if not date_str:
                    continue
                # Skip degenerate realtime rows (collapsed OHLC + sentinel volume)
                vol = k.get("volume")
                o, h, l, c = k.get("open"), k.get("high"), k.get("low"), k.get("close")
                if vol is not None and 0 < vol < 1e-10 and None not in (o, h, l, c) and o == h == l == c:
                    continue
                conn.execute(
                    """INSERT OR REPLACE INTO klines
                       (code, market, period, adjust, date, open, high, low, close, volume, turnover, change_pct, change_amount, amplitude, pre_close)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        code, market, period, adjust, date_str,
                        k.get("open"), k.get("high"), k.get("low"), k.get("close"),
                        k.get("volume"), k.get("amount") or k.get("turnover"),
                        k.get("change_pct"), k.get("change_amount"), k.get("amplitude"), k.get("pre_close")
                    )
                )
            conn.commit()
            print(f"    Synced {len(klines)} rows")
            return True
        except Exception as e:
            print(f"    Sync failed: {e}", file=sys.stderr)
            return False
    finally:
        conn.close()


def sync_quote(code: str, market: int) -> bool:
    """Sync quote data from Python script and save to DB."""
    try:
        import subprocess
        script = os.path.join(_A_SHARE_DIR, "get_quote.py")
        proc = subprocess.run(
            [sys.executable, script, code, "--market", str(market)],
            capture_output=True, text=True, encoding="utf-8", timeout=30
        )
        if proc.returncode != 0:
            print(f"    Quote sync failed: {proc.stderr}", file=sys.stderr)
            return False

        data = json.loads(proc.stdout)
        conn = get_db()
        try:
            today = datetime.now().strftime("%Y-%m-%d")
            now = datetime.now().isoformat()

            def parse_num(v):
                if v is None or v == "-":
                    return None
                try:
                    return float(v)
                except:
                    return None

            conn.execute(
                """INSERT OR REPLACE INTO quotes
                   (code, market, snapshot_date, name, latest, open, high, low, prev_close,
                    volume, turnover, change_pct, pe, pb, total_cap, float_cap, high_52w, low_52w, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    code, market, today,
                    data.get("name"),
                    parse_num(data.get("latest")),
                    parse_num(data.get("open")),
                    parse_num(data.get("high")),
                    parse_num(data.get("low")),
                    parse_num(data.get("prev_close")),
                    parse_num(data.get("volume")),
                    parse_num(data.get("turnover")),
                    parse_num(data.get("change_pct")),
                    parse_num(data.get("pe")),
                    parse_num(data.get("pb")),
                    parse_num(data.get("total_cap")),
                    parse_num(data.get("float_cap")),
                    parse_num(data.get("52w_high")),
                    parse_num(data.get("52w_low")),
                    now
                )
            )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        print(f"    Quote sync exception: {e}", file=sys.stderr)
        return False


def get_quote_data(code: str, market: int, auto_sync: bool = True) -> Optional[Dict]:
    """Get latest quote data for a stock. Optionally auto-sync if missing."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM quotes WHERE code = ? AND market = ? ORDER BY snapshot_date DESC LIMIT 1",
            (code, market)
        ).fetchone()
        if row:
            return dict(row)
        if auto_sync:
            if sync_quote(code, market):
                row = conn.execute(
                    "SELECT * FROM quotes WHERE code = ? AND market = ? ORDER BY snapshot_date DESC LIMIT 1",
                    (code, market)
                ).fetchone()
                if row:
                    return dict(row)
        return None
    finally:
        conn.close()


def save_indicators(code: str, market: int, period: str, indicators: Dict):
    """Save computed indicators to cache table."""
    conn = get_db()
    try:
        ensure_indicators_table(conn)
        today = datetime.now().strftime("%Y-%m-%d")
        now = datetime.now().isoformat()
        for name, value in indicators.items():
            conn.execute(
                """INSERT OR REPLACE INTO indicators
                   (code, market, period, indicator_name, indicator_value, computed_date, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (code, market, period, name, json.dumps(value) if value is not None else None, today, now)
            )
        conn.commit()
    finally:
        conn.close()


def get_cached_indicators(code: str, market: int, period: str) -> Optional[Dict]:
    """Get cached indicators if available and fresh (computed today)."""
    conn = get_db()
    try:
        ensure_indicators_table(conn)
        today = datetime.now().strftime("%Y-%m-%d")
        rows = conn.execute(
            "SELECT indicator_name, indicator_value FROM indicators WHERE code = ? AND market = ? AND period = ? AND computed_date = ?",
            (code, market, period, today)
        ).fetchall()
        if not rows:
            return None
        result = {}
        for r in rows:
            try:
                result[r["indicator_name"]] = json.loads(r["indicator_value"]) if r["indicator_value"] else None
            except:
                result[r["indicator_name"]] = r["indicator_value"]
        return result
    finally:
        conn.close()


def get_klines_batch(codes_markets: list, period: str = "daily", adjust: str = "bfq", days: int = 120) -> pd.DataFrame:
    """
    Load klines for multiple stocks at once.
    codes_markets: list of (code, market) tuples
    Returns DataFrame with columns: code, market, date, open, high, low, close, volume, turnover, change_pct, pre_close
    """
    if not codes_markets:
        return pd.DataFrame()

    conn = get_db()
    try:
        end = datetime.now().strftime("%Y-%m-%d")
        start = (datetime.now() - timedelta(days=days * 2)).strftime("%Y-%m-%d")
        target_set = set(codes_markets)

        # SQLite row-value IN clause fails silently with large lists.
        # Load all data for the period and filter in Python.
        query = """
            SELECT code, market, date, open, high, low, close, volume, turnover, change_pct, pre_close
            FROM klines
            WHERE period = ? AND adjust = ?
              AND date >= ? AND date <= ?
            ORDER BY code, market, date
        """
        rows = conn.execute(query, (period, adjust, start, end)).fetchall()
        if not rows:
            return pd.DataFrame()

        # Filter to requested stocks
        filtered = [r for r in rows if (r[0], r[1]) in target_set]
        if not filtered:
            return pd.DataFrame()

        df = pd.DataFrame(filtered, columns=["code", "market", "date", "open", "high", "low", "close", "volume", "turnover", "change_pct", "pre_close"])
        for col in ["open", "high", "low", "close", "volume", "turnover", "change_pct", "pre_close"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df
    finally:
        conn.close()


def get_quotes_batch(codes_markets: list) -> pd.DataFrame:
    """
    Load latest quotes for multiple stocks at once.
    codes_markets: list of (code, market) tuples
    Returns DataFrame with columns including code, market, total_cap, pe, pb, change_pct, etc.
    """
    if not codes_markets:
        return pd.DataFrame()

    conn = get_db()
    try:
        target_set = set(codes_markets)

        # Load all latest quotes and filter in Python to avoid SQLite row-value IN bug
        query = """
            SELECT q.* FROM quotes q
            INNER JOIN (
                SELECT code, market, MAX(snapshot_date) as max_date
                FROM quotes
                GROUP BY code, market
            ) latest ON q.code = latest.code AND q.market = latest.market AND q.snapshot_date = latest.max_date
        """
        cursor = conn.execute(query)
        rows = cursor.fetchall()
        if not rows:
            return pd.DataFrame()

        columns = [desc[0] for desc in cursor.description]
        filtered = [r for r in rows if (r[columns.index("code")], r[columns.index("market")]) in target_set]
        if not filtered:
            return pd.DataFrame()

        df = pd.DataFrame(filtered, columns=columns)
        # Convert numeric columns
        for col in ["latest", "open", "high", "low", "prev_close", "volume", "turnover", "change_pct", "pe", "pb", "total_cap", "float_cap", "high_52w", "low_52w"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        return df
    finally:
        conn.close()


def get_fundamentals_batch(codes_markets: list) -> pd.DataFrame:
    """
    Load latest fundamentals for multiple stocks at once.
    Returns DataFrame with all fundamentals columns.
    """
    if not codes_markets:
        return pd.DataFrame()

    conn = get_db()
    try:
        target_set = set(codes_markets)

        # Load the latest report for each stock
        query = """
            SELECT f.* FROM fundamentals f
            INNER JOIN (
                SELECT code, market, MAX(report_date) as max_date
                FROM fundamentals
                GROUP BY code, market
            ) latest ON f.code = latest.code AND f.market = latest.market AND f.report_date = latest.max_date
        """
        cursor = conn.execute(query)
        rows = cursor.fetchall()
        if not rows:
            return pd.DataFrame()

        columns = [desc[0] for desc in cursor.description]
        filtered = [r for r in rows if (r[columns.index("code")], r[columns.index("market")]) in target_set]
        if not filtered:
            return pd.DataFrame()

        df = pd.DataFrame(filtered, columns=columns)
        # Convert numeric columns
        numeric_cols = [
            "total_revenue", "operate_revenue", "operate_cost", "total_operate_cost",
            "operate_profit", "total_profit", "net_profit", "parent_net_profit",
            "eps", "diluted_eps", "research_expense", "sale_expense", "manage_expense",
            "finance_expense", "interest_expense", "income_tax",
            "total_assets", "total_liabilities", "total_equity", "parent_equity",
            "total_current_assets", "total_current_liab", "inventory", "accounts_rece",
            "fixed_asset", "short_loan", "long_loan", "total_noncurrent_liab", "monetary_funds",
            "operate_cash_flow", "invest_cash_flow", "finance_cash_flow", "net_cash_increase",
            "construct_long_asset",
        ]
        for col in numeric_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        return df
    finally:
        conn.close()


def get_klines_codes(period: str = "daily", adjust: str = "bfq") -> list:
    """Return list of (code, market) tuples that have kline data for given period."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT DISTINCT code, market FROM klines WHERE period = ? AND adjust = ? ORDER BY code",
            (period, adjust)
        ).fetchall()
        return [(r["code"], r["market"]) for r in rows]
    finally:
        conn.close()
