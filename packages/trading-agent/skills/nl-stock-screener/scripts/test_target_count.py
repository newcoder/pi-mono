#!/usr/bin/env python3
import sys, os, json
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from screen import run_screening_fast

# 布林带收缩后放大 + 成交量放大, target_count=20
cfg = {
    "scope": "all",
    "target_count": 20,
    "conditions": [
        {
            "type": "technical",
            "indicator": "bollinger_squeeze",
            "periods": ["daily"],
            "params": {
                "bb_period": 20, "std_dev": 2.0,
                "squeeze_days": 5, "reference_days": 20,
                "squeeze_threshold": 0.85,
                "expansion_lookback": 2,
                "volume_period": 20, "volume_ratio": 1.5
            }
        }
    ]
}

print("=== Bollinger Squeeze + target_count=20 ===")
result = run_screening_fast(cfg)
print(f"\nMatched: {result['matched']} / {result['total_checked']}")
print(f"Performance: {json.dumps(result['perf'], indent=2)}")

if result['results']:
    print(f"\nTop {len(result['results'])} matches:")
    for i, r in enumerate(result['results'][:20], 1):
        signals = r.get('signals', {})
        bb = signals.get('daily_bollinger_squeeze', {})
        raw = bb.get('raw', {})
        print(f"  {i}. {r['code']} {r['name']} - bw={raw.get('bandwidth', 'N/A'):.4f} squeeze={raw.get('squeeze')} expansion={raw.get('expansion')} vol={raw.get('volume_surge')}")
