"""Auto-extracted from daily_sync.py."""

import logging

from datetime import datetime, timedelta

from local_data.db import get_db
from local_data.market import is_a_share

from .base import _phase

logger = logging.getLogger('daily_sync')

# ── Phase 3: Sync Klines ───────────────────────────────────────────────────

@_phase("klines")
def sync_klines() -> dict:
    """Sync daily klines for all stocks. Uses mootdx (TCP direct) / akshare. No JoinQuant dependency."""
    from batch_get_kline import batch_get_kline

    conn = get_db()

    # Get all stocks
    stocks = conn.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
    if not stocks:
        conn.close()
        raise RuntimeError("No stocks found. Run Phase 1 first.")

    # Filter to valid A-share codes only; skip indices, B-shares, delisted, etc.
    stocks = [s for s in stocks if is_a_share(s["code"])]

    total = len(stocks)
    logger.info(f"Found {total} valid A-share stocks...")

    # Determine target date from existing daily klines and skip stocks already up to date.
    # If no data exists, fall back to fetching the last 90 days for all stocks.
    end_date = datetime.now().strftime('%Y-%m-%d')
    latest_rows = conn.execute(
        "SELECT code, market, MAX(date) as max_date FROM klines WHERE period = 'daily' AND adjust = 'bfq' GROUP BY code, market"
    ).fetchall()
    latest_map = {(r["code"], r["market"]): r["max_date"] for r in latest_rows}
    target_date = max((d for d in latest_map.values() if d), default=None)

    if not target_date:
        start_date = (datetime.now() - timedelta(days=90)).strftime('%Y-%m-%d')
        stocks_to_sync = stocks
        logger.info(f"No existing klines, fetching last 90 days for all {len(stocks_to_sync)} stocks")
    else:
        start_date = (datetime.strptime(target_date, '%Y-%m-%d') - timedelta(days=90)).strftime('%Y-%m-%d')
        stocks_to_sync = [s for s in stocks if latest_map.get((s["code"], s["market"])) != target_date]
        logger.info(f"Target date {target_date}, {len(stocks_to_sync)} stocks need update, fetching from {start_date}")

    synced = 0
    failed = 0
    total_rows = 0

    try:
        # Process in batches of 50
        batch_size = 50
        sync_total = len(stocks_to_sync)
        for i in range(0, sync_total, batch_size):
            batch = stocks_to_sync[i:i + batch_size]
            batch_dicts = [{"code": s["code"], "market": s["market"]} for s in batch]

            try:
                klines = batch_get_kline(batch_dicts, start_date=start_date, end_date=end_date,
                                          period="daily", adjust="bfq")

                if not klines:
                    failed += len(batch)
                    continue

                # Count per-stock, not per-batch: a batch where only one stock
                # returned data used to count the whole batch as synced, hiding
                # real gaps from the next run's "need update" detection.
                covered = set()
                for k in klines:
                    code = k["code"]
                    market = k["market"]
                    date_str = k["date"]
                    if not date_str:
                        continue

                    conn.execute(
                        """INSERT OR REPLACE INTO klines
                           (code, market, period, adjust, date, open, high, low, close,
                            volume, turnover, change_pct, change_amount, amplitude, pre_close)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (code, market, 'daily', 'bfq', date_str,
                         k.get("open"), k.get("high"), k.get("low"), k.get("close"),
                         k.get("volume"), k.get("amount"),
                         k.get("change_pct"), k.get("change_amount"), k.get("amplitude"),
                         k.get("pre_close"))
                    )
                    covered.add((code, market))
                    total_rows += 1

                synced += len(covered)
                failed += len(batch) - len(covered)

                if (i // batch_size + 1) % 10 == 0:
                    conn.commit()
                    logger.info(f"  Klines progress: {min(i + batch_size, sync_total)}/{sync_total} stocks, {total_rows} rows")

            except Exception as e:
                logger.warning(f"  Batch {i}-{i+batch_size} failed: {e}")
                failed += len(batch)

        conn.commit()
        logger.info(f"Klines done: {synced} stocks synced, {failed} failed, {total_rows} rows inserted.")
        return {"synced": synced, "failed": failed, "rows": total_rows}
    finally:
        conn.close()
