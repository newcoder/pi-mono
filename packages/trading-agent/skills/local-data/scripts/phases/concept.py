"""Auto-extracted from daily_sync.py."""

import logging

from local_data.db import get_db

from .base import _phase

logger = logging.getLogger('daily_sync')

# ── Phase 10: Sync Concepts ─────────────────────────────────────────────────

@_phase("concepts")
def sync_concepts() -> dict:
    """Sync concept stocks via Tonghuashun (avoids blocked Eastmoney HTTP APIs)."""
    try:
        import sync_concept_stocks_ths
        result = sync_concept_stocks_ths.sync_all_concepts()
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Concept sync failed: {e}")

# ── Phase 11: Build Concept Synthetic Klines ───────────────────────────────────

@_phase("concept_synthetic_klines")
def sync_concept_synthetic_klines() -> dict:
    """Build equal-weight qfq-adjusted synthetic klines for all concepts."""
    try:
        import calc_concept_synthetic_klines
        result = calc_concept_synthetic_klines.calc_all(get_db())
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Concept synthetic klines failed: {e}")


