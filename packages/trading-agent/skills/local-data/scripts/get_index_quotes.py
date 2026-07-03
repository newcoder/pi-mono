import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import argparse
import json
import io
import re
import requests

def _to_float(val):
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def get_index_quotes_spot():
    """Fetch real-time index quotes from Sina via akshare."""
    import akshare as ak

    df = ak.stock_zh_index_spot_sina()
    if df is None or df.empty:
        raise RuntimeError("Sina index spot data empty")

    # Column mapping
    code_col = None
    for col in df.columns:
        if str(col) in ("代码", "code"):
            code_col = col
            break
    if code_col is None:
        code_col = df.columns[0]

    def get_col(candidates):
        for c in df.columns:
            if str(c) in candidates:
                return c
        return None

    name_col = get_col(["名称", "name"])
    latest_col = get_col(["最新价", "price", "latest"])
    change_pct_col = get_col(["涨跌幅", "change_pct"])

    def to_float(val):
        try:
            return float(val)
        except (ValueError, TypeError):
            return None

    results = []
    for _, row in df.iterrows():
        code = str(row[code_col]).strip() if code_col else ""
        # Remove sh/sz prefix for normalized code
        normalized = code[2:] if code.startswith(("sh", "sz")) else code
        results.append({
            "code": normalized,
            "name": str(row[name_col]) if name_col else None,
            "price": to_float(row[latest_col]) if latest_col else None,
            "change_pct": to_float(row[change_pct_col]) if change_pct_col else None,
            "_source": "sina_index_spot",
        })

    return results


def get_index_quotes_http(codes=None):
    """Fetch real-time index quotes directly from Sina HTTP API.
    Sina index codes: sh000001, sz399001, sz399006, sh000688, sh000300, sh000905
    """
    sina_code_map = {
        "000001": "sh000001",
        "399001": "sz399001",
        "399006": "sz399006",
        "000688": "sh000688",
        "000300": "sh000300",
        "000905": "sh000905",
    }
    if codes:
        requested = {c: sina_code_map.get(c) for c in codes if c in sina_code_map}
    else:
        requested = sina_code_map
    if not requested:
        return []

    url = "https://hq.sinajs.cn/list=" + ",".join(requested.values())
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://finance.sina.com.cn",
    }
    r = requests.get(url, headers=headers, timeout=15)
    r.encoding = "gbk"
    text = r.text

    results = []
    code_reverse_map = {v: k for k, v in sina_code_map.items()}
    for line in text.split(";"):
        line = line.strip()
        if not line.startswith("var hq_str_"):
            continue
        m = re.match(r'var hq_str_(sh|sz)(\d{6})="(.*?)";?', line)
        if not m:
            continue
        prefix, code, data = m.groups()
        fields = data.split(",")
        if len(fields) < 3:
            continue
        # Sina index format: name, current, prev_close, open, high, low, ...
        name = fields[0]
        price = _to_float(fields[1])
        prev_close = _to_float(fields[2])
        change_pct = None
        if price is not None and prev_close:
            change_pct = (price - prev_close) / prev_close * 100
        results.append({
            "code": code_reverse_map.get(prefix + code, code),
            "name": name,
            "price": price,
            "change_pct": change_pct,
            "_source": "sina_http",
        })
    return results


def main():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    parser = argparse.ArgumentParser(description="Fetch real-time A-share index quotes")
    parser.add_argument("--codes", help="Comma-separated index codes, e.g. 000001,399001")
    args = parser.parse_args()

    target_codes = args.codes.split(",") if args.codes else None

    # Try akshare spot first (returns fresher data).
    # Sina HTTP direct is faster but can return stale snapshots during market hours.
    try:
        quotes = get_index_quotes_spot()
    except Exception as e:
        print(f"akshare spot failed, falling back to Sina HTTP: {e}", file=sys.stderr)
        quotes = get_index_quotes_http(target_codes)

    if target_codes:
        target_set = set(target_codes)
        quotes = [q for q in quotes if q["code"] in target_set]

    print(json.dumps(quotes, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
