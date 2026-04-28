#!/usr/bin/env python3
"""Test auto-tune with loose initial params to force binary search."""
import sys
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening

# Start with very loose params (volume_ratio=1.0) to get many matches
# Target 20 should trigger binary search on volume_ratio
cfg = {
    "scope": "all",
    "target_count": 20,
    "auto_tune": True,
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
                "volume_ratio": 1.0,  # Very loose, should produce many matches
            },
        }
    ],
}

print("=" * 60)
print("Test 2: Auto-tune with loose initial params (volume_ratio=1.0)")
print("=" * 60)

result = run_screening(cfg)

print("\n" + "=" * 60)
print(f"FINAL RESULT: {result['matched']} matches")
if "perf" in result:
    p = result["perf"]
    print(f"Performance: total={p['total_sec']:.2f}s")

if result["matched"] > 0:
    print("\n--- Top matches ---")
    for r in result["results"][:5]:
        signals = r["signals"]
        bb = signals.get("daily_bollinger_squeeze", {})
        print(f"  {r['code']} {r['name']}: {bb.get('detail', 'N/A')}")
    if result["matched"] > 5:
        print(f"  ... and {result['matched'] - 5} more")
