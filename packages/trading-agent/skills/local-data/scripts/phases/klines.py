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

    # Post-close (>=15:00) runs refresh every stock: a daily bar fetched during
    # market hours only covers the session so far, and incremental syncs skip
    # codes whose latest row already equals the target date — so without a full
    # refresh an intraday partial bar would never be overwritten. Pre-close
    # runs only chase laggards (max < today); any partial "today" bar mootdx
    # returns in that case is dropped in the insert loop below.
    now = datetime.now()
    end_date = now.strftime('%Y-%m-%d')
    post_close = now.hour >= 15
    latest_rows = conn.execute(
        "SELECT code, market, MAX(date) as max_date FROM klines WHERE period = 'daily' AND adjust = 'bfq' GROUP BY code, market"
    ).fetchall()
    latest_map = {(r["code"], r["market"]): r["max_date"] for r in latest_rows}
    has_data = any(v for v in latest_map.values())

    if not has_data:
        start_date = (now - timedelta(days=90)).strftime('%Y-%m-%d')
        stocks_to_sync = stocks
        logger.info(f"No existing klines, fetching last 90 days for all {len(stocks_to_sync)} stocks")
    elif post_close:
        start_date = (now - timedelta(days=90)).strftime('%Y-%m-%d')
        stocks_to_sync = stocks
        logger.info(f"Post-close refresh: refetching all {len(stocks_to_sync)} stocks from {start_date}")
    else:
        start_date = (now - timedelta(days=90)).strftime('%Y-%m-%d')
        stocks_to_sync = [s for s in stocks if latest_map.get((s["code"], s["market"]), "") < end_date]
        logger.info(f"Pre-close sync: {len(stocks_to_sync)} stocks lag behind {end_date}, fetching from {start_date}")

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
                    # Skip degenerate realtime rows: OHLC collapsed to one price
                    # with a sentinel volume (~2^-127 float garbage from TDX).
                    vol = k.get("volume")
                    o, h, l, c = k.get("open"), k.get("high"), k.get("low"), k.get("close")
                    if vol is not None and 0 < vol < 1e-10 and None not in (o, h, l, c) and o == h == l == c:
                        continue
                    # Skip today's bar before the close: it is partial (session
                    # so far only). The next post-close run writes the final bar.
                    if not post_close and date_str == end_date:
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
