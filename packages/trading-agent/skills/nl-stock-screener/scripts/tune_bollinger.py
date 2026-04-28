#!/usr/bin/env python3
"""Search for Bollinger squeeze params that yield ~20 matches."""
import sys, os
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening_fast

def test(vol_ratio, squeeze_thr, squeeze_days=5):
    cfg = {
        "scope": "all",
        "conditions": [
            {
                "type": "technical",
                "indicator": "bollinger_squeeze",
                "periods": ["daily"],
                "params": {
                    "bb_period": 20, "std_dev": 2.0,
                    "squeeze_days": squeeze_days,
                    "reference_days": 20,
                    "squeeze_threshold": squeeze_thr,
                    "expansion_lookback": 2,
                    "volume_period": 20,
                    "volume_ratio": vol_ratio
                }
            }
        ]
    }
    result = run_screening_fast(cfg)
    return result['matched']

print("Searching params...")
for vol in [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]:
    for thr in [0.85, 0.80, 0.75, 0.70, 0.65, 0.60]:
        n = test(vol, thr)
        print(f"  vol={vol:4.1f} thr={thr:.2f} -> {n:4d} matches")
        if 10 <= n <= 30:
            print(f"    *** CLOSE TO TARGET ***")

print("\nDone.")
