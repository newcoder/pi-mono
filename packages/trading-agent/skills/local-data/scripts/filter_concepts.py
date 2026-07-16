#!/usr/bin/env python3
"""
Layer 1 automated concept filter.
Three hard filters: size, dispersion, independence.
Usage: python filter_concepts.py [--min-size 15] [--max-size 120] [--corr-threshold 0.85]
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
import sqlite3
from local_data.db import get_db
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import pandas as pd
import numpy as np


def ensure_tables(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS concept_filter_results (
            concept TEXT PRIMARY KEY,
            constituent_count INTEGER,
            dispersion REAL,
            max_benchmark_correlation REAL,
            size_pass INTEGER,
            dispersion_pass INTEGER,
            independence_pass INTEGER,
            rank_score REAL,
            rank INTEGER,
            updated_at TEXT
        )
    """)
    conn.commit()


def filter_by_size(
    conn: sqlite3.Connection,
    min_size: int = 15,
    max_size: int = 120,
) -> Tuple[List[Dict], List[Dict]]:
    """Filter concepts by constituent count. Returns (passed, excluded)."""
    rows = conn.execute(
        "SELECT concept, COUNT(*) as cnt FROM concept_stocks GROUP BY concept ORDER BY cnt DESC"
    ).fetchall()

    passed = []
    excluded = []
    for concept, cnt in rows:
        info = {"concept": concept, "constituent_count": cnt}
        if cnt < min_size:
            info["reason"] = f"too few constituents ({cnt} < {min_size})"
            excluded.append(info)
        elif cnt > max_size:
            info["reason"] = f"too many constituents ({cnt} > {max_size})"
            excluded.append(info)
        else:
            info["size_pass"] = 1
            passed.append(info)

    print(f"Size filter: {len(passed)} passed, {len(excluded)} excluded")
    return passed, excluded


def compute_dispersion(
    conn: sqlite3.Connection,
    concept: str,
    lookback_days: int = 20,
) -> Optional[float]:
    """Cross-sectional std dev of constituent daily returns on latest date."""
    end_date = conn.execute("SELECT MAX(date) FROM concept_synthetic_klines WHERE concept = ?", (concept,)).fetchone()[0]
    if not end_date:
        return None

    start_date = conn.execute(
        "SELECT MAX(date) FROM concept_synthetic_klines WHERE concept = ? AND date <= ?",
        (concept, end_date),
    ).fetchone()[0]
    if not start_date:
        return None

    # Get constituents
    rows = conn.execute(
        "SELECT code, CASE WHEN code LIKE '6%' OR code LIKE '9%' THEN 1 ELSE 0 END FROM concept_stocks WHERE concept = ?",
        (concept,),
    ).fetchall()
    if len(rows) < 3:
        return None

    constituents = [(r[0], r[1]) for r in rows]
    codes = [c[0] for c in constituents]
    markets = [str(c[1]) for c in constituents]

    code_placeholders = ",".join("?" for _ in codes)
    market_placeholders = ",".join("?" for _ in markets)

    sql = f"""
        SELECT k.date, k.code, k.close * COALESCE(a.qfq_factor, 1.0) as qfq_close
        FROM klines k
        LEFT JOIN adjust_factors a ON k.code = a.code AND k.market = a.market AND k.date = a.date
        WHERE k.code IN ({code_placeholders})
          AND k.market IN ({market_placeholders})
          AND k.period = 'daily' AND k.adjust = 'bfq'
          AND k.close IS NOT NULL
        ORDER BY k.date
    """
    params = [*codes, *markets]
    df = pd.read_sql_query(sql, conn, params=params)
    if df.empty:
        return None

    wide = df.pivot_table(index="date", columns="code", values="qfq_close", aggfunc="last")
    if wide.shape[1] < 3:
        return None

    returns = wide.pct_change().dropna(how="all")
    if returns.empty:
        return None

    # Cross-sectional std dev on each date, then take median over last N days
    cs_std = returns.std(axis=1)
    recent = cs_std.iloc[-lookback_days:] if len(cs_std) > lookback_days else cs_std
    return float(recent.median())


def compute_independence(
    conn: sqlite3.Connection,
    concept: str,
    lookback_days: int = 60,
) -> Optional[float]:
    """Max correlation between concept returns and benchmark index returns."""
    # Load concept returns from synthetic klines
    rows = conn.execute(
        "SELECT date, close FROM concept_synthetic_klines WHERE concept = ? ORDER BY date",
        (concept,),
    ).fetchall()
    if len(rows) < lookback_days:
        return None

    concept_df = pd.DataFrame(rows, columns=["date", "close"]).set_index("date")
    concept_df["ret"] = concept_df["close"].pct_change()
    recent = concept_df["ret"].dropna().iloc[-lookback_days:]

    # Load benchmark returns from klines table (already synced daily)
    benchmarks = ["000001", "000905"]  # 上证指数, 中证500
    max_corr = 0.0
    for bench in benchmarks:
        market = 1 if bench.startswith("6") or bench == "000001" else 0
        b_rows = conn.execute(
            "SELECT date, close FROM klines WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq' AND close IS NOT NULL ORDER BY date",
            (bench, market),
        ).fetchall()
        if len(b_rows) < lookback_days:
            continue
        b_df = pd.DataFrame(b_rows, columns=["date", "close"]).set_index("date")
        b_df["ret"] = b_df["close"].pct_change()
        b_recent = b_df["ret"].dropna()

        aligned = pd.concat([recent, b_recent], axis=1, join="inner").dropna()
        if len(aligned) < 20:
            continue
        corr = aligned.iloc[:, 0].corr(aligned.iloc[:, 1])
        if corr is not None and abs(corr) > abs(max_corr):
            max_corr = abs(corr)

    return max_corr if max_corr > 0 else None


