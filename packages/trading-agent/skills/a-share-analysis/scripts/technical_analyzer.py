#!/usr/bin/env python3
"""
A股技术分析模块
基于本地K线数据计算技术指标，判断趋势、支撑阻力、买卖信号

依赖: pip install pandas numpy
"""

import argparse
import json
import os
import sqlite3
import sys
from typing import List, Dict, Optional, Tuple

try:
    import pandas as pd
    import numpy as np
except ImportError:
    print("错误: 请先安装依赖库")
    print("pip install pandas numpy")
    sys.exit(1)

_LOCAL_DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")


def _query_local_db(sql: str, params: tuple = ()) -> list:
    """Execute a read-only query against the local market.db."""
    if not os.path.exists(_LOCAL_DB_PATH):
        return []
    try:
        conn = sqlite3.connect(_LOCAL_DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception:
        return []


def _get_market_from_code(code: str) -> int:
    """Infer market from code prefix: 1=SH, 0=SZ."""
    return 1 if code.startswith(("60", "68", "90")) else 0


def fetch_klines_local(code: str, days: int = 120, period: str = "daily", adjust: str = "bfq") -> pd.DataFrame:
    """Fetch klines from local SQLite database."""
    market = _get_market_from_code(code)
    rows = _query_local_db(
        "SELECT date, open, high, low, close, volume, turnover, pre_close FROM klines "
        "WHERE code = ? AND market = ? AND period = ? AND adjust = ? "
        "ORDER BY date DESC LIMIT ?",
        (code, market, period, adjust, days),
    )
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df = df.sort_values("date").reset_index(drop=True)
    numeric_cols = ["open", "high", "low", "close", "volume", "turnover", "pre_close"]
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def calc_ma(series: pd.Series, period: int) -> pd.Series:
    """计算简单移动平均线."""
    return series.rolling(window=period, min_periods=1).mean()


def calc_ema(series: pd.Series, period: int) -> pd.Series:
    """计算指数移动平均线."""
    return series.ewm(span=period, adjust=False, min_periods=1).mean()


def calc_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """计算RSI指标."""
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.rolling(window=period, min_periods=1).mean()
    avg_loss = loss.rolling(window=period, min_periods=1).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def calc_macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """计算MACD指标，返回 DIF, DEA, MACD柱状图."""
    ema_fast = calc_ema(series, fast)
    ema_slow = calc_ema(series, slow)
    dif = ema_fast - ema_slow
    dea = calc_ema(dif, signal)
    macd_hist = (dif - dea) * 2
    return dif, dea, macd_hist


def calc_bias(series: pd.Series, ma_period: int = 20) -> pd.Series:
    """计算乖离率 BIAS = (close - MA) / MA * 100."""
    ma = calc_ma(series, ma_period)
    return (series - ma) / ma.replace(0, np.nan) * 100


def calc_bollinger(series: pd.Series, period: int = 20, std_dev: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """计算布林带，返回 上轨, 中轨, 下轨."""
    mid = calc_ma(series, period)
    std = series.rolling(window=period, min_periods=1).std()
    upper = mid + std_dev * std
    lower = mid - std_dev * std
    return upper, mid, lower


def calc_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """计算ATR (Average True Range)."""
    high = df["high"]
    low = df["low"]
    close_prev = df["close"].shift(1)
    tr1 = high - low
    tr2 = (high - close_prev).abs()
    tr3 = (low - close_prev).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.rolling(window=period, min_periods=1).mean()


def find_support_resistance(df: pd.DataFrame, lookback: int = 20, touch_threshold: float = 0.01) -> Dict:
    """
    寻找近期支撑和阻力位.
    使用局部极值点（高点/低点）聚合近似价格作为支撑/阻力位.
    """
    if len(df) < lookback + 5:
        return {"supports": [], "resistances": []}

    window = df.iloc[-lookback:].copy()
    highs = window["high"].values
    lows = window["low"].values

    # 找局部高点 (左右各2根K线更低)
    resistance_levels = []
    for i in range(2, len(highs) - 2):
        if highs[i] > highs[i - 1] and highs[i] > highs[i - 2] and highs[i] > highs[i + 1] and highs[i] > highs[i + 2]:
            resistance_levels.append(highs[i])

    # 找局部低点
    support_levels = []
    for i in range(2, len(lows) - 2):
        if lows[i] < lows[i - 1] and lows[i] < lows[i - 2] and lows[i] < lows[i + 1] and lows[i] < lows[i + 2]:
            support_levels.append(lows[i])

    # 聚合相近水平 (聚类)
    def _cluster_levels(levels: List[float], threshold: float) -> List[Tuple[float, int]]:
        if not levels:
            return []
        levels_sorted = sorted(levels, reverse=True)
        clusters = []
        current = [levels_sorted[0]]
        for lvl in levels_sorted[1:]:
            if abs(lvl - np.mean(current)) / np.mean(current) <= threshold:
                current.append(lvl)
            else:
                clusters.append((round(np.mean(current), 2), len(current)))
                current = [lvl]
        clusters.append((round(np.mean(current), 2), len(current)))
        return clusters

    return {
        "supports": _cluster_levels(support_levels, touch_threshold),
        "resistances": _cluster_levels(resistance_levels, touch_threshold),
    }


def judge_ma_trend(df: pd.DataFrame, fast: int = 5, mid: int = 10, slow: int = 20) -> Dict:
    """判断均线排列状态（多头/空头/缠绕）."""
    if len(df) < slow:
        return {"trend": "unknown", "alignment": 0}

    ma_fast = calc_ma(df["close"], fast)
    ma_mid = calc_ma(df["close"], mid)
    ma_slow = calc_ma(df["close"], slow)

    latest_f = ma_fast.iloc[-1]
    latest_m = ma_mid.iloc[-1]
    latest_s = ma_slow.iloc[-1]

    # 多头排列: fast > mid > slow
    if latest_f > latest_m > latest_s:
        trend = "bullish"
    # 空头排列
    elif latest_f < latest_m < latest_s:
        trend = "bearish"
    else:
        trend = "neutral"

    # 计算均线乖离度 (fast 与 slow 的距离)
    alignment = round((latest_f - latest_s) / latest_s * 100, 2) if latest_s else 0

    return {
        "trend": trend,
        "alignment": alignment,
        "ma_fast": round(latest_f, 2),
        "ma_mid": round(latest_m, 2),
        "ma_slow": round(latest_s, 2),
    }


def judge_volume_pattern(df: pd.DataFrame, volume_ma_period: int = 20) -> Dict:
    """判断量价关系（放量/缩量/量价背离）."""
    if len(df) < volume_ma_period + 5:
        return {"pattern": "insufficient_data"}

    vol_ma = calc_ma(df["volume"], volume_ma_period)
    latest_vol = df["volume"].iloc[-1]
    latest_vol_ma = vol_ma.iloc[-1]
    prev_close = df["close"].iloc[-2]
    latest_close = df["close"].iloc[-1]

    vol_ratio = round(latest_vol / latest_vol_ma, 2) if latest_vol_ma and latest_vol_ma > 0 else 1.0
    price_change = round((latest_close - prev_close) / prev_close * 100, 2) if prev_close else 0

    # 放量上涨 / 缩量上涨 / 放量下跌 / 缩量下跌
    if price_change > 0:
        if vol_ratio >= 1.5:
            pattern = "volume_surge_up"
            desc = f"放量上涨 (+{price_change}%, 成交量{vol_ratio}x均量)"
        elif vol_ratio <= 0.6:
            pattern = "volume_shrink_up"
            desc = f"缩量上涨 (+{price_change}%, 成交量{vol_ratio}x均量，上涨动能减弱)"
        else:
            pattern = "normal_up"
            desc = f"正常上涨 (+{price_change}%, 成交量{vol_ratio}x均量)"
    else:
        if vol_ratio >= 1.5:
            pattern = "volume_surge_down"
            desc = f"放量下跌 ({price_change}%, 成交量{vol_ratio}x均量，抛压较重)"
        elif vol_ratio <= 0.6:
            pattern = "volume_shrink_down"
            desc = f"缩量下跌 ({price_change}%, 成交量{vol_ratio}x均量，抛压减轻)"
        else:
            pattern = "normal_down"
            desc = f"正常下跌 ({price_change}%, 成交量{vol_ratio}x均量)"

    # 量价背离检测 (最近5天)
    recent = df.iloc[-5:].copy()
    price_high_idx = recent["close"].idxmax()
    vol_high_idx = recent["volume"].idxmax()
    divergence = None
    if price_high_idx != vol_high_idx:
        divergence = "price_volume_divergence"
        desc += " | 注意：近期出现量价背离"

    return {
        "pattern": pattern,
        "description": desc,
        "volume_ratio": vol_ratio,
        "price_change_pct": price_change,
        "divergence": divergence,
    }


def judge_macd_signal(dif: pd.Series, dea: pd.Series, hist: pd.Series) -> Dict:
    """判断MACD信号状态."""
    if len(dif) < 3:
        return {"signal": "unknown"}

    latest_dif = dif.iloc[-1]
    latest_dea = dea.iloc[-1]
    latest_hist = hist.iloc[-1]
    prev_hist = hist.iloc[-2]

    # 金叉
    if dif.iloc[-2] <= dea.iloc[-2] and latest_dif > latest_dea:
        signal = "golden_cross"
        desc = "MACD金叉形成，多头信号"
    # 死叉
    elif dif.iloc[-2] >= dea.iloc[-2] and latest_dif < latest_dea:
        signal = "death_cross"
        desc = "MACD死叉形成，空头信号"
    # 多头延续
    elif latest_dif > latest_dea:
        if latest_hist > prev_hist:
            signal = "bullish_expanding"
            desc = "MACD多头区域，柱状线扩大，动能增强"
        else:
            signal = "bullish_contracting"
            desc = "MACD多头区域，柱状线缩小，动能减弱"
    # 空头延续
    else:
        if latest_hist < prev_hist:
            signal = "bearish_expanding"
            desc = "MACD空头区域，柱状线扩大，空头增强"
        else:
            signal = "bearish_contracting"
            desc = "MACD空头区域，柱状线缩小，空头减弱"

    # 底背离 (价格创新低但DIF未创新低) - 简化检测
    near_bullish_divergence = False
    if latest_dif < 0 and latest_hist > prev_hist:
        near_bullish_divergence = True
        desc += " | 接近底背离形态"

    return {
        "signal": signal,
        "description": desc,
        "dif": round(latest_dif, 3),
        "dea": round(latest_dea, 3),
        "hist": round(latest_hist, 3),
        "near_bullish_divergence": near_bullish_divergence,
    }


class TechnicalAnalyzer:
    """技术分析器"""

    def __init__(self, code: str, name: str = ""):
        self.code = code
        self.name = name
        self.df = pd.DataFrame()
        self.indicators = {}

    def load_data(self, days: int = 120) -> bool:
        """从本地数据库加载K线数据."""
        self.df = fetch_klines_local(self.code, days=days)
        if self.df.empty:
            return False
        # 计算所有指标
        self._compute_all()
        return True

    def _compute_all(self):
        """计算全部技术指标."""
        df = self.df
        close = df["close"]

        # MA
        self.indicators["ma5"] = calc_ma(close, 5)
        self.indicators["ma10"] = calc_ma(close, 10)
        self.indicators["ma20"] = calc_ma(close, 20)
        self.indicators["ma30"] = calc_ma(close, 30)
        self.indicators["ma60"] = calc_ma(close, 60)

        # RSI
        self.indicators["rsi6"] = calc_rsi(close, 6)
        self.indicators["rsi12"] = calc_rsi(close, 12)
        self.indicators["rsi24"] = calc_rsi(close, 24)

        # MACD
        dif, dea, hist = calc_macd(close)
        self.indicators["macd_dif"] = dif
        self.indicators["macd_dea"] = dea
        self.indicators["macd_hist"] = hist

        # BIAS
        self.indicators["bias5"] = calc_bias(close, 5)
        self.indicators["bias10"] = calc_bias(close, 10)
        self.indicators["bias20"] = calc_bias(close, 20)

        # Bollinger
        bb_up, bb_mid, bb_low = calc_bollinger(close)
        self.indicators["bb_upper"] = bb_up
        self.indicators["bb_mid"] = bb_mid
        self.indicators["bb_lower"] = bb_low

        # ATR
        self.indicators["atr14"] = calc_atr(df, 14)

    def analyze_trend(self) -> Dict:
        """趋势分析."""
        if self.df.empty:
            return {"error": "no data"}

        close = self.df["close"]
        latest_close = close.iloc[-1]

        # 短期趋势 (5/10/20)
        short_trend = judge_ma_trend(self.df, 5, 10, 20)
        # 中期趋势 (10/30/60)
        mid_trend = judge_ma_trend(self.df, 10, 30, 60)

        # RSI状态
        rsi6 = self.indicators["rsi6"].iloc[-1]
        rsi12 = self.indicators["rsi12"].iloc[-1]
        rsi24 = self.indicators["rsi24"].iloc[-1]

        def _rsi_state(rsi):
            if pd.isna(rsi):
                return "unknown"
            if rsi > 80:
                return "overbought"
            if rsi > 60:
                return "strong"
            if rsi > 40:
                return "neutral"
            if rsi > 20:
                return "weak"
            return "oversold"

        # MACD信号
        macd_signal = judge_macd_signal(
            self.indicators["macd_dif"],
            self.indicators["macd_dea"],
            self.indicators["macd_hist"],
        )

        # 支撑阻力
        sr = find_support_resistance(self.df, lookback=30)

        # 量价关系
        volume_pattern = judge_volume_pattern(self.df)

        # BIAS状态
        bias20 = self.indicators["bias20"].iloc[-1]
        bias_state = "unknown"
        if not pd.isna(bias20):
            if bias20 > 8:
                bias_state = "severely_overbought"
            elif bias20 > 5:
                bias_state = "overbought"
            elif bias20 < -8:
                bias_state = "severely_oversold"
            elif bias20 < -5:
                bias_state = "oversold"
            else:
                bias_state = "neutral"

        # 布林带位置
        bb_pos = "unknown"
        bb_up = self.indicators["bb_upper"].iloc[-1]
        bb_low = self.indicators["bb_lower"].iloc[-1]
        if not pd.isna(bb_up) and not pd.isna(bb_low) and bb_up != bb_low:
            if latest_close > bb_up:
                bb_pos = "above_upper"
            elif latest_close < bb_low:
                bb_pos = "below_lower"
            else:
                mid = (bb_up + bb_low) / 2
                bb_pos = "upper_half" if latest_close > mid else "lower_half"

        # 综合趋势判断
        overall = "neutral"
        if short_trend["trend"] == "bullish" and mid_trend["trend"] == "bullish":
            overall = "bullish"
        elif short_trend["trend"] == "bearish" and mid_trend["trend"] == "bearish":
            overall = "bearish"
        elif short_trend["trend"] == "bullish" and mid_trend["trend"] == "neutral":
            overall = "short_bullish"
        elif short_trend["trend"] == "bearish" and mid_trend["trend"] == "neutral":
            overall = "short_bearish"

        return {
            "code": self.code,
            "name": self.name,
            "latest_close": round(latest_close, 2),
            "latest_date": str(self.df["date"].iloc[-1]),
            "short_trend": short_trend,
            "mid_trend": mid_trend,
            "overall_trend": overall,
            "rsi": {
                "rsi6": round(rsi6, 2) if not pd.isna(rsi6) else None,
                "rsi12": round(rsi12, 2) if not pd.isna(rsi12) else None,
                "rsi24": round(rsi24, 2) if not pd.isna(rsi24) else None,
                "state": _rsi_state(rsi24),
            },
            "macd": macd_signal,
            "bias": {
                "bias5": round(self.indicators["bias5"].iloc[-1], 2) if not pd.isna(self.indicators["bias5"].iloc[-1]) else None,
                "bias10": round(self.indicators["bias10"].iloc[-1], 2) if not pd.isna(self.indicators["bias10"].iloc[-1]) else None,
                "bias20": round(bias20, 2) if not pd.isna(bias20) else None,
                "state": bias_state,
            },
            "bollinger": {
                "upper": round(bb_up, 2) if not pd.isna(bb_up) else None,
                "lower": round(bb_low, 2) if not pd.isna(bb_low) else None,
                "position": bb_pos,
            },
            "support_resistance": sr,
            "volume": volume_pattern,
        }

    def analyze_momentum(self) -> Dict:
        """动量分析：近期价格变动速度、加速度."""
        if len(self.df) < 20:
            return {"error": "insufficient data"}

        close = self.df["close"]
        returns = close.pct_change().dropna()

        # 近5日、10日、20日涨幅
        gain_5d = round((close.iloc[-1] - close.iloc[-5]) / close.iloc[-5] * 100, 2) if len(close) >= 5 else None
        gain_10d = round((close.iloc[-1] - close.iloc[-10]) / close.iloc[-10] * 100, 2) if len(close) >= 10 else None
        gain_20d = round((close.iloc[-1] - close.iloc[-20]) / close.iloc[-20] * 100, 2) if len(close) >= 20 else None

        # 波动率
        vol_20d = round(returns.iloc[-20:].std() * np.sqrt(252) * 100, 2) if len(returns) >= 20 else None

        # 相对于60日高/低的位置
        high_60 = close.iloc[-60:].max() if len(close) >= 60 else close.max()
        low_60 = close.iloc[-60:].min() if len(close) >= 60 else close.min()
        position_in_range = None
        if high_60 != low_60:
            position_in_range = round((close.iloc[-1] - low_60) / (high_60 - low_60) * 100, 2)

        return {
            "gain_5d": gain_5d,
            "gain_10d": gain_10d,
            "gain_20d": gain_20d,
            "volatility_annualized": vol_20d,
            "high_60d": round(high_60, 2),
            "low_60d": round(low_60, 2),
            "position_in_range": position_in_range,
        }

    def full_analysis(self) -> Dict:
        """完整技术分析报告."""
        if not self.load_data():
            return {"code": self.code, "error": "无法从本地数据库获取K线数据"}

        return {
            "code": self.code,
            "name": self.name,
            "analysis_date": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M"),
            "trend_analysis": self.analyze_trend(),
            "momentum_analysis": self.analyze_momentum(),
        }


def main():
    parser = argparse.ArgumentParser(description="A股技术分析器")
    parser.add_argument("--code", type=str, required=True, help="股票代码")
    parser.add_argument("--name", type=str, default="", help="股票名称")
    parser.add_argument("--days", type=int, default=120, help="K线数据天数")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    analyzer = TechnicalAnalyzer(args.code, args.name)
    result = analyzer.full_analysis()

    output_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_json)
        print(f"技术分析结果已保存到: {args.output}")
    else:
        print(output_json)


if __name__ == "__main__":
    main()
