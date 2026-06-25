#!/usr/bin/env python3
"""
东方财富行业板块数据直接抓取（无需 akshare，仅依赖 urllib/json）。

支持：
  list   - 行业板块列表（实时行情快照）
  spot   - 单个板块实时行情
  klines - 历史日/周/月 K 线
  cons   - 板块成份股

用法示例：
  python get_industry_index_em.py list --limit 50
  python get_industry_index_em.py spot --symbol 半导体
  python get_industry_index_em.py klines --symbol BK1036 --start 20260101 --end 20260612
  python get_industry_index_em.py cons --symbol 半导体
"""
import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


# ─── Eastmoney API endpoints ────────────────────────────────────────────────

LIST_URL = "https://17.push2.eastmoney.com/api/qt/clist/get"
SPOT_URL_TEMPLATE = "https://{host}.push2.eastmoney.com/api/qt/stock/get"
KLINE_URL = "http://7.push2his.eastmoney.com/api/qt/stock/kline/get"
CONS_URL_TEMPLATE = "https://{host}.push2.eastmoney.com/api/qt/clist/get"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# 行业板块列表字段（与 akshare 对齐）
LIST_FIELDS = (
    "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,"
    "f23,f24,f25,f26,f22,f33,f11,f62,f128,f136,f115,f152,f124,f107,f104,f105,"
    "f140,f141,f207,f208,f209,f222"
)

# f-field -> 中文含义映射（列表页）
LIST_FIELD_MAP = {
    "f1": "_",
    "f2": "最新价",
    "f3": "涨跌幅",
    "f4": "涨跌额",
    "f5": "成交量",
    "f6": "成交额",
    "f7": "振幅",
    "f8": "换手率",
    "f9": "市盈率",
    "f10": "市净率",
    "f11": "_",
    "f12": "板块代码",
    "f13": "市场代码",
    "f14": "板块名称",
    "f15": "最高",
    "f16": "最低",
    "f17": "今开",
    "f18": "昨收",
    "f20": "总市值",
    "f21": "流通市值",
    "f22": "_",
    "f23": "_",
    "f24": "近一月涨跌幅",
    "f25": "近一年涨跌幅",
    "f26": "上市日期",
    "f33": "_",
    "f62": "主力净流入",
    "f104": "上涨家数",
    "f105": "下跌家数",
    "f107": "平盘家数",
    "f115": "_",
    "f124": "更新时间戳",
    "f128": "领涨股票",
    "f136": "领涨股票-涨跌幅",
    "f140": "领涨股票代码",
    "f141": "领涨股票市场",
    "f152": "_",
    "f207": "领跌股票",
    "f208": "领跌股票代码",
    "f209": "领跌股票市场",
    "f222": "领跌股票-涨跌幅",
}

# 单个板块实时行情字段
SPOT_FIELD_MAP = {
    "f43": "最新",
    "f44": "最高",
    "f45": "最低",
    "f46": "开盘",
    "f47": "成交量",
    "f48": "成交额",
    "f169": "涨跌额",
    "f170": "涨跌幅",
    "f171": "振幅",
    "f168": "换手率",
}

# K线字段
KLINE_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
KLINE_COLUMNS = [
    "日期", "开盘", "收盘", "最高", "最低",
    "成交量", "成交额", "振幅", "涨跌幅", "涨跌额", "换手率",
]

# 成份股字段
CONS_FIELDS = (
    "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,"
    "f23,f24,f25,f22,f11,f62,f128,f136,f115,f152,f45"
)

CONS_FIELD_MAP = {
    "f1": "_",
    "f2": "最新价",
    "f3": "涨跌幅",
    "f4": "涨跌额",
    "f5": "成交量",
    "f6": "成交额",
    "f7": "振幅",
    "f8": "换手率",
    "f9": "市盈率-动态",
    "f10": "_",
    "f11": "_",
    "f12": "代码",
    "f13": "市场代码",
    "f14": "名称",
    "f15": "最高",
    "f16": "最低",
    "f17": "今开",
    "f18": "昨收",
    "f20": "总市值",
    "f21": "流通市值",
    "f22": "_",
    "f23": "_",
    "f24": "近一月涨跌幅",
    "f25": "近一年涨跌幅",
    "f45": "_",
    "f62": "主力净流入",
    "f128": "_",
    "f136": "_",
    "f140": "_",
    "f141": "_",
    "f115": "_",
    "f152": "_",
}


