#!/usr/bin/env python3
"""Batch fetch K-line data for multiple stocks via mootdx (TDX TCP)."""
import argparse
import json
import os
import sys
import io
import warnings
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

from local_data.market import is_a_share, market_from_code

logger = logging.getLogger(__name__)

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# mootdx — TCP direct to TDX quote servers, no auth required
try:
    from mootdx_data import get_kline as mootdx_kline
except ImportError:
    mootdx_kline = None

# Map our adjust codes for argparse choices
FQT_MAP = {
    "bfq": "bfq",
    "qfq": "qfq",
    "hfq": "hfq",
}

# Map our period codes for argparse choices (mootdx supports all natively)
FREQ_MAP = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "60m": "60m",
    "120m": "120m",
    "daily": "daily",
    "week": "week",
    "month": "month",
    "quarter": "quarter",
    "year": "year",
}


def batch_get_kline(stock_codes, start_date, end_date, period="daily", adjust="bfq"):
    """
    Fetch K-line for multiple stocks via mootdx (TDX TCP).

    stock_codes: list of dicts with {code, market}
    Returns: list of kline dicts with code, market, date, open, close, etc.

    mootdx supports daily/week/month/quarter/year frequencies natively.
    Only bfq (unadjusted) is supported by the TCP protocol; qfq/hfq callers
    should apply factor adjustments afterwards.
    """
    all_klines = []

    def _fetch_one(item):
        code = item["code"]
        if not is_a_share(code):
            return []
        if mootdx_kline is None:
            return []
        # TDX TCP servers are flaky under concurrency: retry a few times before
        # giving up so a transient empty/error response does not silently lose data.
        for attempt in range(3):
            try:
                rows = mootdx_kline(
                    item["code"], item.get("market", 0),
                    period=period, adjust=adjust,
                    start=start_date, end=end_date,
                )
                if rows:
                    return rows
            except Exception as e:
                logger.debug(f"mootdx kline fetch failed for {code}: {e}")
        return []

    # Concurrent fetch — mootdx TCP is lightweight, 8 workers is safe
    max_workers = min(8, max(1, len(stock_codes)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_item = {executor.submit(_fetch_one, item): item for item in stock_codes}
        for future in as_completed(future_to_item):
            item = future_to_item[future]
            try:
                rows = future.result()
                all_klines.extend(rows)
            except Exception as e:
                logger.debug(f"fetch failed for {item['code']}: {e}")

    return all_klines


def main():
    parser = argparse.ArgumentParser(description="Batch fetch A-share K-line (mootdx TDX TCP)")
    parser.add_argument("--codes", required=True, help="Comma-separated 6-digit stock codes")
    parser.add_argument("--markets", default="", help="Comma-separated markets (1=SH,0=SZ), same order as codes")
    parser.add_argument("--start", default="20240101", help="Start date YYYYMMDD")
    parser.add_argument("--end", default="20500101", help="End date YYYYMMDD")
    parser.add_argument("--period", default="daily", choices=list(FREQ_MAP.keys()))
    parser.add_argument("--adjust", default="bfq", choices=list(FQT_MAP.keys()))
    args = parser.parse_args()

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    markets = [int(m.strip()) for m in args.markets.split(",") if m.strip()] if args.markets else []

    stock_codes = []
    for i, code in enumerate(codes):
        market = markets[i] if i < len(markets) else (market_from_code(code) or 0)
        stock_codes.append({"code": code, "market": market})

    klines = batch_get_kline(stock_codes, args.start, args.end, args.period, args.adjust)
    print(json.dumps({"klines": klines, "count": len(klines)}, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
