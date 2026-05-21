#!/usr/bin/env python3
"""
Fetch market-wide sentiment data for A-shares.

V3.1: iWencai integration for accurate limit counts and comprehensive sectors.
- Eastmoney clist/get for all A-share spot data (fast, ~10 pages)
- iWencai for accurate limit-up / limit-down counts (handles ST/5%, KCB/CYB/20%, BSE/30%)
- iWencai for comprehensive sector rankings (industry + concept sectors)
- 同花顺 hsgtApi for northbound flow
- Concurrent HTTP requests via thread pool
- 60s cache TTL during trading hours

Outputs JSON with:
- advance / decline / flat counts
- limit_up / limit_down counts (accurate via iWencai when API key available)
- northbound fund flow
- computed sentiment_index (0-100)
- top_sectors / bottom_sectors (comprehensive industry + concept ranking)
"""

import argparse
import json
import os
import sys
import io
import time
import urllib.request
import urllib.parse
import urllib.error
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

CACHE_DIR = Path(__file__).parent / ".cache"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

IWENCAI_API_KEY = os.environ.get("IWENCAI_API_KEY")
IWENCAI_BASE_URL = "https://openapi.iwencai.com"
# iWencai has a 100 calls/day quota. Enable only when explicitly requested.
USE_IWENCAI = os.environ.get("USE_IWENCAI", "0") == "1"

# Reusable SSL context
_SSL_CTX = None

def _get_ssl_ctx():
    global _SSL_CTX
    if _SSL_CTX is None:
        try:
            _SSL_CTX = ssl.create_default_context()
            try:
                _SSL_CTX.options |= ssl.OP_LEGACY_SERVER_CONNECT
            except AttributeError:
                pass
        except Exception:
            _SSL_CTX = ssl._create_unverified_context()
    return _SSL_CTX


def _cache_path(iso_date: str, suffix: str = "") -> Path:
    return CACHE_DIR / f"sentiment_v3_{iso_date}{suffix}.json"


def load_cache(iso_date: str, suffix: str = "") -> dict | None:
    path = _cache_path(iso_date, suffix)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def save_cache(data: dict, iso_date: str, suffix: str = "") -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(iso_date, suffix)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def is_trading_hours() -> bool:
    now = datetime.now()
    wd = now.weekday()
    if wd >= 5:
        return False
    h, m = now.hour, now.minute
    time_val = h * 60 + m
    return (570 <= time_val <= 690) or (780 <= time_val <= 900)


def cache_suffix() -> str:
    if is_trading_hours():
        return f"_h{datetime.now().hour}"
    return ""


def get_last_trading_date(target: date) -> str:
    wd = target.weekday()
    if wd == 5:
        target = target - timedelta(days=1)
    elif wd == 6:
        target = target - timedelta(days=2)
    return target.strftime("%Y%m%d")


def eastmoney_get(url: str, timeout: int = 15) -> dict:
    """Generic Eastmoney GET with proper headers and SSL."""
    headers = {
        "User-Agent": UA,
        "Referer": "https://quote.eastmoney.com/",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, headers=headers)
    kwargs = {"timeout": timeout}
    ctx = _get_ssl_ctx()
    if ctx:
        kwargs["context"] = ctx
    with urllib.request.urlopen(req, **kwargs) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ─── iWencai helpers ───────────────────────────────────────────

def iwencai_headers() -> dict:
    import secrets
    return {
        "Authorization": f"Bearer {IWENCAI_API_KEY}",
        "Content-Type": "application/json; charset=utf-8",
        "X-Claw-Call-Type": "normal",
        "X-Claw-Skill-Id": "hithink-astock-selector",
        "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": secrets.token_hex(32),
    }


def iwencai_query(query: str, page: str = "1", limit: str = "100") -> dict:
    """Call iWencai openapi and return raw JSON."""
    if not USE_IWENCAI or not IWENCAI_API_KEY:
        return {"_error": "iWencai not enabled (set USE_IWENCAI=1 to enable)"}
    payload = {
        "query": query,
        "page": page,
        "limit": limit,
        "is_cache": "1",
        "expand_index": "true",
    }
    req = urllib.request.Request(
        f"{IWENCAI_BASE_URL}/v1/query2data",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=iwencai_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"_error": str(e)}


def iwencai_count(query: str) -> int | None:
    """Return total match count for a query (or None on error)."""
    result = iwencai_query(query, "1", "1")
    if "_error" in result:
        return None
    return result.get("code_count")


