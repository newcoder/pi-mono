#!/usr/bin/env python3
"""
Compute stock-level factor IC (rank correlation) for each rank_by metric.
Stores in factor_ic table for dynamic rank selection.
Usage: python calc_factor_ic.py [--since 2024-01-01] [--lookback 20] [--forward 5]
"""
import os, sys
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path: sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path: sys.path.insert(0, _SKILL_ROOT)

import argparse, sqlite3, math
from datetime import datetime
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from local_data.db import get_db

def load_quotes_map(conn):
    rows = conn.execute("""
        SELECT q.code, q.pe, q.pb, q.total_cap, q.float_cap
        FROM quotes q WHERE q.snapshot_date = (SELECT MAX(snapshot_date) FROM quotes)
    """).fetchall()
    return {r[0]: r for r in rows}

def load_klines(conn, date, all_codes):
    """Load kline data for a specific date for all codes."""
    if not all_codes: return pd.DataFrame()
    ph = ",".join("?" for _ in all_codes)
    sql = f"""
        SELECT code, close, turnover, change_pct, pre_close, volume
        FROM klines
        WHERE code IN ({ph}) AND period='daily' AND adjust='bfq' AND date=? AND close IS NOT NULL
    """
    return pd.read_sql_query(sql, conn, params=[*all_codes, date])

def compute_factor_values(klines_df, quotes_map, lookback_klines_map):
    """Compute factor values for a single date. Returns DataFrame with code+factors."""
    codes = klines_df['code'].tolist()
    result = pd.DataFrame({'code': codes})

    # 1. momentum: change_pct
    result['momentum'] = klines_df['change_pct'].values

    # 2. value: 1/PE + 1/PB composite
    pe_vals, pb_vals = [], []
    for c in codes:
        q = quotes_map.get(c)
        pe_vals.append(1.0 / max(q[1] or 1, 1) if q else 0)  # 1/PE
        pb_vals.append(1.0 / max(q[2] or 0.01, 0.01) if q else 0)  # 1/PB
    result['value'] = np.array(pe_vals) * 0.5 + np.array(pb_vals) * 0.5

    # 3. turnover: log10(trading amount)
    result['turnover'] = np.log10(klines_df['turnover'].fillna(0).values + 1)

    # 4. market_cap: log10(total_cap)
    caps = []
    for c in codes:
        q = quotes_map.get(c)
        caps.append(math.log10(max(q[3] or 1, 1)) if q and q[3] else 0)
    result['market_cap'] = np.array(caps)

    # 5. turnover_rate: amount / float_cap
    rates = []
    for i, c in enumerate(codes):
        amount = klines_df['turnover'].iloc[i] or 0
        q = quotes_map.get(c)
        fc = q[4] if q else None
        rates.append(amount / fc * 100 if amount > 0 and fc and fc > 0 else 0)
    result['turnover_rate'] = np.array(rates)

    # 6. low_volatility: negative of recent std dev (requires lookback closes)
    vols = []
    for c in codes:
        closes = lookback_klines_map.get(c)
        if closes and len(closes) >= 5:
            rets = [closes[i]/closes[i-1]-1 for i in range(1, len(closes))]
            vols.append(-np.std(rets) if len(rets) > 1 else 0)
        else:
            vols.append(0)
    result['low_volatility'] = np.array(vols)

    return result

def compute_forward_returns(conn, date, codes, forward_days):
    """Get forward return from date to date+forward trading days."""
    if not codes: return {}
    # Get the forward date
    fwd_date = conn.execute("""
        SELECT date FROM klines WHERE period='daily' AND date > ?
        ORDER BY date LIMIT 1 OFFSET ?
    """, (date, forward_days - 1)).fetchone()
    if not fwd_date: return {}
    fwd = fwd_date[0]

    ph = ",".join("?" for _ in codes)
    rows = conn.execute(f"""
        SELECT code, close FROM klines
        WHERE code IN ({ph}) AND period='daily' AND adjust='bfq' AND date IN (?,?)
        ORDER BY code, date
    """, [*codes, date, fwd]).fetchall()

    # Group by code
    by_code = {}
    for code, close in rows:
        if code not in by_code: by_code[code] = []
        by_code[code].append(close)

    result = {}
    for code, closes in by_code.items():
        if len(closes) == 2 and closes[0] and closes[0] > 0:
            result[code] = (closes[1] / closes[0] - 1) * 100  # pct return
    return result

