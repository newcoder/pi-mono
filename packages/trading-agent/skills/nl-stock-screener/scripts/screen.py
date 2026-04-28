#!/usr/bin/env python3
"""
NL Stock Screener - Optimized screening engine.
Uses vectorized batch loading and computation for sub-second screening of 5000+ stocks.
"""
import argparse
import json
import sys
import os
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import pandas as pd
import numpy as np

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from indicators_vectorized import compute_ma_cross_batch, compute_macd_cross_batch, compute_rsi_batch
from db_utils import (
    get_stock_list, get_klines, get_klines_batch, get_quotes_batch, get_fundamentals_batch,
    sync_kline_if_missing, get_quote_data, save_indicators, get_cached_indicators,
    get_klines_codes
)

PERIOD_DAYS = {
    "daily": 120,
    "weekly": 60,
    "monthly": 24,
}


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# Quote-only fields (from quotes table)
QUOTE_FIELDS = {"market_cap", "pe", "pb", "change_pct"}

# All fundamentals fields available for screening
FUNDAMENTALS_FIELDS = {
    "total_revenue", "operate_revenue", "operate_cost", "total_operate_cost",
    "operate_profit", "total_profit", "net_profit", "parent_net_profit",
    "eps", "diluted_eps", "research_expense", "sale_expense", "manage_expense",
    "finance_expense", "interest_expense", "income_tax",
    "total_assets", "total_liabilities", "total_equity", "parent_equity",
    "total_current_assets", "total_current_liab", "inventory", "accounts_rece",
    "fixed_asset", "short_loan", "long_loan", "total_noncurrent_liab", "monetary_funds",
    "operate_cash_flow", "invest_cash_flow", "finance_cash_flow", "net_cash_increase",
    "construct_long_asset",
}


def analyze_conditions(conditions: List[dict]) -> Tuple[set, set, set]:
    """
    Analyze conditions to determine what data is needed.
    Returns (periods_needed, quote_fields_needed, fundamentals_fields_needed).
    """
    periods_needed = set()
    quote_fields_needed = set()
    fundamentals_fields_needed = set()

    for cond in conditions:
        ctype = cond.get("type")
        if ctype == "technical":
            for p in cond.get("periods", ["daily"]):
                periods_needed.add(p)
        elif ctype in ("fundamental", "quote"):
            field = cond.get("field", "")
            if field in QUOTE_FIELDS:
                quote_fields_needed.add(field)
            else:
                fundamentals_fields_needed.add(field)

    return periods_needed, quote_fields_needed, fundamentals_fields_needed


def check_fundamental_condition(row: Optional[pd.Series], condition: dict) -> tuple:
    """Check a fundamental/quote condition on a DataFrame row."""
    field = condition["field"]
    operator = condition["operator"]
    value = condition["value"]

    if row is None:
        return False, f"No data for {field}", None

    # Map alias to DB column name
    field_map = {
        "market_cap": "total_cap",
        "pe": "pe",
        "pb": "pb",
        "change_pct": "change_pct",
    }
    db_field = field_map.get(field, field)
    actual = row.get(db_field)

    if actual is None or pd.isna(actual):
        return False, f"{field}: missing", None

    try:
        actual_val = float(actual)
    except (TypeError, ValueError):
        return False, f"{field}: invalid value {actual}", None

    if operator == "between":
        if isinstance(value, list) and len(value) == 2:
            passed = value[0] <= actual_val <= value[1]
            detail = f"{field}: {actual_val:.2f} (range {value[0]}-{value[1]})"
            return passed, detail, actual_val
        return False, f"{field}: invalid between range", None

    try:
        passed = eval(f"{actual_val} {operator} {value}")
        detail = f"{field}: {actual_val:.2f}"
        return passed, detail, actual_val
    except Exception as e:
        return False, f"{field}: eval error {e}", None


