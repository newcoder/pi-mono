import argparse
import json
import sys
import io

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


def main():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    parser = argparse.ArgumentParser(description="Fetch real-time A-share index quotes")
    parser.add_argument("--codes", help="Comma-separated index codes, e.g. 000001,399001")
    args = parser.parse_args()

    quotes = get_index_quotes_spot()

    if args.codes:
        target_codes = set(args.codes.split(","))
        quotes = [q for q in quotes if q["code"] in target_codes]

    print(json.dumps(quotes, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
