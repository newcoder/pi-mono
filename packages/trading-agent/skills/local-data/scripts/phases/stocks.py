"""Phase 1: Sync full stock list."""

import logging
from datetime import datetime

from local_data.db import get_db
from local_data.market import is_a_share, market_from_code

from .base import _phase

logger = logging.getLogger('daily_sync')


def _is_valid_stock_name(name: str) -> bool:
    """Exclude delisted and ST/*ST names. Keep suspended stocks (their names may appear garbled in mootdx)."""
    if not name or not name.strip():
        return False
    # Skip delisted stocks
    if "退市" in name or name.endswith("退"):
        return False
    # Skip ST/*ST (risk warning boards)
    if name.startswith("ST") or name.startswith("*ST"):
        return False
    return True


@_phase("stocks")
def sync_stocks() -> dict:
    """Sync full stock list from mootdx (TDX TCP)."""
    conn = get_db()
    try:
        cur = conn.cursor()
        now = datetime.now().isoformat()
        count = 0

        stocks = []
        try:
            from mootdx.quotes import Quotes
            client = Quotes.factory(market="std")
            df = client.stock_all()
            if df is not None and not df.empty:
                for _, row in df.iterrows():
                    code = str(row.get("code", "")).strip()
                    if not is_a_share(code):
                        continue
                    market = market_from_code(code) or 0
                    name = str(row.get("name", "") or "").replace("\x00", "").replace("\x01", "").strip()
                    if not _is_valid_stock_name(name):
                        continue
                    stocks.append({"code": code, "market": market, "name": name})
                logger.info(f"Fetched {len(stocks)} stocks from mootdx.")
        except Exception as e:
            logger.warning(f"mootdx stock list failed: {e}")

        if not stocks:
            raise RuntimeError("Failed to fetch stock list from mootdx")

        for stock in stocks:
            code = stock["code"]
            market = stock["market"]
            name = stock.get("name")
            if not name:
                name = "(unknown)"
            # list_date not available from these APIs
            cur.execute(
                """INSERT OR REPLACE INTO stocks (code, market, name, list_date, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (code, market, name, None, now)
            )
            count += 1

        conn.commit()
        logger.info(f"Synced {count} stocks.")
        return {"count": count}
    finally:
        conn.close()
