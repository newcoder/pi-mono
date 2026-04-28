#!/usr/bin/env python3
"""
Technical indicators engine.
Pure numpy/pandas implementation, no external dependencies beyond pandas/numpy.
"""
import numpy as np
import pandas as pd
from typing import List, Optional, Tuple


def sma(series: pd.Series, period: int) -> pd.Series:
    """Simple Moving Average."""
    return series.rolling(window=period, min_periods=period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential Moving Average."""
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """MACD: returns (dif, dea, hist)."""
    ema_fast = ema(series, fast)
    ema_slow = ema(series, slow)
    dif = ema_fast - ema_slow
    dea = ema(dif, signal)
    hist = 2 * (dif - dea)
    return dif, dea, hist


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Relative Strength Index."""
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)

    avg_gain = gain.rolling(window=period, min_periods=period).mean()
    avg_loss = loss.rolling(window=period, min_periods=period).mean()

    # Wilder's smoothing
    for i in range(period, len(series)):
        avg_gain.iloc[i] = (avg_gain.iloc[i - 1] * (period - 1) + gain.iloc[i]) / period
        avg_loss.iloc[i] = (avg_loss.iloc[i - 1] * (period - 1) + loss.iloc[i]) / period

    rs = avg_gain / avg_loss
    rsi_series = 100 - (100 / (1 + rs))
    return rsi_series


def detect_cross(fast: pd.Series, slow: pd.Series) -> Optional[str]:
    """
    Detect the most recent cross type on the last bar.
    Returns: 'golden', 'death', or None.
    """
    if len(fast) < 2 or len(slow) < 2:
        return None

    # Get last two valid values
    f_prev = fast.iloc[-2]
    s_prev = slow.iloc[-2]
    f_curr = fast.iloc[-1]
    s_curr = slow.iloc[-1]

    if pd.isna(f_prev) or pd.isna(s_prev) or pd.isna(f_curr) or pd.isna(s_curr):
        return None

    if f_prev <= s_prev and f_curr > s_curr:
        return "golden"
    if f_prev >= s_prev and f_curr < s_curr:
        return "death"
    return None


def compute_ma_cross(df: pd.DataFrame, fast: int, slow: int) -> Optional[str]:
    """
    Compute MA cross on a DataFrame with 'close' column.
    Returns cross type on the latest bar.
    """
    if len(df) < slow + 1:
        return None
    ma_fast = sma(df["close"], fast)
    ma_slow = sma(df["close"], slow)
    return detect_cross(ma_fast, ma_slow)


def compute_macd_cross(df: pd.DataFrame) -> Optional[str]:
    """
    Compute MACD cross on a DataFrame with 'close' column.
    Returns cross type on the latest bar.
    """
    if len(df) < 27:
        return None
    dif, dea, _ = macd(df["close"])
    return detect_cross(dif, dea)


def compute_latest_rsi(df: pd.DataFrame, period: int = 14) -> Optional[float]:
    """Compute latest RSI value."""
    if len(df) < period + 1:
        return None
    rsi_series = rsi(df["close"], period)
    val = rsi_series.iloc[-1]
    return float(val) if not pd.isna(val) else None


def compute_indicators(df: pd.DataFrame) -> dict:
    """
    Compute all common indicators for a kline DataFrame.
    Returns a dict of indicator results.
    """
    if df is None or len(df) < 5:
        return {}

    result = {}
    closes = df["close"]

    # MA crosses
    for fast, slow in [(5, 10), (5, 20), (10, 20), (10, 30)]:
        if len(df) >= slow + 1:
            cross = compute_ma_cross(df, fast, slow)
            result[f"ma{fast}_ma{slow}_cross"] = cross

    # Latest MA values
    for period in [5, 10, 20, 30, 60]:
        if len(df) >= period:
            result[f"ma{period}"] = float(sma(closes, period).iloc[-1])

    # MACD
    if len(df) >= 27:
        result["macd_cross"] = compute_macd_cross(df)
        dif, dea, hist = macd(closes)
        result["macd_dif"] = float(dif.iloc[-1]) if not pd.isna(dif.iloc[-1]) else None
        result["macd_dea"] = float(dea.iloc[-1]) if not pd.isna(dea.iloc[-1]) else None

    # RSI
    for period in [6, 14]:
        if len(df) >= period + 1:
            result[f"rsi{period}"] = compute_latest_rsi(df, period)

    return result
