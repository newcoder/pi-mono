#!/usr/bin/env python3
"""Generate historical theme classifications for all Fridays since 2024."""
import sqlite3
import sys
import os

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS_DIR = os.path.dirname(_SCRIPT_DIR)
_SKILL_ROOT = os.path.dirname(_SCRIPTS_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

from analysis.classify_themes import run_classification
from local_data.db import get_db


def main():
    conn = get_db()

    fridays = conn.execute(
        "SELECT DISTINCT date FROM hot_stocks WHERE date >= '2024-01-01' "
        "AND CAST(strftime('%w', date) AS INTEGER) = 5 ORDER BY date"
    ).fetchall()
    fridays = [r[0] for r in fridays]

    print(f"Processing {len(fridays)} Fridays from {fridays[0]} to {fridays[-1]}...")

    success = 0
    skipped = 0
    for i, friday in enumerate(fridays):
        # Skip if already classified for this date
        existing = conn.execute(
            "SELECT COUNT(*) FROM theme_classification WHERE snapshot_date = ?", (friday,)
        ).fetchone()[0]
        if existing > 0:
            skipped += 1
            continue

        try:
            result = run_classification(conn, lookback_days=5, target_date=friday)
            success += 1
            if (i + 1) % 20 == 0:
                print(f"  [{i+1}/{len(fridays)}] {friday} — {result.get('primary',0)}p/{result.get('secondary',0)}s")
        except Exception as e:
            print(f"  [{i+1}/{len(fridays)}] {friday} ERROR: {e}")

    print(f"\nDone: {success} generated, {skipped} skipped, {len(fridays)} total")
    conn.close()


if __name__ == "__main__":
    main()