# ─── HTTP helpers ───────────────────────────────────────────────────────────

def _http_get(url: str, params: Optional[Dict[str, Any]] = None, timeout: int = 20) -> Dict[str, Any]:
    """执行 GET 请求并解析 JSON，失败时抛出异常。"""
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _random_host() -> str:
    """生成 Eastmoney 常用的随机子域名数字前缀（如 91、17、29 等）。"""
    import random
    return str(random.randint(1, 99))


# ─── Board listing / code resolution ────────────────────────────────────────

def fetch_board_list(limit: int = 0) -> List[Dict[str, Any]]:
    """获取全部行业板块实时列表（带分页）。"""
    params = {
        "pn": "1",
        "pz": "100",
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": "m:90 t:2 f:!50",
        "fields": LIST_FIELDS,
    }
    first = _http_get(LIST_URL, params)
    if not first.get("data") or not first["data"].get("diff"):
        return []

    total = int(first["data"].get("total", 0))
    per_page = len(first["data"]["diff"])
    if per_page == 0:
        return []

    all_items = list(first["data"]["diff"])
    total_pages = (total + per_page - 1) // per_page

    for page in range(2, total_pages + 1):
        params["pn"] = str(page)
        try:
            data = _http_get(LIST_URL, params)
            diff = data.get("data", {}).get("diff", [])
            if not diff:
                break
            all_items.extend(diff)
            # 轻微降速，降低被风控概率
            time.sleep(0.15)
        except urllib.error.HTTPError as e:
            print(f"[warn] page {page} failed: {e}", file=sys.stderr)
            break

    results = []
    for raw in all_items:
        item = {LIST_FIELD_MAP.get(k, k): v for k, v in raw.items()}
        # 清理内部占位字段
        item = {k: v for k, v in item.items() if not k.startswith("_") and k != "-"}
        results.append(item)

    if limit > 0:
        results = results[:limit]
    return results


def resolve_board_code(symbol: str) -> str:
    """把板块名称解析为 BK 代码；如果已是 BK 代码则直接返回。"""
    if isinstance(symbol, str) and symbol.upper().startswith("BK"):
        return symbol.upper()
    boards = fetch_board_list()
    symbol_norm = symbol.strip()
    for b in boards:
        if b.get("板块名称") == symbol_norm:
            return b["板块代码"]
    raise ValueError(f"找不到行业板块: {symbol}")


# ─── Spot / Klines / Constituents ───────────────────────────────────────────

def fetch_spot(symbol: str) -> Dict[str, Any]:
    """获取单个行业板块实时行情。"""
    em_code = resolve_board_code(symbol)
    url = SPOT_URL_TEMPLATE.format(host=_random_host())
    params = {
        "fields": ",".join(SPOT_FIELD_MAP.keys()),
        "mpi": "1000",
        "invt": "2",
        "fltt": "1",
        "secid": f"90.{em_code}",
    }
    data = _http_get(url, params)
    raw = data.get("data", {})
    if not raw:
        raise RuntimeError(f"spot API returned empty for {symbol}")

    result = {}
    for k, name in SPOT_FIELD_MAP.items():
        val = raw.get(k)
        try:
            val = float(val)
        except (TypeError, ValueError):
            pass
        result[name] = val

    # 价格/涨跌幅类字段需要除以 100；成交量/成交额保持原单位
    price_like = {"最新", "最高", "最低", "开盘", "涨跌额", "涨跌幅", "振幅", "换手率"}
    for key in price_like:
        if key in result and isinstance(result[key], (int, float)):
            result[key] = round(result[key] / 100, 4)

    result["板块代码"] = em_code
    return result


