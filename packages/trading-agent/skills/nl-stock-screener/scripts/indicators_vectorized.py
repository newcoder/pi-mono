#!/usr/bin/env python3
"""
Vectorized technical indicator computation for batch screening.
Uses numba JIT for maximum single-thread performance.
"""
import numpy as np
import pandas as pd
from typing import Optional, Dict, Set

try:
    from numba import njit
    HAS_NUMBA = True
except ImportError:
    HAS_NUMBA = False
    def njit(*args, **kwargs):
        def wrapper(f):
            return f
        return wrapper


@njit(cache=True)
def _wilder_rsi_numba(close: np.ndarray, period: int = 14) -> np.ndarray:
    """Numba-accelerated Wilder RSI."""
    n = len(close)
    rsi = np.full(n, np.nan)
    if n < period + 1:
        return rsi

    gains = np.zeros(n)
    losses = np.zeros(n)
    for i in range(1, n):
        diff = close[i] - close[i - 1]
        if diff > 0:
            gains[i] = diff
        else:
            losses[i] = -diff

    avg_gain = np.mean(gains[1:period + 1])
    avg_loss = np.mean(losses[1:period + 1])

    if avg_loss == 0:
        rsi[period] = 100.0
    else:
        rsi[period] = 100.0 - (100.0 / (1.0 + avg_gain / avg_loss))

    for i in range(period + 1, n):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        if avg_loss == 0:
            rsi[i] = 100.0
        else:
            rsi[i] = 100.0 - (100.0 / (1.0 + avg_gain / avg_loss))

    return rsi


@njit(cache=True)
def _ema_numba(arr: np.ndarray, span: int) -> np.ndarray:
    """Numba EMA."""
    n = len(arr)
    result = np.full(n, np.nan)
    if n == 0:
        return result
    alpha = 2.0 / (span + 1)
    result[0] = arr[0]
    for i in range(1, n):
        result[i] = alpha * arr[i] + (1 - alpha) * result[i - 1]
    return result


@njit(cache=True)
def _macd_numba(close: np.ndarray) -> tuple:
    """Numba MACD: returns (dif, dea, hist)."""
    ema12 = _ema_numba(close, 12)
    ema26 = _ema_numba(close, 26)
    dif = ema12 - ema26
    dea = _ema_numba(dif, 9)
    hist = 2 * (dif - dea)
    return dif, dea, hist


@njit(cache=True)
def _bollinger_numba(closes: np.ndarray, period: int, std_dev: float):
    """Numba-accelerated Bollinger Bands."""
    n = len(closes)
    m = n - period + 1
    if m <= 0:
        return np.empty(0), np.empty(0), np.empty(0), np.empty(0)

    middle = np.empty(m)
    upper = np.empty(m)
    lower = np.empty(m)
    bandwidth = np.empty(m)

    for i in range(m):
        # SMA
        s = 0.0
        for j in range(period):
            s += closes[i + j]
        sma = s / period
        middle[i] = sma

        # STD
        var_sum = 0.0
        for j in range(period):
            diff = closes[i + j] - sma
            var_sum += diff * diff
        std = (var_sum / period) ** 0.5

        upper[i] = sma + std_dev * std
        lower[i] = sma - std_dev * std
        if sma != 0.0:
            bandwidth[i] = (upper[i] - lower[i]) / sma
        else:
            bandwidth[i] = np.nan

    return middle, upper, lower, bandwidth


