#!/usr/bin/env python3
import sys, os, json
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening_fast

# Daily + Weekly MA golden cross
cfg = {
    "scope": "all",
    "conditions": [
        {"type": "technical", "indicator": "ma_cross", "periods": ["daily", "weekly"], "params": {"fast": 5, "slow": 10, "cross_type": "golden"}},
    ]
}

print("=== Daily + Weekly MA5/MA10 Golden Cross ===")
result = run_screening_fast(cfg)
print(f"\nMatched: {result['matched']} / {result['total_checked']}")
print(f"Performance: {json.dumps(result['perf'], indent=2)}")

if result['results']:
    print(f"\nFirst 10 matches:")
    for r in result['results'][:10]:
        print(f"  {r['code']} {r['name']}")
