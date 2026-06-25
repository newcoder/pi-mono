#!/usr/bin/env python3
"""
mootdx 数据获取封装 — TCP 直连通达信服务器，作为主数据源使用。
失败时返回 error，由调用方决定是否回退到 HTTP API。

已测试延迟（本地环境）：
- 实时报价: ~15ms
- 财务快照: ~15ms
- F10 公司概况: ~35ms
- K线(日线): ~20ms

用法：
  python mootdx_fetch.py quote --code 688017 --market 1
  python mootdx_fetch.py klines --code 688017 --market 1 --period daily --limit 100
  python mootdx_fetch.py finance --code 688017 --market 1
  python mootdx_fetch.py f10 --code 688017 --name 公司概况
"""
import argparse
import io
import json
import sys
import time
from typing import Any, Dict, List, Optional

# ─── mootdx client singleton ──────────────────────────────────

_mootdx_client = None
_client_init_ms = 0.0


def _get_client():
    """Lazy-init mootdx Quotes client."""
    global _mootdx_client, _client_init_ms
    if _mootdx_client is None:
        t0 = time.time()
        from mootdx.quotes import Quotes
        _mootdx_client = Quotes.factory(market="std")
        _client_init_ms = round((time.time() - t0) * 1000, 1)
    return _mootdx_client


def _safe_float(val) -> Optional[float]:
    """Safely convert a value to float, returning None on failure."""
    if val is None:
        return None
    try:
        import pandas as pd
        if pd.isna(val):
            return None
    except ImportError:
        pass
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _safe_int(val) -> Optional[int]:
    """Safely convert a value to int, returning None on failure."""
    if val is None:
        return None
    try:
        import pandas as pd
        if pd.isna(val):
            return None
    except ImportError:
        pass
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


# ─── Real-time Quote ──────────────────────────────────────────

def fetch_quote(code: str, market: int = 1) -> Dict[str, Any]:
    """
    Fetch real-time quote via mootdx (TCP).
    Returns dict matching existing router.ts quote format.
    """
    t0 = time.time()
    client = _get_client()
    df = client.quotes(symbol=code)
    if df is None or len(df) == 0:
        raise RuntimeError("mootdx quotes returned empty")

    row = df.iloc[0]
    price = _safe_float(row.get("price"))
    last_close = _safe_float(row.get("last_close"))
    open_p = _safe_float(row.get("open"))
    high = _safe_float(row.get("high"))
    low = _safe_float(row.get("low"))
    volume = _safe_float(row.get("volume"))
    vol = _safe_float(row.get("vol"))
    amount = _safe_float(row.get("amount"))

    change_pct = None
    if price is not None and last_close and last_close != 0:
        change_pct = round((price - last_close) / last_close * 100, 4)

    latency = round((time.time() - t0) * 1000, 1)
    return {
        "code": code,
        "market": market,
        "name": None,
        "latest": price,
        "open": open_p,
        "high": high,
        "low": low,
        "prev_close": last_close,
        "volume": volume if volume is not None else vol,
        "amount": amount,
        "change_pct": change_pct,
        "_source": f"mootdx ({latency}ms)",
        "_client_init_ms": _client_init_ms,
    }


# ─── K-line ───────────────────────────────────────────────────

