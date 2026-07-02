#!/usr/bin/env python3
"""Benchmark data_fetcher performance for 002352."""
import time
import sys
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_LOCAL_DATA_SCRIPTS = os.path.normpath(os.path.join(_SCRIPT_DIR, "..", "..", "local-data", "scripts"))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _LOCAL_DATA_SCRIPTS not in sys.path:
    sys.path.insert(0, _LOCAL_DATA_SCRIPTS)
from data_fetcher import fetch_stock_data, _fetch_group, _ensure_auth

code = '002352'

# Warm-up / pre-auth
print("Pre-authenticating JoinQuant...")
_ensure_auth()

print("\n=== Benchmark 1: fetch_stock_data(all, years=1) ===")
start = time.time()
data = fetch_stock_data(code, data_type='all', years=1, use_cache=False)
total = time.time() - start
print(f"Total time: {total:.2f}s")

print("\n=== Benchmark 2: Individual groups ===")
for name in ['basic', 'financial', 'valuation']:
    start = time.time()
    res = _fetch_group(name, code, years=1, data_type='all')
    elapsed = time.time() - start
    print(f"  {name}: {elapsed:.2f}s")

print("\n=== Benchmark 3: Holder group ( WARNING: may be slow ) ===")
start = time.time()
res = _fetch_group('holder', code, years=1)
elapsed = time.time() - start
print(f"  holder: {elapsed:.2f}s")

print("\n=== Data quality check ===")
print(f"basic_info keys: {list(data.get('basic_info', {}).keys())}")
print(f"financial_data keys: {list(data.get('financial_data', {}).keys())}")
print(f"valuation keys: {list(data.get('valuation', {}).keys())}")
print(f"price keys: {list(data.get('price', {}).keys())}")
