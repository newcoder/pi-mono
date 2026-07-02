#!/usr/bin/env python3
"""Fetch real-time quotes for major A-share indices."""

import argparse
import json
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# Major indices we care about
INDEX_CODES = {
    "sh000001": "上证指数",
    "sz399001": "深证成指",
    "sz399006": "创业板指",
}


def fetch_index_quotes() -> list[dict]:
    """Fetch index quotes using akshare Sina source."""
    import akshare as ak

    df = ak.stock_zh_index_spot_sina()
    if df is None or df.empty:
        return []

    # Map column names (akshare returns Chinese column names)
    # Typical columns: 代码, 名称, 最新价, 涨跌额, 涨跌幅, 昨收, 今开, 最高, 最低, 成交量, 成交额
    code_col = None
    name_col = None
    price_col = None
    change_pct_col = None

    for col in df.columns:
        col_str = str(col)
        if col_str in ("代码", "code"):
            code_col = col
        elif col_str in ("名称", "name"):
            name_col = col
        elif col_str in ("最新价", "price", "latest"):
            price_col = col
        elif col_str in ("涨跌幅", "change_pct"):
            change_pct_col = col

    # Fallback: use positional columns if name matching fails
    if code_col is None:
        code_col = df.columns[0]
    if name_col is None:
        name_col = df.columns[1]
    if price_col is None:
        price_col = df.columns[2]
    if change_pct_col is None:
        # Try to find a column that looks like change percentage
        for col in df.columns:
            sample = str(df[col].iloc[0]) if len(df) > 0 else ""
            if "%" in sample or (sample.replace(".", "").replace("-", "").isdigit() and -20 < float(sample) < 20):
                change_pct_col = col
                break
        if change_pct_col is None:
            change_pct_col = df.columns[4] if len(df.columns) > 4 else df.columns[-1]

    results = []
    for _, row in df.iterrows():
        code = str(row[code_col]).strip().lower()
        if code in INDEX_CODES:
            name = INDEX_CODES.get(code, str(row[name_col]))
            try:
                price = float(row[price_col])
            except (ValueError, TypeError):
                price = 0.0
            try:
                change = float(row[change_pct_col])
            except (ValueError, TypeError):
                change = 0.0

            results.append({
                "code": code.replace("sh", "").replace("sz", ""),
                "name": name,
                "price": round(price, 2),
                "change_pct": round(change, 2),
            })

    return results


def main():
    parser = argparse.ArgumentParser(description="Fetch major A-share index quotes")
    args = parser.parse_args()

    quotes = fetch_index_quotes()
    print(json.dumps(quotes, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