def filter_by_independence(
    conn: sqlite3.Connection,
    concepts: List[Dict],
    correlation_threshold: float = 0.85,
) -> Tuple[List[Dict], List[Dict]]:
    """Filter concepts by benchmark correlation. Only runs on concepts that passed size."""
    passed = []
    excluded = []
    for i, c in enumerate(concepts):
        if (i + 1) % 20 == 0:
            print(f"  independence [{i+1}/{len(concepts)}]...")

        dispersion = compute_dispersion(conn, c["concept"])
        c["dispersion"] = dispersion

        corr = compute_independence(conn, c["concept"])
        c["max_benchmark_correlation"] = corr

        # Dispersion check
        disp_ok = dispersion is not None and dispersion >= 0.005
        c["dispersion_pass"] = 1 if disp_ok else 0

        # Independence check
        indep_ok = corr is None or corr <= correlation_threshold
        c["independence_pass"] = 1 if indep_ok else 0

        if corr is not None and corr > correlation_threshold:
            c["reason"] = f"too correlated with benchmark (corr={corr:.3f} > {correlation_threshold})"
            excluded.append(c)
        elif not disp_ok:
            c["reason"] = f"low dispersion ({dispersion:.4f})" if dispersion is not None else "no dispersion data"
            excluded.append(c)
        else:
            passed.append(c)

    print(f"Dispersion+Independence: {len(passed)} passed, {len(excluded)} excluded")
    return passed, excluded


def compute_rank_score(c: Dict) -> float:
    score = 0.0
    corr = c.get("max_benchmark_correlation")
    if corr is not None:
        score += (1.0 - corr) * 0.5
    disp = c.get("dispersion")
    if disp is not None:
        score += min(disp * 100, 1.0) * 0.3
    cnt = c.get("constituent_count", 0)
    if 30 <= cnt <= 80:
        score += 0.2
    return round(score, 4)


def save_filter_results(conn: sqlite3.Connection, all_results: List[Dict]) -> int:
    now = datetime.now().isoformat()
    conn.execute("DELETE FROM concept_filter_results")
    rows = []
    for i, c in enumerate(all_results):
        rows.append((
            c["concept"],
            c.get("constituent_count"),
            c.get("dispersion"),
            c.get("max_benchmark_correlation"),
            c.get("size_pass", 0),
            c.get("dispersion_pass", 0),
            c.get("independence_pass", 0),
            c.get("rank_score", 0),
            c.get("rank", i + 1),
            now,
        ))
    conn.executemany(
        """INSERT OR REPLACE INTO concept_filter_results
           (concept, constituent_count, dispersion, max_benchmark_correlation,
            size_pass, dispersion_pass, independence_pass, rank_score, rank, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    conn.commit()
    return len(rows)


def run_filter(
    conn: sqlite3.Connection,
    min_size: int = 15,
    max_size: int = 120,
    correlation_threshold: float = 0.85,
) -> dict:
    ensure_tables(conn)

    # Step 1: Size filter
    size_passed, size_excluded = filter_by_size(conn, min_size, max_size)
    for c in size_excluded:
        c["size_pass"] = 0
        c["dispersion_pass"] = 0
        c["independence_pass"] = 0
        c["rank_score"] = 0

    # Step 2: Dispersion + Independence on size-passed concepts
    survivors, others = filter_by_independence(conn, size_passed, correlation_threshold)

    # Combine all for scoring and saving
    all_results = []
    for c in survivors:
        c["rank_score"] = compute_rank_score(c)
        all_results.append(c)
    for c in others:
        c["rank_score"] = 0
        all_results.append(c)
    for c in size_excluded:
        all_results.append(c)

    # Sort by rank_score descending
    all_results.sort(key=lambda c: c.get("rank_score", 0), reverse=True)
    for i, c in enumerate(all_results):
        c["rank"] = i + 1

    save_filter_results(conn, all_results)

    print(f"\n=== Filter Summary ===")
    print(f"Total concepts: {len(all_results)}")
    print(f"Size passed: {len(size_passed)}, Survivors: {len(survivors)}")
    print(f"\nTop 20 survivors:")
    for c in survivors[:20]:
        print(f"  {c['rank']}. {c['concept']} (size={c.get('constituent_count')}, "
              f"disp={c.get('dispersion',0):.4f}, corr={c.get('max_benchmark_correlation',0):.3f}, "
              f"score={c['rank_score']:.3f})")

    return {
        "total": len(all_results),
        "size_passed": len(size_passed),
        "survivors": len(survivors),
    }


def main():
    parser = argparse.ArgumentParser(description="Layer 1 concept filter")
    parser.add_argument("--min-size", type=int, default=15)
    parser.add_argument("--max-size", type=int, default=120)
    parser.add_argument("--corr-threshold", type=float, default=0.85)
    args = parser.parse_args()

    conn = get_db()
    try:
        run_filter(conn, args.min_size, args.max_size, args.corr_threshold)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