def fetch_klines(
    code: str,
    market: int = 1,
    period: str = "daily",
    adjust: str = "bfq",
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """
    Fetch kline data via mootdx (TCP).
    Returns list of kline dicts matching existing format.
    """
    t0 = time.time()
    client = _get_client()

    # mootdx category mapping (bars uses category, not frequency)
    # Reference: mootdx source
    # 0=5分钟, 1=15分钟, 2=30分钟, 3=60分钟, 4=日线, 5=周线, 6=月线, 7=1分钟,
    # 8=1分钟 (alt), 9=日线 (alt), 10=季线, 11=年线
    category_map = {
        "1m": 7,
        "5m": 0,
        "15m": 1,
        "30m": 2,
        "60m": 3,
        "daily": 4,
        "week": 5,
        "month": 6,
        "quarter": 10,
        "year": 11,
    }
    category = category_map.get(period, 4)

    df = client.bars(symbol=code, category=category, offset=max(limit, 100))
    if df is None or len(df) == 0:
        raise RuntimeError("mootdx bars returned empty")

    klines = []
    prev_close = None
    for _, row in df.iterrows():
        dt_val = row.get("datetime", "")
        if hasattr(dt_val, "strftime"):
            date_str = dt_val.strftime("%Y-%m-%d")
        else:
            date_str = str(dt_val)[:10] if dt_val else ""

        open_p = _safe_float(row.get("open"))
        close_p = _safe_float(row.get("close"))
        high_p = _safe_float(row.get("high"))
        low_p = _safe_float(row.get("low"))
        volume = _safe_float(row.get("volume"))
        if volume is None:
            volume = _safe_float(row.get("vol"))
        turnover = _safe_float(row.get("amount"))

        change_pct = None
        change_amount = None
        if close_p is not None and prev_close is not None and prev_close != 0:
            change_pct = round((close_p - prev_close) / prev_close * 100, 4)
            change_amount = round(close_p - prev_close, 4)

        amplitude = None
        if high_p is not None and low_p is not None and low_p != 0:
            amplitude = round((high_p - low_p) / low_p * 100, 4)

        klines.append({
            "code": code,
            "market": market,
            "period": period,
            "adjust": adjust,
            "date": date_str,
            "open": open_p,
            "high": high_p,
            "low": low_p,
            "close": close_p,
            "volume": volume,
            "turnover": turnover,
            "change_pct": change_pct,
            "change_amount": change_amount,
            "amplitude": amplitude,
            "pre_close": prev_close,
        })

        prev_close = close_p

    if limit > 0:
        klines = klines[-limit:]

    latency = round((time.time() - t0) * 1000, 1)
    for k in klines:
        k["_source"] = f"mootdx ({latency}ms)"
    klines[0]["_client_init_ms"] = _client_init_ms
    return klines


# ─── Financial Snapshot ───────────────────────────────────────

def fetch_finance(code: str, market: int = 1) -> Dict[str, Any]:
    """
    Fetch financial snapshot via mootdx (TCP).
    Returns key financial metrics.
    """
    t0 = time.time()
    client = _get_client()
    df = client.finance(symbol=code)
    if df is None or len(df) == 0:
        raise RuntimeError("mootdx finance returned empty")

    row = df.iloc[0]

    # mootdx finance fields (Chinese pinyin)
    net_profit = _safe_float(row.get("jinglirun"))
    equity_val = _safe_float(row.get("jingzichan"))
    total_assets = _safe_float(row.get("zongzichan"))
    current_liab = _safe_float(row.get("liudongfuzhai"))
    long_liab = _safe_float(row.get("changqifuzhai"))
    total_liabilities = None
    if current_liab is not None:
        total_liabilities = current_liab + (long_liab or 0)
    revenue = _safe_float(row.get("zhuyingshouru"))
    bps = _safe_float(row.get("meigujingzichan"))
    total_shares = _safe_float(row.get("zongguben"))
    float_shares = _safe_float(row.get("liutongguben"))
    operating_cf = _safe_float(row.get("jingyingxianjinliu"))

    roe = None
    if net_profit is not None and equity_val and equity_val != 0:
        roe = round(net_profit / equity_val * 100, 2)

    eps = None
    if net_profit is not None and total_shares and total_shares != 0:
        eps = round(net_profit / total_shares, 4)

    # Report date from updated_date (YYYYMMDD)
    updated = row.get("updated_date")
    report_date = None
    if updated is not None:
        s = str(int(updated))
        if len(s) == 8:
            report_date = f"{s[:4]}-{s[4:6]}-{s[6:8]}"

    latency = round((time.time() - t0) * 1000, 1)
    return {
        "code": code,
        "market": market,
        "report_date": report_date,
        "roe": roe,
        "eps": eps,
        "bps": bps,
        "revenue": revenue,
        "net_profit": net_profit,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "equity": equity_val,
        "total_shares": total_shares,
        "float_shares": float_shares,
        "operating_cashflow": operating_cf,
        "_source": f"mootdx ({latency}ms)",
        "_client_init_ms": _client_init_ms,
    }


# ─── F10 ──────────────────────────────────────────────────────

def fetch_f10(code: str, name: str = "公司概况") -> Dict[str, Any]:
    """
    Fetch F10 text via mootdx (TCP).
    Returns raw text and extracted fields.
    """
    t0 = time.time()
    client = _get_client()
    text = client.F10(symbol=code, name=name)
    if text is None:
        raise RuntimeError("mootdx F10 returned empty")

    latency = round((time.time() - t0) * 1000, 1)
    return {
        "code": code,
        "name": name,
        "text": text,
        "length": len(text),
        "_source": f"mootdx ({latency}ms)",
        "_client_init_ms": _client_init_ms,
    }


# ─── CLI ──────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except ValueError:
        pass

    parser = argparse.ArgumentParser(description="mootdx data fetcher (TCP direct)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # quote
    p_quote = subparsers.add_parser("quote", help="Real-time quote")
    p_quote.add_argument("--code", required=True)
    p_quote.add_argument("--market", type=int, default=1)

    # klines
    p_klines = subparsers.add_parser("klines", help="K-line data")
    p_klines.add_argument("--code", required=True)
    p_klines.add_argument("--market", type=int, default=1)
    p_klines.add_argument("--period", default="daily")
    p_klines.add_argument("--adjust", default="bfq")
    p_klines.add_argument("--limit", type=int, default=100)

    # finance
    p_finance = subparsers.add_parser("finance", help="Financial snapshot")
    p_finance.add_argument("--code", required=True)
    p_finance.add_argument("--market", type=int, default=1)

    # f10
    p_f10 = subparsers.add_parser("f10", help="F10 company overview")
    p_f10.add_argument("--code", required=True)
    p_f10.add_argument("--name", default="公司概况")

    args = parser.parse_args()

    try:
        if args.command == "quote":
            result = fetch_quote(args.code, args.market)
        elif args.command == "klines":
            result = fetch_klines(args.code, args.market, args.period, args.adjust, args.limit)
        elif args.command == "finance":
            result = fetch_finance(args.code, args.market)
        elif args.command == "f10":
            result = fetch_f10(args.code, args.name)
        else:
            raise ValueError(f"Unknown command: {args.command}")

        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e), "code": args.code}, ensure_ascii=False))
        sys.exit(1)
