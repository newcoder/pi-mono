#!/usr/bin/env python3
"""Fetch real-time quotes for major A-share indices.

Direct Sina HTTP API (hq.sinajs.cn); akshare was removed as a data source.
"""
import io
import json
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import requests

# Major indices we care about
INDEX_CODES = {
    "sh000001": "上证指数",
    "sz399001": "深证成指",
    "sz399006": "创业板指",
}


def _to_float(val):
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def fetch_index_quotes() -> list[dict]:
    """Fetch index quotes directly from Sina HTTP API.

    Response format per index (verified against Tencent):
      var hq_str_sh000001="上证指数,今开,昨收,当前,最高,最低,..."
      fields[0]=name fields[1]=open fields[2]=prev_close fields[3]=current ...
    """
    url = "https://hq.sinajs.cn/list=" + ",".join(INDEX_CODES.keys())
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://finance.sina.com.cn",
    }
    r = requests.get(url, headers=headers, timeout=15)
    r.raise_for_status()
    r.encoding = "gbk"
    text = r.text

    results = []
    for line in text.split(";"):
        line = line.strip()
        if not line.startswith("var hq_str_"):
            continue
        m = re.match(r'var hq_str_(sh|sz)(\d{6})="(.*?)";?', line)
        if not m:
            continue
        prefix, code, data = m.groups()
        symbol = prefix + code
        fields = data.split(",")
        if len(fields) < 4:
            continue
        name = INDEX_CODES.get(symbol) or fields[0]
        price = _to_float(fields[3])
        prev_close = _to_float(fields[2])
        change_pct = None
        if price is not None and prev_close:
            change_pct = (price - prev_close) / prev_close * 100

        results.append({
            "code": code,
            "name": name,
            "price": round(price, 2) if price is not None else None,
            "change_pct": round(change_pct, 2) if change_pct is not None else None,
        })
    return results


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Fetch major A-share index quotes")
    parser.parse_args()

    quotes = fetch_index_quotes()
    print(json.dumps(quotes, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
