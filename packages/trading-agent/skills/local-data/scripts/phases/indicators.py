"""Auto-extracted from daily_sync.py."""

import logging

from local_data.db import get_db

from .base import _phase

logger = logging.getLogger('daily_sync')

# ── Phase 5: Sync Indicators ───────────────────────────────────────────────

@_phase("indicators")
def sync_indicators() -> dict:
    """Calculate fundamental indicators from fundamentals table."""
    try:
        import calc_fundamental_indicators
        result = calc_fundamental_indicators.calc_all(get_db())
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Indicators calculation failed: {e}")

# ── Phase 6: Sync Industry Momentum ──────────────────────────────────────────

@_phase("industry_momentum")
def sync_industry_momentum() -> dict:
    """Calculate industry momentum factor and IC from industry_klines."""
    try:
        import calc_industry_momentum
        result = calc_industry_momentum.calc_all(get_db(), periods=[20], forwards=[5])
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Industry momentum calculation failed: {e}")

# ── Phase 7: Sync Size IC ──────────────────────────────────────────────────

@_phase("size_ic")
def sync_size_ic() -> dict:
    """Calculate size (market cap) factor IC from klines and fundamentals."""
    try:
        import calc_size_ic
        result = calc_size_ic.calc_all(get_db(), forwards=[5, 10, 20])
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Size IC calculation failed: {e}")
