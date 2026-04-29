#!/usr/bin/env python3
"""
Fetch market-wide sentiment data for A-shares.

Outputs JSON with:
- advance / decline / flat counts
- limit_up / limit_down counts
- northbound fund flow
- computed sentiment_index (0-100)
"""

import argparse
import json
import os
import sys
import io
import time
import urllib.request
import urllib.parse
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

CACHE_DIR = Path(__file__).parent / ".cache"


def _cache_path(iso_date: str) -> Path:
    return CACHE_DIR / f"sentiment_{iso_date}.json"


def load_cache(iso_date: str) -> dict | None:
    path = _cache_path(iso_date)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def save_cache(data: dict, iso_date: str) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(iso_date)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def fetch_zt_count(target_date: str) -> int:
    """Fetch limit-up (涨停) count for a given date."""
    try:
        import akshare as ak
        df = ak.stock_zt_pool_em(date=target_date)
        return len(df)
    except Exception as e:
        print(f"[warn] zt_pool fetch failed for {target_date}: {e}", file=sys.stderr)
        return 0


def fetch_dt_count(target_date: str) -> int:
    """Fetch limit-down (跌停) count for a given date."""
    try:
        import akshare as ak
        df = ak.stock_zt_pool_dtgc_em(date=target_date)
        return len(df)
    except Exception as e:
        print(f"[warn] dt_pool fetch failed for {target_date}: {e}", file=sys.stderr)
        return 0


def fetch_northbound_flow() -> float:
    """Fetch latest northbound (北向) net inflow in 亿元."""
    try:
        import akshare as ak
        # 沪股通历史数据，取最新一条的净流入
        df = ak.stock_hsgt_hist_em(symbol="沪股通")
        if df is None or df.empty:
            return 0.0
        # akshare returns columns like 净流入, 当日资金流入, etc.
        # Try common column names
        for col in ["净流入", "当日资金流入", "净买入额", "net_buy"]:
            if col in df.columns:
                latest = df[col].iloc[0]
                # Convert to float (might be string with 亿)
                if isinstance(latest, str):
                    latest = latest.replace("亿", "").replace(",", "").strip()
                return float(latest)
        return 0.0
    except Exception as e:
        print(f"[warn] northbound fetch failed: {e}", file=sys.stderr)
        return 0.0


def _extract_change_col(df) -> str | None:
    """Find the change_pct column in a spot dataframe."""
    for col in ["涨跌幅", "change_pct", "f170"]:
        if col in df.columns:
            return col
    for c in df.columns:
        if "涨跌幅" in str(c) or "change" in str(c).lower():
            return c
    return None


def _compute_distribution(df) -> dict:
    """Given a spot dataframe, compute advance/decline/flat counts."""
    change_col = _extract_change_col(df)
    if change_col is None:
        print("[warn] Could not find change_pct column in spot data", file=sys.stderr)
        return {"advance": 0, "decline": 0, "flat": 0, "total": len(df)}

    changes = pd.to_numeric(df[change_col], errors="coerce")
    advance = int((changes > 0).sum())
    decline = int((changes < 0).sum())
    flat = int((changes == 0).sum())
    return {"advance": advance, "decline": decline, "flat": flat, "total": len(df)}


def fetch_eastmoney_spot_distribution() -> dict | None:
    """Fetch advance/decline counts directly from Eastmoney API via HTTP.

    This is a lightweight fallback that requests only the fields we need
    (code + change_pct) in a single paginated request, avoiding the
    heavy multi-page fetches that stock_zh_a_spot_em performs.
    """
    try:
        base_url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1",
            "pz": "5000",
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fid": "f12",
            "fs": "m:0+t:6,m:0+t:13,m:1+t:2,m:1+t:23",
            "fields": "f12,f170",
            "ut": "fa5fd1943c7b386f172d6893dbfba10b",
            "_": str(int(time.time() * 1000)),
        }
        url = f"{base_url}?{urllib.parse.urlencode(params)}"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": "https://quote.eastmoney.com/",
            "Accept": "application/json",
        }

        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        if data.get("data") and data["data"].get("diff"):
            changes = []
            for item in data["data"]["diff"]:
                change = item.get("f170")
                if change is not None:
                    try:
                        changes.append(float(change))
                    except (ValueError, TypeError):
                        pass

            advance = sum(1 for c in changes if c > 0)
            decline = sum(1 for c in changes if c < 0)
            flat = sum(1 for c in changes if c == 0)
            return {"advance": advance, "decline": decline, "flat": flat, "total": len(changes)}
    except Exception as e:
        print(f"[warn] Eastmoney direct fetch failed: {e}", file=sys.stderr)
    return None


