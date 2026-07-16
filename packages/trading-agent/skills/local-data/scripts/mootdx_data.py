#!/usr/bin/env python3
"""
mootdx 数据获取封装 — TCP 直连通达信服务器，低延迟高稳定。
作为主接口源使用；失败时由调用方回退到 HTTP API。

已测试延迟（本地环境）：
- 实时报价: ~15ms
- 财务快照: ~15ms
- F10 公司概况: ~34ms
- K线(日线): ~77ms
"""
import json
import sys
import io
import time
import logging
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)

# ─── mootdx client singleton ──────────────────────────────────

_mootdx_client = None


def _get_client():
    """Lazy-init mootdx Quotes client."""
    global _mootdx_client
    if _mootdx_client is None:
        from mootdx.quotes import Quotes
        _mootdx_client = Quotes.factory(market="std")
    return _mootdx_client


def _market_prefix(code: str) -> str:
    """Return sh/sz prefix for mootdx."""
    if code.startswith(("6", "9")):
        return f"sh{code}"
    return f"sz{code}"


# ─── Real-time Quote ──────────────────────────────────────────

def get_quote(code: str, market: int = 1, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
    """
    Fetch real-time quote via mootdx (TCP). Returns dict matching existing format,
    or None on failure so caller can fallback to HTTP API.
    """
    t0 = time.time()
    try:
        client = _get_client()
        df = client.quotes(symbol=code)
        if df is None or df.empty:
            return None

        row = df.iloc[0]
        price = float(row.get("price", 0)) if pd_notna(row.get("price")) else 0
        last_close = float(row.get("last_close", 0)) if pd_notna(row.get("last_close")) else 0
        change_pct = 0.0
        if last_close and price:
            change_pct = round((price - last_close) / last_close * 100, 4)

        latency = round((time.time() - t0) * 1000, 1)
        return {
            "name": None,
            "code": code,
            "latest": price if price else None,
            "open": float(row.get("open", 0)) if pd_notna(row.get("open")) else None,
            "high": float(row.get("high", 0)) if pd_notna(row.get("high")) else None,
            "low": float(row.get("low", 0)) if pd_notna(row.get("low")) else None,
            "prev_close": last_close if last_close else None,
            "volume": float(row.get("volume", 0)) if pd_notna(row.get("volume")) else None,
            "turnover": None,
            "change_pct": change_pct if change_pct else None,
            "total_cap": None,
            "float_cap": None,
            "pe": None,
            "pb": None,
            "high_52w": None,
            "low_52w": None,
            "_source": f"mootdx ({latency}ms)",
        }
    except Exception:
        logger.warning("mootdx get_quote failed", exc_info=True)
        return None


# ─── K-line ───────────────────────────────────────────────────

def get_kline(
    code: str,
    market: int = 1,
    period: str = "daily",
    adjust: str = "bfq",
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 0,
    timeout: float = 10.0,
) -> Optional[List[Dict[str, Any]]]:
    """
    Fetch kline data via mootdx (TCP). Returns list of kline dicts,
    or None on failure so caller can fallback to HTTP API.
    """
    t0 = time.time()
    try:
        client = _get_client()
        prefix = _market_prefix(code)

        # mootdx frequency mapping
        freq_map = {
            "1m": 8,
            "5m": 0,
            "15m": 1,
            "30m": 2,
            "60m": 3,
            "120m": 4,
            "daily": 9,
            "week": 5,
            "month": 6,
            "quarter": 10,
            "year": 11,
        }
        frequency = freq_map.get(period, 9)

        df = client.bars(symbol=code, frequency=frequency)
        if df is None or df.empty:
            return None

        # Normalize start/end to YYYY-MM-DD for string comparison
        norm_start = f"{start[:4]}-{start[4:6]}-{start[6:8]}" if start and len(start) == 8 else start
        norm_end = f"{end[:4]}-{end[4:6]}-{end[6:8]}" if end and len(end) == 8 else end

        # Build raw rows in chronological order so we can derive pre_close
        # and change metrics from the previous bar's close.
        raw_rows = []
        for _, row in df.iterrows():
            dt_val = row.get("datetime", "")
            if hasattr(dt_val, "strftime"):
                date_str = dt_val.strftime("%Y-%m-%d")
            else:
                date_str = str(dt_val)[:10] if dt_val else ""

            open_p = float(row["open"]) if pd_notna(row.get("open")) else None
            close_p = float(row["close"]) if pd_notna(row.get("close")) else None
            high_p = float(row["high"]) if pd_notna(row.get("high")) else None
            low_p = float(row["low"]) if pd_notna(row.get("low")) else None
            # bars() has both 'vol' and 'volume'; use 'volume' if present
            volume = float(row["volume"]) if pd_notna(row.get("volume")) else None
            if volume is None:
                volume = float(row["vol"]) if pd_notna(row.get("vol")) else None
            turnover = float(row["amount"]) if pd_notna(row.get("amount")) else None

            raw_rows.append({
                "date": date_str,
                "open": open_p,
                "high": high_p,
                "low": low_p,
                "close": close_p,
                "volume": volume,
                "turnover": turnover,
            })

        raw_rows.sort(key=lambda r: r["date"])

        klines = []
        prev_close = None
        for r in raw_rows:
            date_str = r["date"]
            if norm_start and date_str < norm_start:
                prev_close = r["close"]
                continue
            if norm_end and date_str > norm_end:
                continue

            open_p = r["open"]
            close_p = r["close"]
            high_p = r["high"]
            low_p = r["low"]
            volume = r["volume"]
            turnover = r["turnover"]
            pre_close = prev_close
            change_pct = None
            change_amount = None
            amplitude = None

            if close_p is not None and pre_close is not None and pre_close != 0:
                change_pct = round((close_p - pre_close) / pre_close * 100, 4)
                change_amount = round(close_p - pre_close, 4)
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
                "pre_close": pre_close,
            })

            prev_close = close_p

        if limit > 0:
            klines = klines[-limit:]

        latency = round((time.time() - t0) * 1000, 1)
        for k in klines:
            k["_source"] = f"mootdx ({latency}ms)"
        return klines
    except Exception:
        logger.warning("mootdx get_kline failed", exc_info=True)
        return None