def iwencai_sectors(query: str, top_n: int = 10) -> list[dict]:
    """Fetch sector rankings from iWencai."""
    result = iwencai_query(query, "1", str(top_n))
    if "_error" in result:
        print(f"[warn] iWencai sector query failed: {result['_error']}", file=sys.stderr)
        return []
    datas = result.get("datas", [])
    sectors = []
    for d in datas:
        # Extract fields flexibly — column names vary by query type
        name = (
            d.get("板块名称")
            or d.get("指数简称")
            or d.get("股票简称")
            or d.get("概念名称")
            or ""
        )
        change = (
            d.get("板块涨跌幅")
            or d.get("最新涨跌幅:前复权")
            or d.get("最新涨跌幅:前复权:")
            or d.get("最新涨跌幅")
            or d.get("涨跌幅")
        )
        up_cnt = d.get("上涨家数") or d.get("f104") or 0
        down_cnt = d.get("下跌家数") or d.get("f105") or 0
        leader = d.get("领涨股票") or d.get("f140") or ""
        leader_chg = d.get("领涨股票涨跌幅") or d.get("f136") or 0
        try:
            change_pct = round(float(change), 2) if change is not None else 0.0
        except (ValueError, TypeError):
            change_pct = 0.0
        sectors.append({
            "name": name,
            "change_pct": change_pct,
            "up_count": int(up_cnt) if up_cnt else 0,
            "down_count": int(down_cnt) if down_cnt else 0,
            "leader": leader,
            "leader_change": leader_chg,
        })
    return sectors


def fetch_page(pn: int, pz: int, fs: str, fields: str, retries: int = 2) -> list[dict]:
    """Fetch a single page of Eastmoney clist data with retries."""
    base_url = "https://push2.eastmoney.com/api/qt/clist/get"
    params = {
        "pn": str(pn),
        "pz": str(pz),
        "po": "1",
        "np": "1",
        "fltt": "2",
        "invt": "2",
        "fid": "f12",
        "fs": fs,
        "fields": fields,
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        "_": str(int(time.time() * 1000)),
    }
    url = f"{base_url}?{urllib.parse.urlencode(params)}"
    last_error = None
    for attempt in range(retries + 1):
        try:
            data = eastmoney_get(url, timeout=20)
            if data.get("data") and data["data"].get("diff"):
                return data["data"]["diff"]
            return []
        except Exception as e:
            last_error = e
            if attempt < retries:
                time.sleep(0.3 * (attempt + 1))
    print(f"[warn] Page {pn} fetch failed after {retries} retries: {last_error}", file=sys.stderr)
    return []


def _get_limit_pct(code: str, name: str = "") -> float:
    """Return the price limit percentage for a given stock code/name."""
    # ST stocks: 5% limit
    if name and ("ST" in name or "*ST" in name or "SST" in name):
        return 5.0

    prefix = code[:3] if len(code) >= 3 else code
    prefix2 = code[:2] if len(code) >= 2 else code

    # 北交所 (Beijing Stock Exchange): 30% limit
    if prefix2 in ("43", "83", "87", "88", "82") or (len(code) >= 6 and code[0] in ("4", "8")):
        return 30.0

    # 科创板 (STAR Market): 20% limit
    if prefix in ("688", "689"):
        return 20.0

    # 创业板 (ChiNext): 20% limit
    if prefix in ("300", "301"):
        return 20.0

    # 主板 (Main board): 10% limit (default)
    return 10.0


