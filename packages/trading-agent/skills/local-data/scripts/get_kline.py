import argparse
import json
import os
import sys
import io
import logging

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import requests

from local_data.market import market_label

logger = logging.getLogger(__name__)

# Sina 分钟线仅支持 1/5/15/30/60 分钟，数据更新到最新交易日
SINA_PERIOD_MAP = {
    "1m": "1",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "60m": "60",
}

PERIOD_CHOICES = ["1m", "5m", "15m", "30m", "60m", "120m", "daily", "week", "month", "quarter", "year"]
ADJUST_CHOICES = ["bfq", "qfq", "hfq"]


def _sina_minute_prefix(market: int) -> str:
    return {1: "sh", 0: "sz", 2: "bj"}.get(market, "sz")


def _from_sina_minute(
    stock_code: str,
    market: int,
    period: str,
    adjust: str,
    start_date: str,
    end_date: str,
) -> list:
    """Fetch minute klines from Sina's public JSON API (real-time, covers latest trading day)."""
    symbol = f"{_sina_minute_prefix(market)}{stock_code}"
    scale = SINA_PERIOD_MAP[period]
    url = (
        "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
        f"?symbol={symbol}&scale={scale}&ma=no&datalen=1023"
    )
    r = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, list) or not data:
        return []

    # Filter by date range if provided
    def _in_range(dt: str) -> bool:
        if start_date and len(start_date) == 8 and dt < f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]} 00:00:00":
            return False
        if end_date and len(end_date) == 8 and dt > f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:8]} 23:59:59":
            return False
        return True

    klines = []
    prev_close = None
    for row in data:
        dt = str(row.get("day", ""))
        if not dt or not _in_range(dt):
            continue
        close_p = float(row["close"]) if row.get("close") not in (None, "") else None
        open_p = float(row["open"]) if row.get("open") not in (None, "") else None
        high_p = float(row["high"]) if row.get("high") not in (None, "") else None
        low_p = float(row["low"]) if row.get("low") not in (None, "") else None
        volume = float(row["volume"]) if row.get("volume") not in (None, "") else None

        change_pct = None
        change_amount = None
        amplitude = None
        if close_p is not None and prev_close is not None and prev_close != 0:
            change_pct = round((close_p - prev_close) / prev_close * 100, 4)
            change_amount = round(close_p - prev_close, 4)
        if high_p is not None and low_p is not None and low_p != 0:
            amplitude = round((high_p - low_p) / low_p * 100, 4)

        klines.append({
            "code": stock_code,
            "market": market,
            "period": period,
            "adjust": adjust,
            "date": dt,
            "open": open_p,
            "close": close_p,
            "high": high_p,
            "low": low_p,
            "volume": volume,
            "amount": None,
            "turnover": None,
            "change_pct": change_pct,
            "change_amount": change_amount,
            "amplitude": amplitude,
            "pre_close": prev_close,
        })
        prev_close = close_p

    return klines


def get_stock_kline(
    stock_code: str,
    market: int = 1,
    period: str = "daily",
    adjust: str = "bfq",
    start_date: str = "19700101",
    end_date: str = "20500101",
) -> dict:
    """
    Fetch K-line (OHLCV) data.
    Priority: mootdx (TCP direct) for bfq -> akshare for qfq/hfq or fallback.
    No JoinQuant dependency.

    - period: 1m,5m,15m,30m,60m,120m,daily,week,month,quarter,year
    - adjust: bfq (不复权), qfq (前复权), hfq (后复权)
    - start_date / end_date: YYYYMMDD
    """
    # 0. Minute periods: Sina via akshare is real-time and fresher than mootdx
    #    (mootdx public minute bars lag by multiple days).
    if period in SINA_PERIOD_MAP:
        try:
            klines = _from_sina_minute(
                stock_code, market, period, adjust, start_date, end_date
            )
            if klines:
                return {
                    "code": stock_code,
                    "market": market_label(stock_code) or ("SH" if market == 1 else "SZ" if market == 0 else "BJ"),
                    "period": period,
                    "adjust": adjust,
                    "start_date": start_date,
                    "end_date": end_date,
                    "count": len(klines),
                    "klines": klines,
                    "factors": [],
                    "_source": "sina_minute",
                }
        except Exception:
            logger.warning(
                f"Sina minute fetch failed for {stock_code} {period}", exc_info=True
            )
            # fall through to mootdx/akshare

    # 1. Primary: mootdx for bfq (TCP direct, ~77ms for daily)
    try:
        from mootdx_data import get_kline as mootdx_kline
        klines = mootdx_kline(
            stock_code, market, period=period,
            start=start_date, end=end_date
        )
        if klines:
            return {
                "code": stock_code,
                "market": market_label(stock_code) or ("SH" if market == 1 else "SZ"),
                "period": period,
                "adjust": adjust,
                "start_date": start_date,
                "end_date": end_date,
                "count": len(klines),
                "klines": klines,
                "factors": [],
                "_source": "mootdx",
            }
    except Exception:
        logger.warning(f"mootdx kline fetch failed for {stock_code}", exc_info=True)

    # 2. qfq/hfq are not supported by the TDX TCP protocol; the local DB keeps
    # bfq klines plus adjust factors, so callers should apply factors locally.
    return {
        "code": stock_code, "market": market_label(stock_code) or ("SH" if market == 1 else "SZ"),
        "period": period, "adjust": adjust,
        "start_date": start_date, "end_date": end_date,
        "count": 0, "klines": [], "factors": [],
        "error": "mootdx fetch returned no data "
        + (f"(adjust={adjust} not supported by TDX; use bfq + local adjust factors)" if adjust != "bfq" else ""),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch A-share K-line data (mootdx/akshare, no JoinQuant)")
    parser.add_argument("stock_code", help="6-digit stock code, e.g. 600845")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1, 2], help="1=Shanghai (default), 0=Shenzhen, 2=Beijing")
    parser.add_argument("--period", default="daily", choices=PERIOD_CHOICES, help="K-line period")
    parser.add_argument("--adjust", default="bfq", choices=ADJUST_CHOICES, help="Adjustment type")
    parser.add_argument("--start", default="19700101", help="Start date YYYYMMDD")
    parser.add_argument("--end", default="20500101", help="End date YYYYMMDD")
    args = parser.parse_args()

    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except ValueError:
        pass
    result = get_stock_kline(
        args.stock_code,
        market=args.market,
        period=args.period,
        adjust=args.adjust,
        start_date=args.start,
        end_date=args.end,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