# ─── F10 / Company Overview ───────────────────────────────────

def get_f10_overview(code: str, market: int = 1, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
    """
    Fetch F10 company overview via mootdx (TCP).
    Returns dict with industry, region, and other basic info.
    """
    try:
        client = _get_client()
        f10 = client.F10(code)
        if not f10:
            return None

        industry = ""
        industry_chain = ""
        region = ""

        def _extract_field(text: str, label: str) -> str:
            for line in text.replace("\r", "").split("\n"):
                line = line.strip()
                if label in line and "｜" in line:
                    parts = [p.strip() for p in line.split("｜") if p.strip()]
                    for i, p in enumerate(parts):
                        if label in p and i + 1 < len(parts):
                            return parts[i + 1]
            return ""

        company_overview = f10.get("公司概况", "")
        if company_overview:
            val = _extract_field(company_overview, "行业类别")
            if val:
                industry_chain = val
                industry = val.split("-")[-1].strip()
            val = _extract_field(company_overview, "注册地址")
            if val:
                region = val
            if not region:
                val = _extract_field(company_overview, "办公地址")
                if val:
                    region = val

        return {
            "code": code,
            "industry": industry,
            "industry_chain": industry_chain,
            "region": region,
            "_source": "mootdx_f10",
        }
    except Exception:
        logger.warning("mootdx get_f10_overview failed", exc_info=True)
        return None


# ─── Financial Snapshot ───────────────────────────────────────

def get_finance_snapshot(code: str, market: int = 1, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
    """
    Fetch financial snapshot via mootdx (TCP).
    Returns key financial metrics (ROE, EPS, revenue, profit, etc.).
    """
    try:
        client = _get_client()
        prefix = _market_prefix(code)
        df = client.finance(prefix)
        if df is None or df.empty:
            return None

        row = df.iloc[0]
        # mootdx finance column names are Chinese pinyin
        net_profit = float(row["jinglirun"]) if pd_notna(row.get("jinglirun")) else None
        equity_val = float(row["jingzichan"]) if pd_notna(row.get("jingzichan")) else None
        total_assets = float(row["zongzichan"]) if pd_notna(row.get("zongzichan")) else None
        total_liab = float(row["liudongfuzhai"]) if pd_notna(row.get("liudongfuzhai")) else None
        long_liab = float(row["changqifuzhai"]) if pd_notna(row.get("changqifuzhai")) else None
        if total_liab is not None and long_liab is not None:
            total_liabilities = total_liab + long_liab
        else:
            total_liabilities = total_liab
        revenue = float(row["zhuyingshouru"]) if pd_notna(row.get("zhuyingshouru")) else None
        bps = float(row["meigujingzichan"]) if pd_notna(row.get("meigujingzichan")) else None
        # ROE = net_profit / equity
        roe = None
        if net_profit is not None and equity_val is not None and equity_val != 0:
            roe = round(net_profit / equity_val * 100, 2)
        # EPS = net_profit / total_shares
        total_shares = float(row["zongguben"]) if pd_notna(row.get("zongguben")) else None
        eps = None
        if net_profit is not None and total_shares is not None and total_shares != 0:
            eps = round(net_profit / total_shares, 4)
        # Report date from updated_date (YYYYMMDD)
        updated = row.get("updated_date")
        report_date = None
        if updated is not None:
            s = str(int(updated)) if hasattr(updated, "__int__") else str(updated)
            if len(s) == 8:
                report_date = f"{s[:4]}-{s[4:6]}-{s[6:8]}"

        return {
            "code": code,
            "report_date": report_date,
            "roe": roe,
            "eps": eps,
            "bps": bps,
            "revenue": revenue,
            "net_profit": net_profit,
            "total_assets": total_assets,
            "total_liabilities": total_liabilities,
            "equity": equity_val,
            "_source": "mootdx_finance",
        }
    except Exception:
        logger.warning("mootdx get_finance_snapshot failed", exc_info=True)
        return None


# ─── Utility ──────────────────────────────────────────────────

def pd_notna(val) -> bool:
    """Check if a pandas value is not NA, without importing pandas."""
    if val is None:
        return False
    try:
        import pandas as pd
        return pd.notna(val)
    except ImportError:
        return True


# ─── CLI ──────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except ValueError:
        pass
    import argparse

    parser = argparse.ArgumentParser(description="mootdx data fetcher (TCP direct)")
    parser.add_argument("code", help="6-digit stock code")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1])
    parser.add_argument("--type", choices=["quote", "kline", "f10", "finance"], default="quote")
    parser.add_argument("--period", default="daily")
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    result = None
    if args.type == "quote":
        result = get_quote(args.code, args.market)
    elif args.type == "kline":
        result = get_kline(args.code, args.market, args.period, start=args.start, end=args.end, limit=args.limit)
    elif args.type == "f10":
        result = get_f10_overview(args.code, args.market)
    elif args.type == "finance":
        result = get_finance_snapshot(args.code, args.market)

    if result is None:
        print(json.dumps({"error": "mootdx fetch failed"}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
