#!/usr/bin/env python3
"""Benchmark screening on REAL data in local DB."""
import json
import time
import sys
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening_fast

def benchmark(config, name):
    print(f"\n--- {name} ---")
    t0 = time.time()
    result = run_screening_fast(config)
    elapsed = time.time() - t0
    print(f"  Total: {elapsed:.2f}s (target: <5s)")
    print(f"  Data load: {result['perf']['data_load_sec']:.2f}s")
    print(f"  Compute: {result['perf']['compute_sec']:.2f}s")
    print(f"  Filter: {result['perf']['filter_sec']:.2f}s")
    print(f"  Matched: {result['matched']} / {result['total_checked']}")
    return result, elapsed

# Config 1: MA golden cross only
cfg1 = {
    "scope": "all",
    "conditions": [
        {"type": "technical", "indicator": "ma_cross", "periods": ["daily"], "params": {"fast": 5, "slow": 10, "cross_type": "golden"}}
    ]
}

# Config 2: RSI < 30
cfg2 = {
    "scope": "all",
    "conditions": [
        {"type": "technical", "indicator": "rsi", "periods": ["daily"], "params": {"period": 14, "operator": "<", "value": 30}}
    ]
}

# Config 3: MA golden cross + MACD golden cross + market cap > 10B
cfg3 = {
    "scope": "all",
    "conditions": [
        {"type": "technical", "indicator": "ma_cross", "periods": ["daily"], "params": {"fast": 5, "slow": 10, "cross_type": "golden"}},
        {"type": "technical", "indicator": "macd_cross", "periods": ["daily"], "params": {"cross_type": "golden"}},
        {"type": "fundamental", "field": "market_cap", "operator": ">", "value": 10},
    ]
}

# Config 4: MA golden cross on both daily and weekly
cfg4 = {
    "scope": "all",
    "conditions": [
        {"type": "technical", "indicator": "ma_cross", "periods": ["daily", "weekly"], "params": {"fast": 5, "slow": 10, "cross_type": "golden"}},
    ]
}

benchmark(cfg1, "MA5/MA10 daily golden cross")
benchmark(cfg2, "RSI14 < 30")
benchmark(cfg3, "MA golden + MACD golden + market cap > 10B")
benchmark(cfg4, "MA golden cross on daily AND weekly")

print("\n=== All benchmarks complete ===")
