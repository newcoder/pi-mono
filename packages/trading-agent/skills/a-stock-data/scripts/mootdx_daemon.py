#!/usr/bin/env python3
"""
mootdx TCP 持久连接 daemon。

启动后初始化 mootdx client（一次性 ~700ms），然后通过 stdin/stdout JSONL 协议
持续响应请求。每个请求一行 JSON，每个响应一行 JSON。

协议：
  请求: {"id": 1, "command": "quote", "code": "688017", "market": 1}
  响应: {"id": 1, "success": true, "data": {...}}
  错误: {"id": 1, "success": false, "error": "..."}

支持的命令:
  - quote   --code CODE --market MARKET
  - klines  --code CODE --market MARKET --period daily --limit 100
  - finance --code CODE --market MARKET
  - f10     --code CODE --name NAME
  - ping    (健康检查，返回 {"pong": true})
  - quit    (优雅退出)

用法:
  python mootdx_daemon.py
"""
import io
import json
import sys
import time
import traceback
from typing import Any, Dict, Optional

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


# ─── Command handlers ─────────────────────────────────────────

def handle_quote(code: str, market: int = 1) -> Dict[str, Any]:
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
    }


def handle_klines(code: str, market: int = 1, period: str = "daily", limit: int = 100) -> list:
    t0 = time.time()
    client = _get_client()

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

    df = client.bars(symbol=code, frequency=category, offset=max(limit, 100))
    if df is None or len(df) == 0:
        raise RuntimeError("mootdx bars returned empty")

    # Determine time format based on period
    is_intraday = period in ("1m", "5m", "15m", "30m", "60m")

    klines = []
    prev_close = None
    for _, row in df.iterrows():
        dt_val = row.get("datetime", "")
        if hasattr(dt_val, "strftime"):
            if is_intraday:
                date_str = dt_val.strftime("%Y-%m-%d %H:%M:%S")
            else:
                date_str = dt_val.strftime("%Y-%m-%d")
        else:
            s = str(dt_val) if dt_val else ""
            if is_intraday and len(s) >= 16:
                # mootdx returns 'YYYY-MM-DD HH:MM' (no seconds), append :00
                date_str = s[:16] + ":00"
            elif len(s) >= 10:
                date_str = s[:10]  # YYYY-MM-DD
            else:
                date_str = s

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
            "adjust": "bfq",
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
    return klines


def handle_finance(code: str, market: int = 1) -> Dict[str, Any]:
    t0 = time.time()
    client = _get_client()
    df = client.finance(symbol=code)
    if df is None or len(df) == 0:
        raise RuntimeError("mootdx finance returned empty")

    row = df.iloc[0]
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
    }


def handle_f10(code: str, name: str = "公司概况") -> Dict[str, Any]:
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
    }


# ─── Router ───────────────────────────────────────────────────

COMMAND_HANDLERS = {
    "quote": handle_quote,
    "klines": handle_klines,
    "finance": handle_finance,
    "f10": handle_f10,
}


def process_request(req: Dict[str, Any]) -> Dict[str, Any]:
    """Process a single request and return response dict."""
    req_id = req.get("id", 0)
    command = req.get("command", "")

    if command == "ping":
        return {"id": req_id, "success": True, "data": {"pong": True, "client_init_ms": _client_init_ms}}

    if command == "quit":
        return {"id": req_id, "success": True, "data": {" quitting": True}}

    handler = COMMAND_HANDLERS.get(command)
    if handler is None:
        return {"id": req_id, "success": False, "error": f"Unknown command: {command}"}

    try:
        # Extract args from request
        code = req.get("code", "")
        market = req.get("market", 1)
        period = req.get("period", "daily")
        limit = req.get("limit", 100)
        name = req.get("name", "公司概况")

        if command == "quote":
            result = handler(code, market)
        elif command == "klines":
            result = handler(code, market, period, limit)
        elif command == "finance":
            result = handler(code, market)
        elif command == "f10":
            result = handler(code, name)
        else:
            result = handler(**req)

        return {"id": req_id, "success": True, "data": result}
    except Exception as e:
        return {"id": req_id, "success": False, "error": str(e), "traceback": traceback.format_exc()}


# ─── Main loop ────────────────────────────────────────────────

def main():
    # Ensure stdout is line-buffered for JSONL protocol
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    except (ValueError, AttributeError):
        pass

    # Pre-warm mootdx client on startup
    print(json.dumps({"event": "startup", "status": "initializing"}, ensure_ascii=False), flush=True)
    try:
        _get_client()
        print(json.dumps({
            "event": "ready",
            "status": "ok",
            "client_init_ms": _client_init_ms,
        }, ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({
            "event": "error",
            "status": "failed",
            "error": str(e),
        }, ensure_ascii=False), flush=True)
        sys.exit(1)

    # Main request loop
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"id": 0, "success": False, "error": f"Invalid JSON: {e}"}, ensure_ascii=False), flush=True)
            continue

        resp = process_request(req)
        print(json.dumps(resp, ensure_ascii=False, default=str), flush=True)

        if req.get("command") == "quit":
            break

    print(json.dumps({"event": "shutdown", "status": "ok"}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
