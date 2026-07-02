#!/usr/bin/env python3
"""Benchmark get_stock_info components."""
import time
import sys
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_LOCAL_DATA_SCRIPTS = os.path.normpath(os.path.join(_SCRIPT_DIR, "..", "..", "local-data", "scripts"))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _LOCAL_DATA_SCRIPTS not in sys.path:
    sys.path.insert(0, _LOCAL_DATA_SCRIPTS)
from data_fetcher import (
    _get_stock_info_from_stock_data,
    _get_stock_info_from_jq_enrichment,
    _get_stock_info_from_akshare,
    get_stock_info,
)

code = '002352'

print("=== Component timing for get_stock_info ===")

start = time.time()
r1 = _get_stock_info_from_stock_data(code)
t1 = time.time() - start
print(f"1. stock_data quote: {t1:.2f}s")

start = time.time()
r2 = _get_stock_info_from_jq_enrichment(code)
t2 = time.time() - start
print(f"2. JQ enrichment: {t2:.2f}s")

start = time.time()
r3 = _get_stock_info_from_akshare(code)
t3 = time.time() - start
print(f"3. akshare fallback: {t3:.2f}s")

start = time.time()
r4 = get_stock_info(code)
t4 = time.time() - start
print(f"4. get_stock_info total: {t4:.2f}s")
print(f"   result keys: {list(r4.keys())}")

# Test akshare timeout behavior
print("\n=== Akshare with 3s timeout ===")
import threading
start = time.time()
ak_result = [None]
def _akshare_worker():
    ak_result[0] = _get_stock_info_from_akshare(code)
t = threading.Thread(target=_akshare_worker, daemon=True)
t.start()
t.join(timeout=3.0)
elapsed = time.time() - start
print(f"daemon thread join(3s): {elapsed:.2f}s, alive={t.is_alive()}, result={ak_result[0] is not None}")
