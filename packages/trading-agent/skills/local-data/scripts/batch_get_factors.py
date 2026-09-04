#!/usr/bin/env python3
"""Batch fetch adjustment factors via Tencent API (no JoinQuant dependency)."""
import argparse
import json
import os
import sys
import warnings
import logging
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed

from local_data.market import market_prefix

logger = logging.getLogger(__name__)

warnings.filterwarnings('ignore')

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)


def _market_prefix(code: str) -> str:
    return market_prefix(code, "lower") or f"sz{code}"



def _get_factors_single_tencent(code: str, market: int, start_date: str, end_date: str) -> list:
    """Fetch adjustment factors for a single stock via Tencent fqkline API.
    Makes 3 requests (bfq, qfq, hfq) since each mode only returns its own data.
    """
    import requests

    prefix = _market_prefix(code)

    # Tencent API requires YYYY-MM-DD format
    def _norm_date(d: str) -> str:
        if len(d) == 8:
            return f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        return d

    t_start = _norm_date(start_date)
    t_end = _norm_date(end_date)

    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://stock.finance.qq.com/"}

    def _fetch(fq: str) -> list:
        """Fetch kline list for given fq mode. Returns list of [date, open, close, high, low, volume]."""
        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={prefix},day,{t_start},{t_end},500,{fq}"
        try:
            r = requests.get(url, headers=headers, timeout=15)
            data = r.json()
            raw_data = data.get("data", {})
            if isinstance(raw_data, list):
                return []
            stock_data = raw_data.get(prefix, {}) if isinstance(raw_data, dict) else {}
            if not isinstance(stock_data, dict):
                return []
            # Each fq mode returns data in its own key:
            # bfq -> "day", qfq -> "qfqday", hfq -> "hfqday"
            key = {"bfq": "day", "qfq": "qfqday", "hfq": "hfqday"}.get(fq, "day")
            return stock_data.get(key, [])
        except Exception:
            logger.warning(f"Tencent fqkline fetch failed for {prefix}", exc_info=True)
            return []

    bfq_list = _fetch("bfq")
    qfq_list = _fetch("qfq")
    hfq_list = _fetch("hfq")

    if not bfq_list:
        return []

    # Build date -> close maps (index 2 = close)
    bfq_map = {item[0]: float(item[2]) for item in bfq_list if len(item) >= 3}
    qfq_map = {item[0]: float(item[2]) for item in qfq_list if len(item) >= 3}
    hfq_map = {item[0]: float(item[2]) for item in hfq_list if len(item) >= 3}

    factors = []
    for dt in sorted(bfq_map.keys()):
        bfq_close = bfq_map.get(dt)
        qfq_close = qfq_map.get(dt)
        hfq_close = hfq_map.get(dt)

        qfq_factor = None
        hfq_factor = None

        if bfq_close and bfq_close != 0 and qfq_close:
            qfq_factor = round(qfq_close / bfq_close, 6)
        if bfq_close and bfq_close != 0 and hfq_close:
            hfq_factor = round(hfq_close / bfq_close, 6)

        if qfq_factor is not None or hfq_factor is not None:
            factors.append({
                "code": code,
                "market": market,
                "date": dt,
                "qfq_factor": qfq_factor,
                "hfq_factor": hfq_factor,
            })

    return factors


def batch_get_factors(stock_codes, start_date, end_date, max_workers=4):
    """
    Fetch adjustment factors for multiple stocks.
    stock_codes: list of dicts with {code, market}
    Returns: list of factor dicts with code, market, date, qfq_factor, hfq_factor
    """
    all_factors = []

    def _fetch_one(item):
        code = item["code"]
        market = item.get("market", 0)
        try:
            # Try tencent API first (faster)
            factors = _get_factors_single_tencent(code, market, start_date, end_date)
            if factors:
                return factors
            raise RuntimeError(f"Tencent factor fetch returned no data for {code}")
        except Exception:
            logger.warning(f"Factor fetch failed for {code}", exc_info=True)
            return []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_fetch_one, item): item for item in stock_codes}
        for future in as_completed(futures):
            factors = future.result()
            all_factors.extend(factors)

    return all_factors


def main():
    parser = argparse.ArgumentParser(description="Batch fetch adjustment factors")
    parser.add_argument("--codes", required=True, help="Comma-separated 6-digit stock codes")
    parser.add_argument("--markets", default="", help="Comma-separated markets (1=SH,0=SZ), same order as codes")
    parser.add_argument("--start", default="20240101", help="Start date YYYYMMDD")
    parser.add_argument("--end", default="20500101", help="End date YYYYMMDD")
    args = parser.parse_args()

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    markets = [int(m.strip()) for m in args.markets.split(",") if m.strip()] if args.markets else []

    stock_codes = []
    for i, code in enumerate(codes):
        market = markets[i] if i < len(markets) else (1 if code.startswith("6") else 0)
        stock_codes.append({"code": code, "market": market})

    factors = batch_get_factors(stock_codes, args.start, args.end)
    print(json.dumps({"factors": factors, "count": len(factors)}, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