def fetch_all_spot_data() -> dict:
    """
    Fetch all A-share spot data via Eastmoney clist/get.
    Uses concurrent page fetching for speed.
    Also computes accurate limit-up/limit-down counts based on stock type.
    """
    # All A-shares: 沪市主板(m:1+t:2) + 沪市科创板(m:1+t:23) +
    #                深市主板(m:0+t:6) + 深市创业板(m:0+t:80)
    fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
    fields = "f12,f3,f14"  # code, change_pct, name
    pz = 500  # page size: 500 per request (~11 pages for 5500 stocks)

    # First, fetch page 1 to get total count
    page1 = fetch_page(1, pz, fs, fields)
    if not page1:
        return {"advance": 0, "decline": 0, "flat": 0, "total": 0, "limit_up": 0, "limit_down": 0}

    # Estimate total pages (max 12 for ~5500 stocks)
    total_pages = 12

    all_items = list(page1)

    if total_pages > 1:
        # Fetch remaining pages concurrently
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = {executor.submit(fetch_page, pn, pz, fs, fields): pn for pn in range(2, total_pages + 1)}
            for future in as_completed(futures):
                items = future.result()
                if items:
                    all_items.extend(items)

    advance = decline = flat = limit_up = limit_down = 0
    for item in all_items:
        change = item.get("f3")
        if change is None:
            continue
        try:
            c = float(change)
        except (ValueError, TypeError):
            continue
        if c > 0:
            advance += 1
        elif c < 0:
            decline += 1
        else:
            flat += 1

        # Accurate limit detection based on stock type
        code = item.get("f12", "")
        name = item.get("f14", "")
        limit_pct = _get_limit_pct(code, name)
        # Allow small tolerance (e.g., 9.97% counts as 10% limit)
        if c >= limit_pct * 0.997:
            limit_up += 1
        if c <= -limit_pct * 0.997:
            limit_down += 1

    return {
        "advance": advance,
        "decline": decline,
        "flat": flat,
        "total": len(all_items),
        "limit_up": limit_up,
        "limit_down": limit_down,
    }


def fetch_iwencai_limit_counts() -> dict:
    """
    Fetch accurate limit-up / limit-down counts from iWencai.
    iWencai knows the actual price limit rules (ST=5%, main=10%, KCB/CYB=20%, BSE=30%).
    NOTE: Sequential execution is faster than ThreadPool here due to urllib/GIL quirks.
    """
    if not USE_IWENCAI or not IWENCAI_API_KEY:
        return {"limit_up": None, "limit_down": None}

    up_count = iwencai_count("今日涨停的A股")
    down_count = iwencai_count("今日跌停的A股")

    return {
        "limit_up": up_count,
        "limit_down": down_count,
    }


def fetch_industry_sectors_eastmoney(top_n: int = 5) -> dict:
    """
    Fallback: Fetch industry sector rankings via Eastmoney clist/get.
    """
    fs = "m:90+t:2"
    fields = "f2,f3,f4,f12,f14,f104,f105,f128,f136,f140,f141,f207"
    pz = 100

    base_url = "https://push2.eastmoney.com/api/qt/clist/get"
    params = {
        "pn": "1",
        "pz": str(pz),
        "po": "1",
        "np": "1",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": fs,
        "fields": fields,
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        "_": str(int(time.time() * 1000)),
    }
    url = f"{base_url}?{urllib.parse.urlencode(params)}"

    try:
        data = eastmoney_get(url, timeout=15)
        items = data.get("data", {}).get("diff", [])
        if not items:
            return {"top": [], "bottom": []}

        rows = []
        for item in items:
            change_pct = item.get("f3")
            if change_pct is None:
                continue
            try:
                change_pct = float(change_pct)
            except (ValueError, TypeError):
                continue
            rows.append({
                "name": item.get("f14", ""),
                "change_pct": round(change_pct, 2),
                "up_count": item.get("f104", 0),
                "down_count": item.get("f105", 0),
                "leader": item.get("f140", ""),
                "leader_change": item.get("f136", 0),
            })

        rows.sort(key=lambda x: x["change_pct"], reverse=True)
        return {
            "top": rows[:top_n],
            "bottom": rows[-top_n:][::-1],
        }
    except Exception as e:
        print(f"[warn] Eastmoney sector fetch failed: {e}", file=sys.stderr)
        return {"top": [], "bottom": []}


