#!/usr/bin/env python3
"""Detailed benchmark with timing logs."""
import time
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from data_fetcher import _fetch_group, _ensure_auth
from concurrent.futures import ThreadPoolExecutor, as_completed

code = '002352'
years = 1

groups = ['basic', 'financial', 'valuation']
_ensure_auth()

print("=== Parallel fetch with detailed timing ===")
start_total = time.time()

with ThreadPoolExecutor(max_workers=4) as executor:
    future_map = {executor.submit(_fetch_group, g, code, years, 'all'): g for g in groups}
    for future in as_completed(future_map):
        g = future_map[future]
        elapsed = time.time() - start_total
        try:
            res = future.result()
            print(f"[{elapsed:.2f}s] {g} completed")
        except Exception as e:
            print(f"[{elapsed:.2f}s] {g} error: {e}")

print(f"Total: {time.time() - start_total:.2f}s")

print("\n=== Sequential fetch with detailed timing ===")
for g in groups:
    start = time.time()
    res = _fetch_group(g, code, years)
    print(f"{g}: {time.time() - start:.2f}s")
