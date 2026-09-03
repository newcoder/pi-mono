"""Auto-extracted from daily_sync.py."""

import logging
import os
import time
import urllib.request
from datetime import datetime

from local_data.db import get_db
from local_data.market import market_from_code, market_prefix

from .base import _phase

logger = logging.getLogger('daily_sync')

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
            return market_prefix(code, "lower") or f"sz{code}"

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
                market = market_from_code(code) or 0

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
    """Sync daily quotes. Priority: Tencent API > klines fallback."""

    # Step 1: Try Tencent API first (fast, works outside trading hours, rich fields)
    logger.info("Fetching quotes from Tencent API (qt.gtimg.cn)...")
    try:
        return _sync_quotes_from_tencent()
    except Exception as e:
        logger.warning(f"  Tencent API failed: {e}")

    # Step 2: Derive quotes from latest daily klines (no external dependency)
    logger.warning("Tencent API unavailable. Falling back to klines-derived quotes...")
    return _sync_quotes_from_klines()
