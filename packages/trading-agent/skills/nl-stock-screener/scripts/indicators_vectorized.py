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
                       volumes: np.ndarray = None,
                       opens: np.ndarray = None,
                       highs: np.ndarray = None,
                       lows: np.ndarray = None) -> Dict:
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

    if "ma_trend" in needed_indicators:
        ma_trend_params = indicator_params.get("ma_trend", {})
        fast = ma_trend_params.get("fast", 5)
        mid = ma_trend_params.get("mid", 10)
        slow = ma_trend_params.get("slow", 20)
        trend = ma_trend_params.get("trend", "bull")  # "bull" or "bear"
        if len(closes) >= slow + 1:
            ma_fast = np.convolve(closes, np.ones(fast) / fast, mode='valid')
            ma_mid = np.convolve(closes, np.ones(mid) / mid, mode='valid')
            ma_slow = np.convolve(closes, np.ones(slow) / slow, mode='valid')
            if len(ma_fast) > 0 and len(ma_mid) > 0 and len(ma_slow) > 0:
                if trend == "bull":
                    row["ma_trend"] = bool(ma_fast[-1] > ma_mid[-1] > ma_slow[-1])
                else:
                    row["ma_trend"] = bool(ma_fast[-1] < ma_mid[-1] < ma_slow[-1])

    if "bias" in needed_indicators:
        bias_params = indicator_params.get("bias", {})
        ma_period = bias_params.get("ma_period", 20)
        if len(closes) >= ma_period:
            ma = np.mean(closes[-ma_period:])
            bias_val = (closes[-1] - ma) / ma * 100 if ma != 0 else 0
            row[f"bias{ma_period}"] = float(bias_val)

    if "volume_price" in needed_indicators:
        vp_params = indicator_params.get("volume_price", {})
        pattern = vp_params.get("pattern", "volume_surge")  # "volume_surge", "volume_shrink"
        ma_period = vp_params.get("ma_period", 5)
        ratio = vp_params.get("ratio", 1.5)
        if volumes is not None and len(volumes) >= ma_period + 1:
            recent_vol = volumes[-1]
            ma_vol = np.mean(volumes[-(ma_period + 1):-1])
            if pattern == "volume_surge":
                row["volume_surge"] = bool(recent_vol > ma_vol * ratio)
            elif pattern == "volume_shrink":
                row["volume_shrink"] = bool(recent_vol < ma_vol / ratio)

    if "macd_status" in needed_indicators:
        macd_params = indicator_params.get("macd_status", {})
        status = macd_params.get("status", "near_golden")
        if len(closes) >= 27:
            dif, dea, hist = _macd_numba(closes)
            if len(dif) >= 2 and len(dea) >= 2:
                if status == "near_golden":
                    threshold = macd_params.get("threshold", 0.005)
                    # DIF below DEA but very close (relative to DEA)
                    dea_curr = dea[-1]
                    if dea_curr != 0:
                        dist = abs(dif[-1] - dea_curr) / abs(dea_curr)
                        passed = dif[-1] < dea_curr and dist < threshold
                    else:
                        passed = dif[-1] < dea_curr and abs(dif[-1] - dea_curr) < threshold
                    row["macd_near_golden"] = bool(passed)
                elif status == "bullish_divergence":
                    # Price makes lower low but MACD histogram converges (less negative)
                    if len(closes) >= 5 and len(hist) >= 5:
                        price_lower = closes[-1] < np.min(closes[-5:-1])
                        hist_converge = hist[-1] > hist[-2] > hist[-3]  # histogram increasing (less negative)
                        row["macd_bullish_divergence"] = bool(price_lower and hist_converge)

    if "candlestick" in needed_indicators:
        candle_params = indicator_params.get("candlestick", {})
        pattern = candle_params.get("pattern", "hammer")
        if opens is not None and highs is not None and lows is not None and len(closes) >= 3:
            o, h, l, c = opens[-1], highs[-1], lows[-1], closes[-1]
            body = abs(c - o)
            lower_shadow = min(o, c) - l
            upper_shadow = h - max(o, c)
            total_range = h - l if h != l else 1e-9

            if pattern == "hammer":
                # Lower shadow >= 2x body, small upper shadow (bottom reversal signal)
                passed = lower_shadow >= 2 * body and upper_shadow <= 0.1 * total_range
                row["candlestick_hammer"] = bool(passed)
            elif pattern == "bullish_engulfing" and len(closes) >= 2:
                # Bullish engulfing: today bullish, yesterday bearish, today body covers yesterday body
                prev_o, prev_c = opens[-2], closes[-2]
                passed = c > o and prev_c < prev_o and o <= prev_c and c >= prev_o
                row["candlestick_bullish_engulfing"] = bool(passed)
            elif pattern == "doji":
                # Doji: very small body relative to total range
                passed = body <= 0.1 * total_range
                row["candlestick_doji"] = bool(passed)

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
        opens = None
        if "open" in group.columns:
            opens = group["open"].dropna().values.astype(np.float64)
        highs = None
        if "high" in group.columns:
            highs = group["high"].dropna().values.astype(np.float64)
        lows = None
        if "low" in group.columns:
            lows = group["low"].dropna().values.astype(np.float64)
        row = _compute_one_stock(code, market, closes, needed_indicators, params, volumes, opens, highs, lows)
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
