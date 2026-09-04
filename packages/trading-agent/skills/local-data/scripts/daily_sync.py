#!/usr/bin/env python3
"""
A-Share Analysis 全市场数据每日定时同步脚本
===============================================
同步内容: stocks, quotes, klines, fundamentals, industries, concepts, stock_news, market_news
运行建议: 每天 01:20 (A股收盘后数据稳定时段)
用法:     python daily_sync.py [--validate-only] [--phase PHASE]

依赖:     akshare, pandas, requests, beautifulsoup4, mootdx
"""

import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import argparse
import io
import json
import logging
import warnings
from datetime import datetime
from typing import List, Optional

from local_data.db import get_db, get_db_path
from local_data.schema import ensure_tables
from scripts.phases import ALL_PHASES
from scripts.phases.base import _LOG_DIR, _sync_results
from scripts.phases.validation import run_validation

warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# Avoid unstable local HTTP proxies breaking akshare/requests fallbacks.
for _proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(_proxy_key, None)

# ── Paths ──────────────────────────────────────────────────────────────────
_TODAY = datetime.now().strftime('%Y%m%d')
_LOG_FILE = os.path.join(_LOG_DIR, f"sync_{_TODAY}.log")
os.makedirs(os.path.dirname(get_db_path()), exist_ok=True)
os.makedirs(_LOG_DIR, exist_ok=True)

# ── Logging setup ──────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(_LOG_FILE, encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger('daily_sync')


# ── Main ───────────────────────────────────────────────────────────────────

def run_all_phases(phases: Optional[List[str]] = None):
    """Run all or selected sync phases."""
    import scripts.phases.base as phases_base

    phases_base.reset_sync_results()
    ensure_tables()

    for name, func in ALL_PHASES:
        if phases and name not in phases:
            logger.info(f"Skipping phase: {name}")
            continue
        func()

    # Flag phases with a high skip ratio — a pattern of silent skips (e.g. all
    # stocks skipping company-type lookup) usually means a data-source or code
    # regression, not normal per-stock failures.
    for name, res in _sync_results["phases"].items():
        detail = res.get("detail") if isinstance(res.get("detail"), dict) else {}
        synced = detail.get("synced") or 0
        skipped = detail.get("skipped") or 0
        failed = detail.get("failed") or 0
        total = synced + skipped + failed
        if total > 0 and skipped / total > 0.2:
            msg = (
                f"Phase '{name}': {skipped}/{total} items skipped "
                f"({skipped / total * 100:.0f}%) — check data source or sync logic"
            )
            _sync_results["warnings"].append({"phase": name, "message": msg})
            logger.warning(msg)

    # Final summary
    _sync_results["end_time"] = datetime.now().isoformat()
    total_elapsed = (
        datetime.fromisoformat(_sync_results["end_time"])
        - datetime.fromisoformat(_sync_results["start_time"])
    ).total_seconds()
    _sync_results["total_elapsed_seconds"] = round(total_elapsed, 2)

    logger.info(f"\n{'='*60}")
    logger.info("SYNC COMPLETE")
    logger.info(f"{'='*60}")
    logger.info(f"Total time: {total_elapsed/60:.1f} minutes")
    logger.info(f"Phases run: {len(_sync_results['phases'])}")
    logger.info(f"Errors: {len(_sync_results['errors'])}")
    if _sync_results["errors"]:
        logger.info("Error details:")
        for e in _sync_results["errors"]:
            logger.info(f"  [{e['phase']}] {e['error']}")

    # Save summary JSON
    summary_path = os.path.join(_LOG_DIR, f"sync_summary_{_TODAY}.json")
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(_sync_results, f, ensure_ascii=False, indent=2, default=str)
    logger.info(f"Summary saved to: {summary_path}")

    # Exit code: 0 if no critical errors, 1 otherwise
    has_critical = any(e["phase"] == "validation" for e in _sync_results["errors"])
    if has_critical:
        logger.error("Exiting with code 1 due to validation failures.")
        sys.exit(1)
    return _sync_results


def main():
    import scripts.phases.base as phases_base

    parser = argparse.ArgumentParser(description="A-Share Analysis Daily Data Sync")
    parser.add_argument("--phase", action="append", help="Run specific phase(s)")
    parser.add_argument("--validate-only", action="store_true", help="Only run validation")
    parser.add_argument("--skip-fundamentals", action="store_true", help="Skip fundamentals (slow)")
    parser.add_argument("--date", help="Historical date for hot_stocks phase (YYYY-MM-DD)")
    args = parser.parse_args()

    if args.date:
        phases_base.SYNC_DATE = args.date

    if args.validate_only:
        ensure_tables()
        run_validation()
        return

    phases = None
    if args.phase:
        # Support both --phase stocks --phase quotes and --phase stocks,quotes,klines
        phases = []
        for p in args.phase:
            phases.extend([s.strip() for s in p.split(",") if s.strip()])
    if args.skip_fundamentals and not phases:
        phases = [name for name, _ in ALL_PHASES if name != "fundamentals"]

    run_all_phases(phases)


if __name__ == "__main__":
    main()
