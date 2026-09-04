"""Auto-extracted from daily_sync.py."""

import logging
from datetime import datetime

from local_data.db import get_db
from local_data.market import market_from_code

from . import base
from .base import _phase, _safe_float

logger = logging.getLogger('daily_sync')
# ── Phase 14: Sync Hot Stocks ────────────────────────────────────────────────

@_phase("hot_stocks")
def sync_hot_stocks() -> dict:
    """Sync Tonghuashun hot strong stocks snapshot via local hot_stocks_fetcher."""
    target_date = base.SYNC_DATE or datetime.now().strftime('%Y-%m-%d')
    now = datetime.now().isoformat()

    from hot_stocks_fetcher import fetch_hot_stocks

    try:
        data = fetch_hot_stocks(date=target_date)
    except Exception as e:
        raise RuntimeError(f"hot_stocks_fetcher failed: {e}")

    rows = data.get("rows", []) or data.get("data", [])
    if not rows:
        logger.info(f"No hot stocks returned for {target_date}.")
        return {"count": 0, "date": target_date}

    def _market_from_code(code: str) -> int:
        return market_from_code(code) or 0

    conn = get_db()
    try:
        cur = conn.cursor()
        inserted = 0
        for row in rows:
            code = str(row.get("code", "")).strip()
            if not code or not code.isdigit() or len(code) != 6:
                continue
            market = _market_from_code(code)
            cur.execute(
                """INSERT OR REPLACE INTO hot_stocks
                   (date, code, market, name, reason, price, change_pct, turnover_pct, amount,
                    pe_ttm, pb, mcap_yi, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    target_date,
                    code,
                    market,
                    row.get("name"),
                    row.get("reason"),
                    _safe_float(row.get("price")),
                    _safe_float(row.get("change_pct")),
                    _safe_float(row.get("turnover_pct")),
                    _safe_float(row.get("amount_wan")),
                    _safe_float(row.get("pe_ttm")),
                    _safe_float(row.get("pb")),
                    _safe_float(row.get("mcap_yi")),
                    now,
                ),
            )
            inserted += 1
        conn.commit()
        logger.info(f"Synced {inserted} hot stocks for {target_date}.")
        return {"count": inserted, "date": target_date}
    finally:
        conn.close()

# ── Phase 16: Sync Stock News ──────────────────────────────────────────────

@_phase("stock_news")
def sync_stock_news() -> dict:
    """Sync stock news via existing news_sync.py (batch mode)."""
    try:
        import news_sync
        conn = get_db()
        rows = conn.execute("SELECT code, name FROM stocks ORDER BY code").fetchall()
        conn.close()
        codes_names = [(r["code"], r["name"] or "") for r in rows]
        logger.info(f"Batch syncing news for {len(codes_names)} stocks...")
        result = news_sync.sync_batch(codes_names, limit_per_source=5)
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Stock news sync failed: {e}")

# ── Phase 17: Sync Market News ─────────────────────────────────────────────

@_phase("market_news")
def sync_market_news() -> dict:
    """Sync market-wide news via existing market_news_sync.py."""
    try:
        import market_news_sync
        result = market_news_sync.sync_market_news(limit=200)
        return {"detail": result}
    except Exception as e:
        raise RuntimeError(f"Market news sync failed: {e}")