def fetch_iwencai_sectors(top_n: int = 5) -> dict:
    """
    Fetch comprehensive sector rankings from iWencai.
    Returns both industry (行业) and concept (概念) sectors for richer display.
    Falls back to Eastmoney if iWencai is unavailable or returns errors.
    """
    if not USE_IWENCAI or not IWENCAI_API_KEY:
        return fetch_industry_sectors_eastmoney(top_n)

    # Query both industry and concept sectors
    industry_top = iwencai_sectors_query("今日涨幅前10的行业板块", top_n)
    industry_bottom = iwencai_sectors_query("今日跌幅前10的行业板块", top_n)
    concept_top = iwencai_sectors_query("今日涨幅前10的概念板块", top_n)
    concept_bottom = iwencai_sectors_query("今日跌幅前10的概念板块", top_n)

    # If all iWencai queries failed, fall back to Eastmoney
    if not industry_top and not concept_top and not industry_bottom and not concept_bottom:
        print("[info] iWencai sector queries failed, falling back to Eastmoney", file=sys.stderr)
        return fetch_industry_sectors_eastmoney(top_n)

    # Merge and deduplicate by name, preferring industry sectors
    seen = set()
    top_rows = []
    for s in industry_top + concept_top:
        name = s.get("name", "")
        if name and name not in seen:
            seen.add(name)
            top_rows.append(s)

    seen.clear()
    bottom_rows = []
    for s in industry_bottom + concept_bottom:
        name = s.get("name", "")
        if name and name not in seen:
            seen.add(name)
            bottom_rows.append(s)

    # Sort by change_pct
    top_rows.sort(key=lambda x: x["change_pct"], reverse=True)
    bottom_rows.sort(key=lambda x: x["change_pct"])

    return {
        "top": top_rows[:top_n],
        "bottom": bottom_rows[:top_n],
    }


def iwencai_sectors_query(query: str, top_n: int = 10) -> list[dict]:
    """Thin wrapper around iwencai_query for sector data."""
    result = iwencai_query(query, "1", str(top_n))
    if "_error" in result:
        print(f"[warn] iWencai sector query failed: {result['_error']}", file=sys.stderr)
        return []
    datas = result.get("datas", [])
    sectors = []
    for d in datas:
        name = (
            d.get("板块名称")
            or d.get("指数简称")
            or d.get("股票简称")
            or d.get("概念名称")
            or ""
        )
        change = (
            d.get("板块涨跌幅")
            or d.get("最新涨跌幅:前复权")
            or d.get("最新涨跌幅:前复权:")
            or d.get("最新涨跌幅")
            or d.get("涨跌幅")
        )
        up_cnt = d.get("上涨家数") or d.get("f104") or 0
        down_cnt = d.get("下跌家数") or d.get("f105") or 0
        leader = d.get("领涨股票") or d.get("f140") or ""
        leader_chg = d.get("领涨股票涨跌幅") or d.get("f136") or 0
        try:
            change_pct = round(float(change), 2) if change is not None else 0.0
        except (ValueError, TypeError):
            change_pct = 0.0
        sectors.append({
            "name": name,
            "change_pct": change_pct,
            "up_count": int(up_cnt) if up_cnt else 0,
            "down_count": int(down_cnt) if down_cnt else 0,
            "leader": leader,
            "leader_change": leader_chg,
        })
    return sectors


def fetch_northbound_flow() -> float:
    """Fetch latest northbound net inflow in 亿元 from 同花顺 hsgtApi."""
    try:
        url = "https://data.hexin.cn/market/hsgtApi/method/dayChart/"
        headers = {
            "User-Agent": UA,
            "Host": "data.hexin.cn",
            "Referer": "https://data.hexin.cn/",
        }
        req = urllib.request.Request(url, headers=headers)
        ctx = _get_ssl_ctx()
        kwargs = {"timeout": 15}
        if ctx:
            kwargs["context"] = ctx
        with urllib.request.urlopen(req, **kwargs) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        hgt = data.get("hgt", [])
        sgt = data.get("sgt", [])

        hgt_latest = 0.0
        sgt_latest = 0.0
        for v in reversed(hgt):
            if v is not None:
                try:
                    hgt_latest = float(v)
                    break
                except (ValueError, TypeError):
                    continue
        for v in reversed(sgt):
            if v is not None:
                try:
                    sgt_latest = float(v)
                    break
                except (ValueError, TypeError):
                    continue

        return round(hgt_latest + sgt_latest, 2)
    except Exception as e:
        print(f"[warn] 同花顺 northbound fetch failed: {e}", file=sys.stderr)
        return 0.0


def compute_sentiment_index(advance: int, decline: int, flat: int,
                             limit_up: int, limit_down: int, northbound: float) -> int:
    total = advance + decline + flat
    if total == 0:
        return 50
    base = (advance / total) * 100
    up_bonus = min(limit_up / 100 * 5, 10)
    down_penalty = min(limit_down / 100 * 5, 10)
    nb_bonus = max(min(northbound / 100 * 3, 15), -15)
    score = base + up_bonus - down_penalty + nb_bonus
    return max(0, min(100, int(round(score))))