def fetch_klines(
    symbol: str,
    start: str,
    end: str,
    period: str = "daily",
    adjust: str = "",
) -> List[Dict[str, Any]]:
    """获取行业板块历史 K 线。"""
    em_code = resolve_board_code(symbol)
    period_map = {"daily": "101", "week": "102", "month": "103"}
    adjust_map = {"": "0", "qfq": "1", "hfq": "2"}
    if period not in period_map:
        raise ValueError(f"period must be one of {list(period_map.keys())}")
    if adjust not in adjust_map:
        raise ValueError(f"adjust must be one of {list(adjust_map.keys())}")

    params = {
        "secid": f"90.{em_code}",
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": KLINE_FIELDS2,
        "klt": period_map[period],
        "fqt": adjust_map[adjust],
        "beg": start,
        "end": end,
        "smplmt": "10000",
        "lmt": "1000000",
    }
    data = _http_get(KLINE_URL, params)
    klines_raw = data.get("data", {}).get("klines", [])
    if not klines_raw:
        return []

    results = []
    for line in klines_raw:
        parts = line.split(",")
        if len(parts) != len(KLINE_COLUMNS):
            continue
        row = {"板块代码": em_code}
        for col, val in zip(KLINE_COLUMNS, parts):
            if col == "日期":
                row[col] = val
            else:
                try:
                    row[col] = float(val)
                except ValueError:
                    row[col] = None
        results.append(row)
    return results


def fetch_constituents(symbol: str, limit: int = 0) -> List[Dict[str, Any]]:
    """获取行业板块成份股。"""
    em_code = resolve_board_code(symbol)
    params = {
        "pn": "1",
        "pz": "100",
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": f"b:{em_code} f:!50",
        "fields": CONS_FIELDS,
    }
    first = _http_get(CONS_URL_TEMPLATE.format(host=_random_host()), params)
    if not first.get("data") or not first["data"].get("diff"):
        return []

    total = int(first["data"].get("total", 0))
    per_page = len(first["data"]["diff"])
    all_items = list(first["data"]["diff"])
    total_pages = (total + per_page - 1) // per_page if per_page > 0 else 1

    for page in range(2, total_pages + 1):
        params["pn"] = str(page)
        try:
            data = _http_get(CONS_URL_TEMPLATE.format(host=_random_host()), params)
            diff = data.get("data", {}).get("diff", [])
            if not diff:
                break
            all_items.extend(diff)
            time.sleep(0.15)
        except urllib.error.HTTPError as e:
            print(f"[warn] cons page {page} failed: {e}", file=sys.stderr)
            break

    results = []
    for raw in all_items:
        item = {CONS_FIELD_MAP.get(k, k): v for k, v in raw.items()}
        item = {k: v for k, v in item.items() if not k.startswith("_") and k != "-"}
        item["板块代码"] = em_code
        results.append(item)

    if limit > 0:
        results = results[:limit]
    return results


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except ValueError:
        pass

    parser = argparse.ArgumentParser(description="东方财富行业板块直接抓取")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="行业板块列表")
    p_list.add_argument("--limit", type=int, default=0, help="最多返回条数")

    p_spot = sub.add_parser("spot", help="单个板块实时行情")
    p_spot.add_argument("--symbol", required=True, help="板块名称或 BK 代码，如 半导体 / BK1036")

    p_klines = sub.add_parser("klines", help="历史 K 线")
    p_klines.add_argument("--symbol", required=True, help="板块名称或 BK 代码")
    p_klines.add_argument("--start", required=True, help="开始日期 YYYYMMDD")
    p_klines.add_argument("--end", required=True, help="结束日期 YYYYMMDD")
    p_klines.add_argument("--period", default="daily", choices=["daily", "week", "month"])
    p_klines.add_argument("--adjust", default="", choices=["", "qfq", "hfq"])

    p_cons = sub.add_parser("cons", help="板块成份股")
    p_cons.add_argument("--symbol", required=True, help="板块名称或 BK 代码")
    p_cons.add_argument("--limit", type=int, default=0, help="最多返回条数")

    args = parser.parse_args()

    try:
        if args.command == "list":
            result = fetch_board_list(limit=args.limit)
            output = {"count": len(result), "data": result}
        elif args.command == "spot":
            output = fetch_spot(args.symbol)
        elif args.command == "klines":
            result = fetch_klines(args.symbol, args.start, args.end, args.period, args.adjust)
            output = {"count": len(result), "data": result}
        elif args.command == "cons":
            result = fetch_constituents(args.symbol, limit=args.limit)
            output = {"count": len(result), "data": result}
        else:
            raise ValueError(f"Unknown command: {args.command}")
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

    print(json.dumps(output, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
