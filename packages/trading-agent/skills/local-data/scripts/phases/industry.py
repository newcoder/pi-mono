"""Auto-extracted from daily_sync.py."""

import logging

from local_data.db import get_db

from .base import _phase

logger = logging.getLogger('daily_sync')

# ── Phase 8: Sync Industries ───────────────────────────────────────────────

@_phase("industries")
def sync_industries() -> dict:
    """Sync industry classifications via existing sync_industries.py."""
    try:
        import sync_industries
        result = sync_industries.sync_all_standards()
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Industry sync failed: {e}")

# ── Phase 9: Sync Industry Klines ───────────────────────────────────────────

@_phase("industry_klines")
def sync_industry_klines_ths_phase() -> dict:
    """Sync THS industry index klines and quotes."""
    try:
        import sync_industry_klines_ths
        result = sync_industry_klines_ths.sync_industry_klines_ths()
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Industry klines sync failed: {e}")

# ── Phase 10: Sync Benchmark Index Klines ─────────────────────────────────────

@_phase("index_klines")
def sync_index_klines() -> dict:
    """Sync benchmark index daily klines (沪深300/中证500) for concept independence filter."""
    try:
        import sync_index_klines
        result = sync_index_klines.sync_index_klines(get_db())
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Index klines sync failed: {e}")