def fetch_spot_distribution(target_date: str) -> dict:
    """Fetch real-time spot data and compute advance/decline/flat counts.

    Tries akshare Sina source first, then a lightweight direct Eastmoney HTTP
    request. If market has not opened yet (all changes are 0), signals this
    so the caller can fall back to previous-trading-day zt/dt counts.
    """
    import akshare as ak

    # 1. Try akshare Sina source
    try:
        df = ak.stock_zh_a_spot()
        if df is not None and not df.empty:
            dist = _compute_distribution(df)
            if dist["total"] > 0 and (dist["advance"] + dist["decline"]) > 0:
                return dist
    except Exception as e:
        print(f"[warn] stock_zh_a_spot failed: {e}", file=sys.stderr)

    # 2. Fallback: direct lightweight Eastmoney HTTP request
    result = fetch_eastmoney_spot_distribution()
    if result and result["total"] > 0 and (result["advance"] + result["decline"]) > 0:
        return result

    # 3. Market not open yet (all changes are 0)
    print("[warn] Market may not be open yet (all changes are 0). Using previous trading day...", file=sys.stderr)
    return {"advance": 0, "decline": 0, "flat": 0, "total": 0, "not_open": True}


def compute_sentiment_index(advance: int, decline: int, flat: int, limit_up: int, limit_down: int, northbound: float) -> int:
    """Compute a 0-100 sentiment index."""
    total = advance + decline + flat
    if total == 0:
        return 50

    # Base score from advance/decline ratio
    base = (advance / total) * 100

    # Limit-up bonus (max +10)
    up_bonus = min(limit_up / 100 * 5, 10)

    # Limit-down penalty (max -10)
    down_penalty = min(limit_down / 100 * 5, 10)

    # Northbound flow bonus/penalty (max +/-15)
    nb_bonus = max(min(northbound / 100 * 3, 15), -15)

    score = base + up_bonus - down_penalty + nb_bonus
    return max(0, min(100, int(round(score))))


def get_last_trading_date(target: date) -> str:
    """Return the last trading date as YYYYMMDD. If target is weekend, go back to Friday."""
    wd = target.weekday()
    if wd == 5:  # Saturday
        target = target - timedelta(days=1)
    elif wd == 6:  # Sunday
        target = target - timedelta(days=2)
    return target.strftime("%Y%m%d")


def main():
    parser = argparse.ArgumentParser(description="Fetch A-share market sentiment data")
    parser.add_argument("--date", help="Target date (YYYY-MM-DD), default today")
    parser.add_argument("--no-cache", action="store_true", help="Force fresh fetch, ignore cache")
    args = parser.parse_args()

    if args.date:
        target = date.fromisoformat(args.date)
    else:
        target = date.today()

    trading_date = get_last_trading_date(target)
    iso_date = target.strftime("%Y-%m-%d")

    # Try cache first
    if not args.no_cache:
        cached = load_cache(iso_date)
        if cached:
            print(f"[info] Using cached sentiment for {iso_date}", file=sys.stderr)
            print(json.dumps(cached, ensure_ascii=False, indent=2))
            return

    print(f"[info] Fetching sentiment for {iso_date} (trading date {trading_date})", file=sys.stderr)

    # 1. Advance/decline/flat from spot
    spot = fetch_spot_distribution(trading_date)

    # Detect if market not open yet
    market_not_open = spot.get("not_open", False)
    if market_not_open:
        # Use previous trading day for zt/dt counts and note it in output
        from datetime import datetime, timedelta
        dt = datetime.strptime(trading_date, "%Y%m%d")
        prev = dt - timedelta(days=1)
        while prev.weekday() >= 5:
            prev -= timedelta(days=1)
        trading_date = prev.strftime("%Y%m%d")
        iso_date = prev.strftime("%Y-%m-%d")
        print(f"[info] Market not open, using previous trading day {iso_date}", file=sys.stderr)

    # 2. Limit-up / limit-down
    limit_up = fetch_zt_count(trading_date)
    limit_down = fetch_dt_count(trading_date)

    # 3. Northbound flow
    northbound = fetch_northbound_flow()

    # 4. Compute sentiment index
    if market_not_open:
        # Without advance/decline data, base sentiment on zt/dt + northbound only
        # Use a neutral base of 50
        base = 50
        up_bonus = min(limit_up / 100 * 5, 10)
        down_penalty = min(limit_down / 100 * 5, 10)
        nb_bonus = max(min(northbound / 100 * 3, 15), -15)
        sentiment = max(0, min(100, int(round(base + up_bonus - down_penalty + nb_bonus))))
    else:
        sentiment = compute_sentiment_index(
            spot["advance"], spot["decline"], spot["flat"],
            limit_up, limit_down, northbound
        )

    if market_not_open:
        result = {
            "date": iso_date,
            "trading_date": trading_date,
            "advance": None,
            "decline": None,
            "flat": None,
            "total": None,
            "limit_up": limit_up,
            "limit_down": limit_down,
            "northbound_flow": round(northbound, 2),
            "sentiment_index": sentiment,
            "note": "盘前数据（市场未开盘），涨跌家数不可用",
        }
    else:
        result = {
            "date": iso_date,
            "trading_date": trading_date,
            "advance": spot["advance"],
            "decline": spot["decline"],
            "flat": spot["flat"],
            "total": spot["total"],
            "limit_up": limit_up,
            "limit_down": limit_down,
            "northbound_flow": round(northbound, 2),
            "sentiment_index": sentiment,
        }

    save_cache(result, iso_date)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
