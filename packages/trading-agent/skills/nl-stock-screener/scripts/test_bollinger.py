#!/usr/bin/env python3
import sys, os, json
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening_fast

# 布林带收缩后放大 + 成交量放大
cfg = {
    "scope": "all",
    "conditions": [
        {
            "type": "technical",
            "indicator": "bollinger_squeeze",
            "periods": ["daily"],
            "params": {
                "bb_period": 20,
                "std_dev": 2.0,
                "squeeze_days": 5,
                "reference_days": 20,
                "squeeze_threshold": 0.85,
                "expansion_lookback": 2,
                "volume_period": 20,
                "volume_ratio": 1.5
            }
        }
    ]
}

print("=== Bollinger Squeeze + Volume Surge ===")
result = run_screening_fast(cfg)
print(f"\nMatched: {result['matched']} / {result['total_checked']}")
print(f"Performance: {json.dumps(result['perf'], indent=2)}")

if result['results']:
    print(f"\nFirst 10 matches:")
    for r in result['results'][:10]:
        signals = r.get('signals', {})
        bb_sig = signals.get('daily_bollinger_squeeze', {})
        print(f"  {r['code']} {r['name']} - {bb_sig.get('detail', '')}")
else:
    print("\nNo matches found")
