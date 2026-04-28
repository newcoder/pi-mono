#!/usr/bin/env python3
"""Simple benchmark and validation script for data_fetcher."""

import json
import time
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from data_fetcher import (
    fetch_stock_data,
    get_stock_info,
    get_financial_data,
    get_financial_indicators,
    get_price_data,
    get_holder_data,
    get_valuation_data,
)

TEST_CODE = "600519"


def _check(result, key, msg):
    ok = key in result and (not isinstance(result[key], dict) or "error" not in result[key])
    status = "OK" if ok else "FAIL"
    print(f"  [{status}] {msg}")
    return ok


def test_basic_info():
    print("\n[Test] get_stock_info")
    t0 = time.time()
    info = get_stock_info(TEST_CODE)
    dt = time.time() - t0
    print(f"  time: {dt:.2f}s")
    ok = True
    ok &= _check(info, "latest_price", "latest_price present")
    ok &= _check(info, "name", "name present")
    print(f"  data: {json.dumps(info, ensure_ascii=False, indent=2)}")
    return ok


def test_price_data():
    print("\n[Test] get_price_data")
    t0 = time.time()
    price = get_price_data(TEST_CODE, days=60)
    dt = time.time() - t0
    print(f"  time: {dt:.2f}s")
    ok = True
    ok &= _check(price, "latest_price", "latest_price present")
    ok &= _check(price, "price_data", "price_data present")
    if price.get("price_data"):
        print(f"  kline count: {len(price['price_data'])}")
    return ok


def test_financial_data():
    print("\n[Test] get_financial_data")
    t0 = time.time()
    fin = get_financial_data(TEST_CODE, years=1)
    dt = time.time() - t0
    print(f"  time: {dt:.2f}s")
    ok = True
    ok &= _check(fin, "balance_sheet", "balance_sheet present")
    ok &= _check(fin, "income_statement", "income_statement present")
    ok &= _check(fin, "cash_flow", "cash_flow present")
    for k in ["balance_sheet", "income_statement", "cash_flow"]:
        v = fin.get(k, [])
        print(f"  {k} records: {len(v)}")
    return ok


def test_financial_indicators():
    print("\n[Test] get_financial_indicators")
    t0 = time.time()
    ind = get_financial_indicators(TEST_CODE)
    dt = time.time() - t0
    print(f"  time: {dt:.2f}s")
    ok = isinstance(ind, list) and len(ind) > 0
    print(f"  records: {len(ind)}")
    return ok


def test_valuation_data():
    print("\n[Test] get_valuation_data")
    t0 = time.time()
    val = get_valuation_data(TEST_CODE)
    dt = time.time() - t0
    print(f"  time: {dt:.2f}s")
    ok = True
    ok &= _check(val, "latest", "latest present")
    return ok


def test_holder_data():
    print("\n[Test] get_holder_data")
    t0 = time.time()
    holder = get_holder_data(TEST_CODE)
    dt = time.time() - t0
    print(f"  time: {dt:.2f}s")
    ok = True
    ok &= _check(holder, "top_10_holders", "top_10_holders present")
    return ok


def test_fetch_all():
    print("\n[Test] fetch_stock_data --data-type all")
    t0 = time.time()
    data = fetch_stock_data(TEST_CODE, data_type="all", years=1, use_cache=False)
    dt = time.time() - t0
    print(f"  time: {dt:.2f}s")
    ok = True
    ok &= _check(data, "basic_info", "basic_info present")
    ok &= _check(data, "financial_data", "financial_data present")
    ok &= _check(data, "financial_indicators", "financial_indicators present")
    ok &= _check(data, "valuation", "valuation present")
    ok &= _check(data, "price", "price present")
    # Check that financial_data has real data, not just empty lists
    fin = data.get("financial_data", {})
    if fin:
        for k in ["balance_sheet", "income_statement", "cash_flow"]:
            v = fin.get(k, [])
            print(f"  financial_data.{k} records: {len(v)}")
    return ok


if __name__ == "__main__":
    results = {
        "basic_info": test_basic_info(),
        "price_data": test_price_data(),
        "financial_data": test_financial_data(),
        "financial_indicators": test_financial_indicators(),
        "valuation_data": test_valuation_data(),
        "holder_data": test_holder_data(),
        "fetch_all": test_fetch_all(),
    }
    print("\n" + "=" * 40)
    for k, v in results.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
    all_ok = all(results.values())
    print("=" * 40)
    sys.exit(0 if all_ok else 1)
