#!/usr/bin/env python3
"""Test truncation-only mode (auto_tune disabled)."""
import sys
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening

# auto_tune=false: should just truncate 287 -> 20 by score
cfg = {
    "scope": "all",
    "target_count": 20,
    "auto_tune": False,
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
                "volume_ratio": 1.5,
            },
        }
    ],
}

print("=" * 60)
print("Test 3: Truncation-only mode (auto_tune=false)")
print("=" * 60)

result = run_screening(cfg)

print("\n" + "=" * 60)
print(f"FINAL RESULT: {result['matched']} matches")
if "perf" in result:
    p = result["perf"]
    print(f"Performance: total={p['total_sec']:.2f}s")
