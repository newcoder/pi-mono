#!/usr/bin/env python3
"""Test auto-tune functionality for Bollinger squeeze screening."""
import sys
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening

# Config targeting ~20 stocks with auto-tune
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
                "volume_ratio": 1.5,
            },
        }
    ],
}

print("=" * 60)
print("Testing auto-tune: target_count=20, Bollinger squeeze")
print("=" * 60)

result = run_screening(cfg)

print("\n" + "=" * 60)
print(f"FINAL RESULT: {result['matched']} matches")
print(f"Total checked: {result['total_checked']}")
if "perf" in result:
    p = result["perf"]
    print(f"Performance: load={p['data_load_sec']:.2f}s, "
          f"compute={p['compute_sec']:.2f}s, "
          f"filter={p['filter_sec']:.2f}s, "
          f"total={p['total_sec']:.2f}s")

if result["matched"] > 0:
    print("\n--- Top matches ---")
    for r in result["results"][:5]:
        signals = r["signals"]
        bb = signals.get("daily_bollinger_squeeze", {})
        print(f"  {r['code']} {r['name']}: {bb.get('detail', 'N/A')}")
    if result["matched"] > 5:
        print(f"  ... and {result['matched'] - 5} more")