def _compute_one_stock(code: str, market: int, closes: np.ndarray,
                       needed_indicators: Set[str], indicator_params: Dict,
                       volumes: np.ndarray = None) -> Dict:
    """Compute all needed indicators for a single stock."""
    row = {"code": code, "market": market}

    if "ma_cross" in needed_indicators:
        ma_params = indicator_params.get("ma_cross", {})
        fast = ma_params.get("fast", 5)
        slow = ma_params.get("slow", 10)
        if len(closes) >= slow + 1:
            ma_fast = np.convolve(closes, np.ones(fast) / fast, mode='valid')
            ma_slow = np.convolve(closes, np.ones(slow) / slow, mode='valid')
            if len(ma_fast) >= 2 and len(ma_slow) >= 2:
                f_prev, s_prev = ma_fast[-2], ma_slow[-2]
                f_curr, s_curr = ma_fast[-1], ma_slow[-1]
                if f_prev <= s_prev and f_curr > s_curr:
                    row[f"ma{fast}_ma{slow}_cross"] = "golden"
                elif f_prev >= s_prev and f_curr < s_curr:
                    row[f"ma{fast}_ma{slow}_cross"] = "death"
                else:
                    row[f"ma{fast}_ma{slow}_cross"] = None

    if "macd_cross" in needed_indicators:
        if len(closes) >= 27:
            dif, dea, _ = _macd_numba(closes)
            if len(dif) >= 2 and len(dea) >= 2:
                if dif[-2] <= dea[-2] and dif[-1] > dea[-1]:
                    row["macd_cross"] = "golden"
                elif dif[-2] >= dea[-2] and dif[-1] < dea[-1]:
                    row["macd_cross"] = "death"
                else:
                    row["macd_cross"] = None

    if "rsi" in needed_indicators:
        rsi_params = indicator_params.get("rsi", {})
        period = rsi_params.get("period", 14)
        if len(closes) >= period + 1:
            rsi_vals = _wilder_rsi_numba(closes, period)
            row[f"rsi{period}"] = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None

    if "bollinger_squeeze" in needed_indicators:
        bb_params = indicator_params.get("bollinger_squeeze", {})
        bb_period = bb_params.get("bb_period", 20)
        std_dev = bb_params.get("std_dev", 2.0)
        squeeze_days = bb_params.get("squeeze_days", 5)
        reference_days = bb_params.get("reference_days", 20)
        squeeze_threshold = bb_params.get("squeeze_threshold", 0.85)
        expansion_lookback = bb_params.get("expansion_lookback", 2)
        volume_period = bb_params.get("volume_period", 20)
        volume_ratio = bb_params.get("volume_ratio", 1.5)

        min_needed = bb_period + reference_days + squeeze_days + expansion_lookback
        if len(closes) >= min_needed:
            middle, upper, lower, bandwidth = _bollinger_numba(closes, bb_period, std_dev)
            if bandwidth is not None and len(bandwidth) >= reference_days + squeeze_days + expansion_lookback:
                # Reference period bandwidth (before squeeze)
                ref_bw = bandwidth[-(reference_days + squeeze_days + expansion_lookback):-(squeeze_days + expansion_lookback)]
                ref_mean = np.mean(ref_bw)

                # Squeeze period bandwidth
                squeeze_bw = bandwidth[-(squeeze_days + expansion_lookback):-expansion_lookback]
                squeeze_mean = np.mean(squeeze_bw)

                # Expansion period bandwidth (most recent)
                expansion_bw = bandwidth[-expansion_lookback:]
                expansion_mean = np.mean(expansion_bw)

                # Guard against NaN means (e.g. all-NaN slice)
                valid = not (np.isnan(ref_mean) or np.isnan(squeeze_mean) or np.isnan(expansion_mean))
                if valid:
                    is_squeezed = squeeze_mean < ref_mean * squeeze_threshold
                    is_expanding = expansion_mean > squeeze_mean * 1.0

                    # Volume surge check
                    volume_surge = False
                    vol_ratio_actual = 1.0
                    if volumes is not None and len(volumes) >= volume_period + expansion_lookback:
                        ref_vol = volumes[-(volume_period + expansion_lookback):-expansion_lookback]
                        recent_vol = volumes[-expansion_lookback:]
                        vol_ref_mean = np.mean(ref_vol)
                        vol_recent_mean = np.mean(recent_vol)
                        if not (np.isnan(vol_ref_mean) or np.isnan(vol_recent_mean)) and vol_ref_mean > 0:
                            vol_ratio_actual = vol_recent_mean / vol_ref_mean
                            volume_surge = vol_ratio_actual > volume_ratio

                    # Priority score for ranking when target_count is set
                    # Higher = stronger squeeze + bigger volume
                    squeeze_score = ref_mean / max(squeeze_mean, 1e-9)
                    bb_score = squeeze_score * vol_ratio_actual

                    row["bb_squeeze"] = bool(is_squeezed)
                    row["bb_expansion"] = bool(is_expanding)
                    row["bb_bandwidth"] = float(expansion_mean)
                    row["volume_surge"] = bool(volume_surge)
                    row["bollinger_squeeze_signal"] = bool(is_squeezed and is_expanding and volume_surge)
                    row["bb_score"] = float(bb_score)

    return row


def compute_indicators_for_stocks(df: pd.DataFrame, needed_indicators: Set[str],
                                   indicator_params: Dict = None) -> pd.DataFrame:
    """
    Compute indicators for all stocks using numba-accelerated per-stock functions.
    Single-threaded; numba JIT provides the speedup.
    """
    if len(df) == 0:
        return pd.DataFrame()

    df = df.sort_values(["code", "market", "date"]).reset_index(drop=True)
    grouper = ["code", "market"]
    params = indicator_params or {}

    rows = []
    for (code, market), group in df.groupby(grouper):
        closes = group["close"].dropna().values.astype(np.float64)
        volumes = None
        if "volume" in group.columns:
            volumes = group["volume"].dropna().values.astype(np.float64)
        row = _compute_one_stock(code, market, closes, needed_indicators, params, volumes)
        rows.append(row)

    return pd.DataFrame(rows)


def compute_ma_cross_batch(df: pd.DataFrame, fast: int, slow: int) -> pd.Series:
    if len(df) == 0:
        return pd.Series(dtype=object)
    result = compute_indicators_for_stocks(df, {"ma_cross"}, {"ma_cross": {"fast": fast, "slow": slow}})
    if result.empty:
        return pd.Series(dtype=object)
    return result.set_index(["code", "market"])[f"ma{fast}_ma{slow}_cross"]


def compute_macd_cross_batch(df: pd.DataFrame) -> pd.Series:
    if len(df) == 0:
        return pd.Series(dtype=object)
    result = compute_indicators_for_stocks(df, {"macd_cross"})
    if result.empty:
        return pd.Series(dtype=object)
    return result.set_index(["code", "market"])["macd_cross"]


def compute_rsi_batch(df: pd.DataFrame, period: int = 14) -> pd.Series:
    if len(df) == 0:
        return pd.Series(dtype=float)
    result = compute_indicators_for_stocks(df, {"rsi"}, {"rsi": {"period": period}})
    if result.empty:
        return pd.Series(dtype=float)
    return result.set_index(["code", "market"])[f"rsi{period}"]