def run_screening_fast(config: dict) -> dict:
    """
    Optimized screening using batch data loading and vectorized computation.
    """
    import time
    t0 = time.time()

    scope = config.get("scope", "all")
    conditions = config.get("conditions", [])
    stocks = get_stock_list(scope)
    total = len(stocks)

    if total == 0:
        return {
            "screen_time": datetime.now().isoformat(),
            "config": config,
            "total_checked": 0,
            "matched": 0,
            "results": [],
        }

    print(f"Screening {total} stocks with {len(conditions)} conditions...")

    # Parse conditions to know what data we need
    periods_needed, quote_fields_needed, fundamentals_fields_needed = analyze_conditions(conditions)

    # Build (code, market) list
    codes_markets = [(s["code"], s["market"]) for s in stocks]

    # --- Batch load all kline data ---
    t1 = time.time()
    kline_data = {}  # period -> DataFrame
    for period in periods_needed:
        days = PERIOD_DAYS.get(period, 120)
        df = get_klines_batch(codes_markets, period=period, adjust="bfq", days=days)
        if df.empty:
            # No data at all for this period - try sync for all missing stocks
            print(f"  No cached {period} data, syncing...")
            # Sync in chunks to avoid overwhelming the API
            for code, market in codes_markets[:50]:  # limit batch sync
                sync_kline_if_missing(code, market, period=period, days=days)
            df = get_klines_batch(codes_markets, period=period, adjust="bfq", days=days)
        kline_data[period] = df
    t_load = time.time() - t1
    print(f"  Data loaded in {t_load:.2f}s")

    # --- Batch load all quote data ---
    t2 = time.time()
    quotes_df = pd.DataFrame()
    if quote_fields_needed:
        quotes_df = get_quotes_batch(codes_markets)
    t_quote = time.time() - t2
    if not quotes_df.empty:
        print(f"  Quotes loaded in {t_quote:.2f}s ({len(quotes_df)} stocks)")

    # --- Batch load all fundamentals data ---
    t2_f = time.time()
    fundamentals_df = pd.DataFrame()
    if fundamentals_fields_needed:
        fundamentals_df = get_fundamentals_batch(codes_markets)
    t_fund = time.time() - t2_f
    if not fundamentals_df.empty:
        print(f"  Fundamentals loaded in {t_fund:.2f}s ({len(fundamentals_df)} stocks)")

    # --- Vectorized indicator computation ---
    t3 = time.time()
    indicator_cache = {}  # period -> DataFrame of indicators
    for period in periods_needed:
        df = kline_data.get(period)
        if df is None or df.empty:
            continue

        # Collect all needed indicators for this period in a single pass
        needed_indicators = set()
        indicator_params = {}
        for cond in conditions:
            if cond.get("type") == "technical":
                if period in cond.get("periods", ["daily"]):
                    ind = cond.get("indicator")
                    needed_indicators.add(ind)
                    indicator_params[ind] = cond.get("params", {})

        # Single-pass computation using numba-accelerated per-stock functions
        from indicators_vectorized import compute_indicators_for_stocks
        period_indicators = compute_indicators_for_stocks(df, needed_indicators, indicator_params)
        if not period_indicators.empty:
            indicator_cache[period] = period_indicators

    t_compute = time.time() - t3
    print(f"  Indicators computed in {t_compute:.2f}s")

    # --- Apply conditions to each stock ---
    t4 = time.time()
    results = []

    # Build lookup dicts for fast access
    quote_lookup = {}
    if not quotes_df.empty:
        quotes_df = quotes_df.set_index(["code", "market"])
        quote_lookup = quotes_df.to_dict("index")

    # Build fundamentals lookup and merge with quote_lookup
    if not fundamentals_df.empty:
        fundamentals_df = fundamentals_df.set_index(["code", "market"])
        fund_lookup = fundamentals_df.to_dict("index")
        # Merge: fundamentals fields override quote fields if same key exists
        for key, fund_data in fund_lookup.items():
            if key in quote_lookup:
                quote_lookup[key].update(fund_data)
            else:
                quote_lookup[key] = fund_data

    indicator_lookup = {}
    for period, df in indicator_cache.items():
        if "code" in df.columns and "market" in df.columns:
            indicator_lookup[period] = df.set_index(["code", "market"]).to_dict("index")
        elif "level_0" in df.columns:
            # MultiIndex reset created level_0, level_1
            df = df.rename(columns={"level_0": "code", "level_1": "market"})
            indicator_lookup[period] = df.set_index(["code", "market"]).to_dict("index")

    for stock in stocks:
        code = stock["code"]
        market = stock["market"]
        key = (code, market)
        signals = {}
        all_passed = True

        for cond in conditions:
            cond_type = cond.get("type")

            if cond_type == "technical":
                indicator = cond["indicator"]
                params = cond.get("params", {})
                periods = cond.get("periods", ["daily"])

                for period in periods:
                    lookup = indicator_lookup.get(period, {})
                    inds_for_stock = lookup.get(key, {})

                    if indicator == "ma_cross":
                        fast = params.get("fast", 5)
                        slow = params.get("slow", 10)
                        cross_type = params.get("cross_type", "golden")
                        cross = inds_for_stock.get(f"ma{fast}_ma{slow}_cross")
                        passed = cross == cross_type
                        detail = f"MA{fast}/MA{slow} cross: {cross or 'none'}"
                        signals[f"{period}_ma_cross"] = {"value": passed, "detail": detail, "raw": cross}
                        if not passed:
                            all_passed = False

                    elif indicator == "macd_cross":
                        cross_type = params.get("cross_type", "golden")
                        cross = inds_for_stock.get("macd_cross")
                        passed = cross == cross_type
                        detail = f"MACD cross: {cross or 'none'}"
                        signals[f"{period}_macd_cross"] = {"value": passed, "detail": detail, "raw": cross}
                        if not passed:
                            all_passed = False

                    elif indicator == "rsi":
                        period_rsi = params.get("period", 14)
                        operator = params.get("operator", "<")
                        value = params.get("value", 30)
                        rsi_val = inds_for_stock.get(f"rsi{period_rsi}")
                        if rsi_val is None or pd.isna(rsi_val):
                            passed = False
                            detail = f"RSI{period_rsi}: insufficient data"
                        else:
                            passed = eval(f"{rsi_val} {operator} {value}")
                            detail = f"RSI{period_rsi}: {rsi_val:.2f}"
                        signals[f"{period}_rsi"] = {"value": passed, "detail": detail, "raw": rsi_val}
                        if not passed:
                            all_passed = False

                    elif indicator == "bollinger_squeeze":
                        bb_signal = inds_for_stock.get("bollinger_squeeze_signal")
                        bb_squeeze = inds_for_stock.get("bb_squeeze")
                        bb_expansion = inds_for_stock.get("bb_expansion")
                        bb_bandwidth = inds_for_stock.get("bb_bandwidth")
                        volume_surge = inds_for_stock.get("volume_surge")

                        if bb_signal is None or pd.isna(bb_signal):
                            passed = False
                            detail = "Bollinger squeeze: insufficient data"
                        else:
                            passed = bool(bb_signal)
                            bw_str = f"{bb_bandwidth:.4f}" if bb_bandwidth is not None and not pd.isna(bb_bandwidth) else "N/A"
                            detail = f"Bollinger: squeeze={bb_squeeze}, expansion={bb_expansion}, vol_surge={volume_surge}, bw={bw_str}"
                        signals[f"{period}_bollinger_squeeze"] = {
                            "value": passed,
                            "detail": detail,
                            "raw": {
                                "squeeze": bb_squeeze,
                                "expansion": bb_expansion,
                                "volume_surge": volume_surge,
                                "bandwidth": bb_bandwidth,
                            }
                        }
                        if not passed:
                            all_passed = False

            elif cond_type in ("fundamental", "quote"):
                quote_row = quote_lookup.get(key)
                if quote_row:
                    # quote_row is a dict from to_dict
                    quote_series = pd.Series(quote_row)
                else:
                    quote_series = None
                passed, detail, value = check_fundamental_condition(quote_series, cond)
                signals[cond["field"]] = {"value": passed, "detail": detail, "raw": value}
                if not passed:
                    all_passed = False

        if all_passed:
            # Compute composite score for ranking when target_count is set
            score = 0.0
            for period in indicator_lookup:
                inds = indicator_lookup[period].get(key, {})
                if "bb_score" in inds:
                    score += inds["bb_score"]
                else:
                    score += 1.0  # Base score for passing any condition
            results.append({
                "code": code,
                "name": stock.get("name", ""),
                "market": market,
                "signals": signals,
                "_score": score,
            })

    # Apply target_count truncation with score-based ranking
    target_count = config.get("target_count")
    original_matched = len(results)
    if target_count and len(results) > target_count:
        results = sorted(results, key=lambda r: r["_score"], reverse=True)[:target_count]
        for r in results:
            del r["_score"]
        print(f"  Truncated to top {target_count} by score (from {original_matched})")
    else:
        for r in results:
            del r["_score"]

    t_filter = time.time() - t4
    total_time = time.time() - t0
    print(f"  Filtering applied in {t_filter:.2f}s")
    print(f"  Total: {total_time:.2f}s | Matched: {len(results)} / {total}")

    return {
        "screen_time": datetime.now().isoformat(),
        "config": config,
        "total_checked": total,
        "matched": len(results),
        "results": results,
        "perf": {
            "data_load_sec": round(t_load, 3),
            "quote_load_sec": round(t_quote, 3),
            "compute_sec": round(t_compute, 3),
            "filter_sec": round(t_filter, 3),
            "total_sec": round(total_time, 3),
        }
    }


