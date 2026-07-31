"""Shared infrastructure for daily sync phases."""

import logging
import os
import time
import traceback
from datetime import datetime
from typing import Callable, Dict, Optional

logger = logging.getLogger('daily_sync')

# Paths used by validation / data-quality phases
_SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LOG_DIR = os.path.expanduser("~/.trading-agent/logs")
_TODAY = datetime.now().strftime('%Y%m%d')

# Date used for historical-aware phases like hot_stocks; set via --date
SYNC_DATE: Optional[str] = None

# Result tracking
_sync_results: Dict = {
    "start_time": datetime.now().isoformat(),
    "phases": {},
    "errors": [],
    "warnings": [],
}


def _safe_float(v):
    if v is None or v == "" or v == "-":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _phase(name: str):
    """Decorator to wrap a sync phase with timing and error handling."""
    def decorator(func: Callable):
        def wrapper(*args, **kwargs):
            logger.info(f"\n{'='*60}")
            logger.info(f"PHASE: {name}")
            logger.info(f"{'='*60}")
            start = time.time()
            result = {"status": "success", "detail": {}}
            try:
                detail = func(*args, **kwargs)
                if detail:
                    result["detail"] = detail
            except Exception as e:
                result["status"] = "failed"
                result["error"] = str(e)
                result["traceback"] = traceback.format_exc()
                _sync_results["errors"].append({"phase": name, "error": str(e)})
                logger.error(f"Phase '{name}' failed: {e}")
                logger.debug(traceback.format_exc())
            finally:
                elapsed = time.time() - start
                result["elapsed_seconds"] = round(elapsed, 2)
                _sync_results["phases"][name] = result
                status_icon = "OK" if result["status"] == "success" else "FAIL"
                logger.info(f"Phase '{name}' {status_icon} in {elapsed:.1f}s")
            return result
        return wrapper
    return decorator


def get_sync_results() -> Dict:
    """Return the shared sync results dict."""
    return _sync_results


def reset_sync_results() -> None:
    """Reset sync results (useful for testing)."""
    _sync_results["start_time"] = datetime.now().isoformat()
    _sync_results["phases"] = {}
    _sync_results["errors"] = []
    _sync_results["warnings"] = []
