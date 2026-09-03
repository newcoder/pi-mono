#!/usr/bin/env python3
"""
Sync Tonghuashun (THS) industry index klines and quotes to local SQLite DB.
Fetches directly from d.10jqka.com.cn via ths_client (node-generated v cookie).
"""
import os
import sys
import time
import json
import logging
import warnings
from datetime import datetime, timedelta

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import ths_client
from local_data.db import get_db, get_db_path

warnings.filterwarnings('ignore')

# Avoid unstable local HTTP proxies breaking requests to THS.
for _proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(_proxy_key, None)
os.environ.setdefault("NO_PROXY", "*")

logger = logging.getLogger(__name__)


def _safe_float(v):
    if v is None or v == '' or v == '-':
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def sync_industry_klines_ths() -> dict:
    """Sync THS industry index daily klines and latest quotes."""
    conn = get_db()
    cur = conn.cursor()

    industries = conn.execute(
        'SELECT industry_code, name FROM industries WHERE standard = "ths" ORDER BY industry_code'
    ).fetchall()
    if not industries:
        conn.close()
        return {"error": "No THS industries found. Run sync_industries_ths first."}

    end_date = datetime.now().strftime('%Y%m%d')
    start_date = (datetime.now() - timedelta(days=180)).strftime('%Y%m%d')

    total = len(industries)
    kline_rows = 0
    quote_rows = 0
    failed = []

    for idx, ind in enumerate(industries):
        code = ind["industry_code"]
        name = ind["name"]
        try:
            rows = ths_client.fetch_board_index_klines(code, start_date, end_date)
            if not rows:
                failed.append(code)
                continue

            latest_date = None
            latest_close = None
            latest_open = None
            latest_high = None
            latest_low = None
            latest_vol = None
            latest_amt = None

            for k in rows:
                date_str = k["date"]
                open_p = k["open"]
                high = k["high"]
                low = k["low"]
                close = k["close"]
                volume = k["volume"]
                amount = k["amount"]

                cur.execute(
                    """INSERT OR REPLACE INTO industry_klines
                       (code, period, date, open, high, low, close, volume, turnover, change_pct, change_amount, amplitude, turnover_rate)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (code, 'daily', date_str, open_p, high, low, close, volume, amount, None, None, None, None)
                )
                kline_rows += 1

                if latest_date is None or date_str > latest_date:
                    latest_date = date_str
                    latest_open = open_p
                    latest_high = high
                    latest_low = low
                    latest_close = close
                    latest_vol = volume
                    latest_amt = amount

            if latest_date:
                cur.execute(
                    """INSERT OR REPLACE INTO industry_quotes
                       (code, snapshot_date, name, latest, open, high, low, prev_close, volume, turnover,
                        change_pct, change_amount, amplitude, turnover_rate, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (code, latest_date, name, latest_close, latest_open, latest_high, latest_low, None,
                     latest_vol, latest_amt, None, None, None, None, datetime.now().isoformat())
                )
                quote_rows += 1

            if (idx + 1) % 10 == 0 or idx + 1 == total:
                conn.commit()
                logger.info(
                    f"[sync_industry_klines_ths] Progress: {idx + 1}/{total} industries, "
                    f"{kline_rows} klines, {quote_rows} quotes"
                )

            time.sleep(0.3)
        except Exception as e:
            logger.warning(f"[sync_industry_klines_ths] Failed for {code} ({name}): {e}")
            failed.append(code)

    conn.commit()
    conn.close()

    result = {
        "industries": total,
        "klines": kline_rows,
        "quotes": quote_rows,
        "failed": len(failed),
    }
    logger.info(f"[sync_industry_klines_ths] Done: {result}")
    return result


def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
    )
    result = sync_industry_klines_ths()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