# Tunable parameter definitions per indicator.
# strict_direction: "up" means larger value = stricter (fewer matches),
#                   "down" means smaller value = stricter.
_TUNABLE = {
    "bollinger_squeeze": [
        {"param": "volume_ratio", "min": 1.0, "max": 5.0, "strict_direction": "up"},
        {"param": "squeeze_threshold", "min": 0.5, "max": 0.95, "strict_direction": "down"},
    ],
    "rsi": [
        {"param": "value", "min": 10, "max": 50, "strict_direction": "down"},
    ],
}


def _set_param(conditions: list, cond_idx: int, param_name: str, value):
    """Set a parameter value in conditions list."""
    conditions[cond_idx]["params"][param_name] = value


def _find_tunable(config: dict) -> tuple:
    """Find first tunable condition and its spec. Returns (cond_idx, spec) or (None, None)."""
    for i, cond in enumerate(config.get("conditions", [])):
        if cond.get("type") == "technical":
            ind = cond.get("indicator")
            if ind in _TUNABLE:
                return i, _TUNABLE[ind][0]  # Use first tunable param
    return None, None


def run_screening_with_auto_tune(config: dict) -> dict:
    """
    Auto-tune parameters to hit target_count.
    If target_count is not set, delegates to run_screening_fast.
    """
    target = config.get("target_count")
    if not target:
        return run_screening_fast(config)

    # Remove target_count for baseline / tuning runs so we get raw counts
    base_config = {k: v for k, v in config.items() if k != "target_count"}

    # First run with current params to get baseline
    result = run_screening_fast(base_config)
    baseline = result["matched"]
    print(f"\n[Auto-tune] Baseline: {baseline} matches, target: {target}")

    # If already close (within 30%), just truncate by score
    if abs(baseline - target) <= target * 0.3:
        print(f"[Auto-tune] Baseline close enough, using score truncation.")
        return run_screening_fast(config)

    cond_idx, spec = _find_tunable(config)
    if cond_idx is None:
        print(f"[Auto-tune] No tunable params found, using score truncation.")
        return run_screening_fast(config)

    param_name = spec["param"]
    lo, hi = spec["min"], spec["max"]
    strict_dir = spec["strict_direction"]

    best_result = result
    best_diff = abs(baseline - target)
    tuned_config = json.loads(json.dumps(base_config))  # Deep copy without target_count

    # Binary search (max 6 iterations ~ 30s total)
    for iteration in range(6):
        mid = (lo + hi) / 2.0
        _set_param(tuned_config["conditions"], cond_idx, param_name, round(mid, 4))
        result = run_screening_fast(tuned_config)
        count = result["matched"]
        diff = abs(count - target)

        print(f"[Auto-tune] Iter {iteration + 1}: {param_name}={mid:.4f} -> {count} matches")

        if diff < best_diff:
            best_diff = diff
            best_result = result

        # Adjust search range
        if count > target:
            # Too many matches -> make stricter
            if strict_dir == "up":
                lo = mid
            else:
                hi = mid
        else:
            # Too few matches -> make looser
            if strict_dir == "up":
                hi = mid
            else:
                lo = mid

        # Early stop if very close
        if diff <= target * 0.15:
            print(f"[Auto-tune] Converged at {param_name}={mid:.4f}")
            break

    # If still too far, apply score truncation on best result
    if best_result["matched"] > target * 1.3:
        print(f"[Auto-tune] Still {best_result['matched']} matches, truncating to top {target} by score.")
        best_result = run_screening_fast({**best_result["config"], "target_count": target})

    return best_result


def run_screening(config: dict) -> dict:
    """Entry point: use fast vectorized version with optional auto-tune."""
    if config.get("target_count") and config.get("auto_tune", True):
        return run_screening_with_auto_tune(config)
    return run_screening_fast(config)


def main():
    parser = argparse.ArgumentParser(description="NL Stock Screener")
    parser.add_argument("--config", required=True, help="Path to screening config JSON file")
    parser.add_argument("--output", help="Output file path (overrides config)")
    args = parser.parse_args()

    config = load_config(args.config)
    output_path = args.output or config.get("output")

    result = run_screening(config)

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"\nResult saved to: {output_path}")
        print(f"Matched: {result['matched']} / {result['total_checked']}")
    else:
        print(result_json)


if __name__ == "__main__":
    main()