def calc_all(conn, since="2024-01-01", lookback=20, forward_days=5):
    """Compute factor ICs for all rank_by metrics."""

    quotes_map = load_quotes_map(conn)
    print(f"Quotes: {len(quotes_map)} stocks")

    # Bulk load all klines into a dict of DataFrames by date
    print("Loading klines...")
    kdf = pd.read_sql_query(
        "SELECT code, date, close, turnover, change_pct, volume FROM klines WHERE period='daily' AND adjust='bfq' AND close IS NOT NULL AND date >= ? ORDER BY date",
        conn, params=(since,)
    )
    print(f"  {len(kdf)} kline rows")

    dates = sorted(kdf['date'].unique())
    print(f"  {len(dates)} dates from {dates[0]} to {dates[-1]}")

    # Pivot close prices for forward returns and volatility
    close_matrix = kdf.pivot_table(index='date', columns='code', values='close', aggfunc='last')
    # Forward-fill to handle missing dates
    close_matrix = close_matrix.ffill()

    factors = ['momentum', 'value', 'turnover', 'market_cap', 'turnover_rate', 'low_volatility']
    now = datetime.now().isoformat()
    total_saved = 0

    for di in range(len(dates)):
        date = dates[di]
        if (di + 1) % 50 == 0:
            print(f"  [{di+1}/{len(dates)}] {date}")

        day_df = kdf[kdf['date'] == date].set_index('code')
        if len(day_df) < 30: continue
        codes_today = day_df.index.tolist()

        # Forward return
        fwd_idx = min(di + forward_days, len(dates) - 1)
        if fwd_idx <= di: continue
        fwd_date = dates[fwd_idx]
        fwd_prices = close_matrix.loc[fwd_date] if fwd_date in close_matrix.index else None
        today_prices = close_matrix.loc[date] if date in close_matrix.index else None
        if fwd_prices is None or today_prices is None: continue
        fwd_rets = ((fwd_prices / today_prices - 1) * 100).to_dict()

        # Factor: momentum
        f_momentum = day_df['change_pct'].fillna(0).to_dict()

        # Factor: value (1/PE+1/PB)
        f_value = {}
        for c in codes_today:
            q = quotes_map.get(c)
            pe = 1.0 / max((q[1] or 1), 1) if q else 0
            pb = 1.0 / max((q[2] or 0.01), 0.01) if q else 0
            f_value[c] = pe * 0.5 + pb * 0.5

        # Factor: turnover
        f_turnover = {}
        for c in codes_today:
            v = day_df.loc[c, 'turnover'] if c in day_df.index else 0
            f_turnover[c] = math.log10(max(float(v or 0) + 1, 1))

        # Factor: market_cap
        f_mcap = {}
        for c in codes_today:
            q = quotes_map.get(c)
            f_mcap[c] = math.log10(max(q[3] or 1, 1)) if q and q[3] else 0

        # Factor: turnover_rate
        f_trate = {}
        for c in codes_today:
            amount = float(day_df.loc[c, 'turnover']) if c in day_df.index and pd.notna(day_df.loc[c, 'turnover']) else 0
            q = quotes_map.get(c)
            fc = q[4] if q else None
            f_trate[c] = amount / fc * 100 if amount > 0 and fc and fc > 0 else 0

        # Factor: low_volatility
        f_lowvol = {}
        lb_start = max(0, di - lookback)
        if lb_start < di:
            lb_closes = close_matrix.iloc[lb_start:di]
            for c in codes_today:
                if c in lb_closes.columns:
                    closes = lb_closes[c].dropna().values
                    if len(closes) >= 5:
                        rets = closes[1:] / closes[:-1] - 1
                        f_lowvol[c] = -float(np.std(rets)) if len(rets) > 1 else 0

        factor_maps = {
            'momentum': f_momentum, 'value_tag': f_value, 'turnover': f_turnover,
            'market_cap': f_mcap, 'turnover_rate': f_trate, 'low_volatility': f_lowvol,
        }

        for factor, fmap in factor_maps.items():
            if not fmap: continue
            codes = list(fmap.keys())
            f_vals = np.array([fmap.get(c, 0) for c in codes], dtype=float)
            f_ret = np.array([fwd_rets.get(c, 0) for c in codes], dtype=float)
            mask = np.isfinite(f_vals) & np.isfinite(f_ret) & (np.abs(f_vals) < 1e10)
            if mask.sum() < 30: continue
            try:
                ic, _ = spearmanr(f_vals[mask], f_ret[mask])
                if np.isfinite(ic):
                    conn.execute(
                        "INSERT OR REPLACE INTO factor_ic (date, factor_name, ic_value, sample_count, updated_at) VALUES (?,?,?,?,?)",
                        (date, f"stock_{factor}_forward{forward_days}d", float(ic), int(mask.sum()), now)
                    )
                    total_saved += 1
            except: pass

        if (di + 1) % 100 == 0:
            conn.commit()

    conn.commit()
    print(f"Done: {total_saved} IC rows saved")
    return {"ic_rows": total_saved}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="2024-01-01")
    parser.add_argument("--lookback", type=int, default=20)
    parser.add_argument("--forward", type=int, default=5)
    args = parser.parse_args()

    conn = get_db()
    try:
        calc_all(conn, args.since, args.lookback, args.forward)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