def main():
    parser = argparse.ArgumentParser(description="Fetch A-share market sentiment data (v3.0)")
    parser.add_argument("--date", help="Target date (YYYY-MM-DD), default today")
    parser.add_argument("--no-cache", action="store_true", help="Force fresh fetch, ignore cache")
    args = parser.parse_args()

    if args.date:
        target = date.fromisoformat(args.date)
    else:
        target = date.today()

    trading_date = get_last_trading_date(target)
    iso_date = target.strftime("%Y-%m-%d")
    cache_key = cache_suffix()

    # Try cache first
    if not args.no_cache:
        cached = load_cache(iso_date, cache_key)
        if cached:
            print(f"[info] Using cached sentiment for {iso_date}{cache_key}", file=sys.stderr)
            print(json.dumps(cached, ensure_ascii=False, indent=2))
            return

    print(f"[info] Fetching sentiment for {iso_date} (trading date {trading_date})", file=sys.stderr)
    t0 = time.time()

    # Fetch data sources.
    # NOTE: Eastmoney and iWencai are fetched sequentially to avoid urllib
    # contention on Windows. Each source is fast individually (<2s).
    spot = fetch_all_spot_data()
    northbound = fetch_northbound_flow()

    # iWencai for accurate limit counts (handles ST/5%, KCB/CYB/20%, BSE/30%)
    iwencai_limits = fetch_iwencai_limit_counts()

    # Sector rankings: iWencai (industry + concept) with Eastmoney fallback
    sectors = fetch_iwencai_sectors(5)

    # Detect if market not open yet
    market_not_open = spot is None or spot["total"] == 0 or (spot["advance"] == 0 and spot["decline"] == 0)
    if market_not_open:
        print("[warn] Market may not be open yet. Using previous trading day...", file=sys.stderr)
        prev = datetime.strptime(trading_date, "%Y%m%d") - timedelta(days=1)
        while prev.weekday() >= 5:
            prev -= timedelta(days=1)
        trading_date = prev.strftime("%Y%m%d")
        iso_date = prev.strftime("%Y-%m-%d")
        spot = fetch_all_spot_data()

    if spot is None:
        spot = {"advance": 0, "decline": 0, "flat": 0, "total": 0, "limit_up": 0, "limit_down": 0}

    # Use iWencai limit counts when available (accurate for ST/5%, KCB/CYB/20%, BSE/30%)
    limit_up = iwencai_limits.get("limit_up") if iwencai_limits else None
    limit_down = iwencai_limits.get("limit_down") if iwencai_limits else None
    # Fallback to Eastmoney computed counts if iWencai unavailable
    if limit_up is None:
        limit_up = spot["limit_up"]
    if limit_down is None:
        limit_down = spot["limit_down"]

    # Compute sentiment
    if market_not_open:
        base = 50
        up_bonus = min(limit_up / 100 * 5, 10) if limit_up else 0
        down_penalty = min(limit_down / 100 * 5, 10) if limit_down else 0
        nb_bonus = max(min(northbound / 100 * 3, 15), -15)
        sentiment = max(0, min(100, int(round(base + up_bonus - down_penalty + nb_bonus))))
    else:
        sentiment = compute_sentiment_index(
            spot["advance"], spot["decline"], spot["flat"],
            limit_up or 0, limit_down or 0, northbound
        )

    latency = round((time.time() - t0) * 1000, 1)

    # Build source label
    sources = ["eastmoney"]
    if USE_IWENCAI and IWENCAI_API_KEY and iwencai_limits and iwencai_limits.get("limit_up") is not None:
        sources.append("iwencai")
    sources.append(f"ths ({latency}ms)")

    result = {
        "date": iso_date,
        "trading_date": trading_date,
        "advance": spot["advance"] if not market_not_open else None,
        "decline": spot["decline"] if not market_not_open else None,
        "flat": spot["flat"] if not market_not_open else None,
        "total": spot["total"] if not market_not_open else None,
        "limit_up": limit_up,
        "limit_down": limit_down,
        "northbound_flow": northbound,
        "sentiment_index": sentiment,
        "top_sectors": sectors.get("top", []) if sectors else [],
        "bottom_sectors": sectors.get("bottom", []) if sectors else [],
        "_source": "+".join(sources),
    }
    if market_not_open:
        result["note"] = "盘前数据（市场未开盘），涨跌家数不可用"

    save_cache(result, iso_date, cache_key)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
