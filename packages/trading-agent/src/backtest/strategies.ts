import type { KlineRow } from "../data/types.js";
import { getCloses, getVolumes } from "../indicators/engine.js";
import { cachedEMA, cachedKD, cachedMA, cachedMACD, cachedOBV, cachedRSI, cachedSupertrend } from "./indicator-cache.js";
import type { Signal, StrategyType } from "./types.js";
import { average } from "./utils.js";

export interface StrategyParams {
	fast?: number;
	slow?: number;
	signal?: number;
	period?: number;
	oversold?: number;
	overbought?: number;
	stdDev?: number;
	multiplier?: number;
	// K-line patterns
	minBodyRatio?: number; // min body/open ratio for valid candles (default 0.02)
	// Composite signals
	volRatio?: number; // volume ratio threshold for breakout (default 1.5)
	minChange?: number; // min change_pct for breakout (default 2)
	compositeThreshold?: number; // buy threshold for tech_composite (default 65)
	compositeExitThreshold?: number; // sell threshold (default 40)
	// Volume contraction signal
	lookbackDays?: number; // prior reference window length (default 20)
	contractionDays?: number; // recent adjustment window length (default 5)
	priceDropPct?: number; // min price drop from adjustment start (default 5)
	volumeRatioMax?: number; // max recent/prior volume ratio (default 0.7)
	volatilityRatioMax?: number; // max recent/prior volatility ratio (default 0.6)
	requireFreshHigh?: number; // volume_contraction: only trade first pullback after a fresh high (default 0)
	// KD signal
	smoothK?: number; // K line smoothing period (default 3)
	smoothD?: number; // D line smoothing period (default 3)
	// New strategies (v2)
	maPeriod?: number; // ma_weekly_trend / shrink_volume_pullback: daily MA period (default 20)
	weekMa?: number; // ma_weekly_trend: weekly MA period (default 5)
	threshold?: number; // roc_momentum: momentum threshold in % (default 5)
	lookback?: number; // rsi_divergence: lookback window (default 20)
	volPeriod?: number; // volume_breakout / shrink_volume_pullback: volume avg window (default 10)
}

export function generateSignals(klines: KlineRow[], strategy: StrategyType, params: StrategyParams = {}): Signal[] {
	const registry: Record<string, (klines: KlineRow[], params: StrategyParams) => Signal[]> = {
		ma_cross: maCrossSignals,
		macd_cross: macdCrossSignals,
		rsi_reversal: rsiReversalSignals,
		bollinger_breakout: bollingerSignals,
		supertrend: supertrendSignals,
		hammer: hammerSignals,
		bullish_engulf: bullishEngulfSignals,
		morning_star: morningStarSignals,
		three_soldiers: threeSoldiersSignals,
		tech_composite: techCompositeSignals,
		breakout: breakoutSignals,
		volume_contraction: volumeContractionSignals,
		shooting_star: shootingStarSignals,
		bearish_engulf: bearishEngulfSignals,
		evening_star: eveningStarSignals,
		three_crows: threeCrowsSignals,
		rsi_overbought_sell: rsiOverboughtSellSignals,
		time_exit: timeExitSignals,
		always_buy: alwaysBuySignals,
		kd_daily: kdDailySignals,
		kd_weekly: kdWeeklySignals,
		ma_alignment: maAlignmentSignals,
		ema_cross: emaCrossSignals,
		ma_weekly_trend: maWeeklyTrendSignals,
		donchian_breakout: donchianBreakoutSignals,
		roc_momentum: rocMomentumSignals,
		macd_hist_reversal: macdHistReversalSignals,
		rsi_divergence: rsiDivergenceSignals,
		volume_breakout: volumeBreakoutSignals,
		shrink_volume_pullback: shrinkVolumePullbackSignals,
		obv_trend: obvTrendSignals,
		harami: haramiSignals,
		doji_reversal: dojiReversalSignals,
	};
	return (registry[strategy] ?? (() => []))(klines, params);
}

/** Strategy metadata: which signal directions each strategy generates. */
export const STRATEGY_META: Record<string, { buys: boolean; sells: boolean; description: string }> = {
	ma_cross: { buys: true, sells: true, description: "MA均线金叉/死叉" },
	macd_cross: { buys: true, sells: true, description: "MACD金叉/死叉" },
	rsi_reversal: { buys: true, sells: true, description: "RSI超卖买入/超买卖出" },
	bollinger_breakout: { buys: true, sells: true, description: "布林带下轨反弹/上轨回落" },
	supertrend: { buys: true, sells: true, description: "Supertrend趋势跟踪：转多买入/转空卖出" },
	tech_composite: { buys: true, sells: true, description: "技术综合打分：趋势+动量+量能+波动率四维评分" },
	hammer: { buys: true, sells: false, description: "锤子线反转：长下影+小实体，前日阴线" },
	bullish_engulf: { buys: true, sells: false, description: "阳包阴：阳线实体完全吞没前日阴线" },
	morning_star: { buys: true, sells: false, description: "晨星：大阴→小星→大阳，底部反转" },
	three_soldiers: { buys: true, sells: false, description: "红三兵：连续三阳，逐步放量" },
	breakout: { buys: true, sells: false, description: "突破买入：放量上涨，量比阈值+涨幅阈值" },
	volume_contraction: { buys: true, sells: false, description: "缩量调整：价格下跌+成交量萎缩+波动率收敛后买入" },
	shooting_star: { buys: false, sells: true, description: "流星线反转：长上影+小实体，顶部卖出信号" },
	bearish_engulf: { buys: false, sells: true, description: "阴包阳：阴线实体完全吞没前日阳线，卖出信号" },
	evening_star: { buys: false, sells: true, description: "暮星：大阳→小星→大阴，顶部反转卖出信号" },
	three_crows: { buys: false, sells: true, description: "三只乌鸦：连续三阴，逐步下跌，卖出信号" },
	rsi_overbought_sell: { buys: false, sells: true, description: "RSI超买回落：RSI从超买区下穿，卖出信号" },
	time_exit: { buys: false, sells: true, description: "定时换仓：每N个交易日强制卖出，用作固定周期再平衡" },
	always_buy: { buys: true, sells: false, description: "每日全买入：用于排序测试，每天给所有股票发买入信号" },
	kd_daily: { buys: true, sells: true, description: "日线KD：K线上穿D线买入，下穿卖出" },
	kd_weekly: { buys: true, sells: true, description: "周线KD：基于周线KDJ计算，信号在次一交易日执行" },
	ma_alignment: { buys: true, sells: true, description: "均线多头排列：MA5>10>20>60买入，空头排列卖出" },
	ema_cross: { buys: true, sells: true, description: "EMA快慢交叉：EMA12/26金叉买入，死叉卖出" },
	ma_weekly_trend: { buys: true, sells: false, description: "周线多头+日线回踩MA20买入（多周期）" },
	donchian_breakout: { buys: true, sells: true, description: "唐奇安通道：突破N日高点买入，跌破N日低点卖出" },
	roc_momentum: { buys: true, sells: true, description: "ROC动量：N日涨幅超阈值买入，跌幅超阈值卖出" },
	macd_hist_reversal: { buys: true, sells: true, description: "MACD柱状图：金叉买入，零轴上柱缩短卖出" },
	rsi_divergence: { buys: true, sells: false, description: "RSI底背离：价格新低但RSI未新低买入" },
	volume_breakout: { buys: true, sells: false, description: "放量突破：突破N日高点+量比放大买入" },
	shrink_volume_pullback: { buys: true, sells: false, description: "缩量回踩：上升趋势中缩量回踩MA10买入" },
	obv_trend: { buys: true, sells: false, description: "OBV趋势：OBV创新高+站上MA20买入" },
	harami: { buys: true, sells: true, description: "孕线：看涨孕线买入，看跌孕线卖出" },
	doji_reversal: { buys: true, sells: false, description: "低位十字星：长下影十字星买入" },
};

function maCrossSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const fast = params.fast ?? 5;
	const slow = params.slow ?? 10;
	if (klines.length < slow + 1) return [];

	const maFast = cachedMA(klines, fast).values;
	const maSlow = cachedMA(klines, slow).values;
	const signals: Signal[] = [];

	for (let i = 1; i < klines.length; i++) {
		const fPrev = maFast[i - 1];
		const sPrev = maSlow[i - 1];
		const fCurr = maFast[i];
		const sCurr = maSlow[i];
		if (fPrev == null || sPrev == null || fCurr == null || sCurr == null) continue;

		if (fPrev <= sPrev && fCurr > sCurr) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: klines[i].close ?? 0,
				reason: `MA${fast}金叉MA${slow}`,
			});
		} else if (fPrev >= sPrev && fCurr < sCurr) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: klines[i].close ?? 0,
				reason: `MA${fast}死叉MA${slow}`,
			});
		}
	}
	return signals;
}

function macdCrossSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const fast = params.fast ?? 12;
	const slow = params.slow ?? 26;
	const signalPeriod = params.signal ?? 9;
	if (klines.length < slow + signalPeriod + 1) return [];

	const macd = cachedMACD(klines, { fast, slow, signal: signalPeriod });
	const signals: Signal[] = [];

	for (let i = 1; i < klines.length; i++) {
		const dPrev = macd.dif[i - 1];
		const aPrev = macd.dea[i - 1];
		const dCurr = macd.dif[i];
		const aCurr = macd.dea[i];
		if (dPrev == null || aPrev == null || dCurr == null || aCurr == null) continue;

		if (dPrev <= aPrev && dCurr > aCurr) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: klines[i].close ?? 0,
				reason: "MACD金叉",
			});
		} else if (dPrev >= aPrev && dCurr < aCurr) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: klines[i].close ?? 0,
				reason: "MACD死叉",
			});
		}
	}
	return signals;
}

function rsiReversalSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 14;
	const oversold = params.oversold ?? 30;
	const overbought = params.overbought ?? 70;
	if (klines.length < period + 1) return [];

	const rsi = cachedRSI(klines, { period }).values;
	const signals: Signal[] = [];
	let inPosition = false;

	for (let i = 1; i < klines.length; i++) {
		const prev = rsi[i - 1];
		const curr = rsi[i];
		if (prev == null || curr == null) continue;

		if (!inPosition && prev <= oversold && curr > oversold) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: klines[i].close ?? 0,
				reason: `RSI${period}超卖反弹(${curr.toFixed(1)})`,
			});
			inPosition = true;
		} else if (inPosition && prev >= overbought && curr < overbought) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: klines[i].close ?? 0,
				reason: `RSI${period}超买回落(${curr.toFixed(1)})`,
			});
			inPosition = false;
		}
	}
	return signals;
}

function bollingerSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 20;
	const stdDev = params.stdDev ?? 2;
	if (klines.length < period + 1) return [];

	const closes = getCloses(klines);
	const maValues = cachedMA(klines, period).values; // O(1) per access via cache
	const signals: Signal[] = [];
	let inPosition = false;

	for (let i = period; i < klines.length; i++) {
		const sma = maValues[i];
		if (sma == null) continue;

		// Compute std dev for window [i-period+1, i]
		let sqSum = 0;
		let sqCount = 0;
		for (let j = i - period + 1; j <= i; j++) {
			const c = closes[j];
			if (c != null) {
				sqSum += (c - sma) ** 2;
				sqCount++;
			}
		}
		if (sqCount < period * 0.8) continue;
		const std = Math.sqrt(sqSum / sqCount);
		const upper = sma + stdDev * std;
		const lower = sma - stdDev * std;
		const close = closes[i];
		const prevClose = closes[i - 1];
		if (close == null || prevClose == null) continue;

		if (!inPosition && prevClose <= lower && close > lower) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: close,
				reason: `布林带下轨反弹(${close.toFixed(2)} > ${lower.toFixed(2)})`,
			});
			inPosition = true;
		} else if (inPosition && prevClose >= upper && close < upper) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: close,
				reason: `布林带上轨回落(${close.toFixed(2)} < ${upper.toFixed(2)})`,
			});
			inPosition = false;
		}
	}
	return signals;
}
function supertrendSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 10;
	const multiplier = params.multiplier ?? 3;
	if (klines.length < period + 1) return [];

	const st = cachedSupertrend(klines, { period, multiplier });
	const signals: Signal[] = [];
	let inPosition = false;

	for (let i = 1; i < klines.length; i++) {
		const prevTrend = st.trend[i - 1];
		const currTrend = st.trend[i];
		const close = klines[i].close;
		if (prevTrend == null || currTrend == null || close == null) continue;

		if (prevTrend === "down" && currTrend === "up") {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: close,
				reason: `Supertrend转多(周期${period}, 倍数${multiplier})`,
			});
			inPosition = true;
			continue;
		}

		if (inPosition && prevTrend === "up" && currTrend === "down") {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: close,
				reason: `Supertrend转空(周期${period}, 倍数${multiplier})`,
			});
			inPosition = false;
		}
	}
	return signals;
}

// ─── K-line Pattern Signals ──────────────────────────────────────

function hammerSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const minBody = params.minBodyRatio ?? 0.02;
	const signals: Signal[] = [];
	for (let i = 1; i < klines.length; i++) {
		const c = klines[i],
			p = klines[i - 1];
		if (c.open == null || c.close == null || c.high == null || c.low == null) continue;
		if (p.open == null || p.close == null) continue;
		const body = Math.abs(c.close - c.open);
		const upper = c.high - Math.max(c.open, c.close);
		const lower = Math.min(c.open, c.close) - c.low;
		if (body < c.close * minBody) continue;
		if (lower < body * 2) continue;
		if (upper > body * 0.3) continue;
		if (p.close >= p.open) continue;
		signals.push({ index: i, date: c.date, type: "buy", price: c.close, reason: "Hammer" });
	}
	return signals;
}

function bullishEngulfSignals(klines: KlineRow[], _params: StrategyParams): Signal[] {
	const signals: Signal[] = [];
	for (let i = 1; i < klines.length; i++) {
		const c = klines[i],
			p = klines[i - 1];
		if (c.open == null || c.close == null || p.open == null || p.close == null) continue;
		const cBody = Math.abs(c.close - c.open),
			pBody = Math.abs(p.close - p.open);
		if (c.close <= c.open || p.close >= p.open) continue;
		if (c.open > p.close || c.close < p.open) continue;
		if (cBody < pBody * 0.8) continue;
		signals.push({ index: i, date: c.date, type: "buy", price: c.close, reason: "BullishEngulf" });
	}
	return signals;
}

function morningStarSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const minBody = params.minBodyRatio ?? 0.02;
	const signals: Signal[] = [];
	for (let i = 2; i < klines.length; i++) {
		const pp = klines[i - 2],
			p = klines[i - 1],
			c = klines[i];
		if (!pp.close || !pp.open || !p.close || !p.open || !c.close || !c.open) continue;
		const ppBody = Math.abs(pp.close - pp.open),
			pBody = Math.abs(p.close - p.open),
			cBody = Math.abs(c.close - c.open);
		if (pp.close >= pp.open || ppBody < pp.close * minBody) continue;
		if (pBody > ppBody * 0.5) continue;
		if ((p.open + p.close) / 2 > pp.close) continue;
		if (c.close <= c.open || cBody < c.close * minBody) continue;
		if (c.open < (p.open + p.close) / 2) continue;
		signals.push({ index: i, date: c.date, type: "buy", price: c.close, reason: "MorningStar" });
	}
	return signals;
}

function threeSoldiersSignals(klines: KlineRow[], _params: StrategyParams): Signal[] {
	const signals: Signal[] = [];
	for (let i = 2; i < klines.length; i++) {
		const c1 = klines[i - 2],
			c2 = klines[i - 1],
			c3 = klines[i];
		if (!c1.close || !c2.close || !c3.close || !c1.open || !c2.open || !c3.open) continue;
		if (!c1.volume || !c2.volume || !c3.volume) continue;
		if (c1.close <= c1.open || c2.close <= c2.open || c3.close <= c3.open) continue;
		if (c2.close <= c1.close || c3.close <= c2.close) continue;
		if (c2.volume < c1.volume || c3.volume < c2.volume) continue;
		signals.push({ index: i, date: c3.date, type: "buy", price: c3.close, reason: "ThreeSoldiers" });
	}
	return signals;
}

function shootingStarSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const minBody = params.minBodyRatio ?? 0.02;
	const signals: Signal[] = [];
	for (let i = 1; i < klines.length; i++) {
		const c = klines[i],
			p = klines[i - 1];
		if (c.open == null || c.close == null || c.high == null || c.low == null) continue;
		if (p.open == null || p.close == null) continue;
		const body = Math.abs(c.close - c.open);
		const upper = c.high - Math.max(c.open, c.close);
		const lower = Math.min(c.open, c.close) - c.low;
		if (body < c.close * minBody) continue;
		if (upper < body * 2) continue;
		if (lower > body * 0.3) continue;
		if (p.close <= p.open) continue; // prior should be bullish
		if (p.close >= c.open) continue; // gap up
		signals.push({ index: i, date: c.date, type: "sell", price: c.close, reason: "ShootingStar" });
	}
	return signals;
}

function bearishEngulfSignals(klines: KlineRow[], _params: StrategyParams): Signal[] {
	const signals: Signal[] = [];
	for (let i = 1; i < klines.length; i++) {
		const c = klines[i],
			p = klines[i - 1];
		if (c.open == null || c.close == null || p.open == null || p.close == null) continue;
		const cBody = Math.abs(c.close - c.open),
			pBody = Math.abs(p.close - p.open);
		if (c.close >= c.open || p.close <= p.open) continue;
		if (c.open <= p.close || c.close >= p.open) continue;
		if (cBody < pBody * 0.8) continue;
		signals.push({ index: i, date: c.date, type: "sell", price: c.close, reason: "BearishEngulf" });
	}
	return signals;
}

function eveningStarSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const minBody = params.minBodyRatio ?? 0.02;
	const signals: Signal[] = [];
	for (let i = 2; i < klines.length; i++) {
		const pp = klines[i - 2],
			p = klines[i - 1],
			c = klines[i];
		if (!pp.close || !pp.open || !p.close || !p.open || !c.close || !c.open) continue;
		const ppBody = Math.abs(pp.close - pp.open),
			pBody = Math.abs(p.close - p.open),
			cBody = Math.abs(c.close - c.open);
		if (pp.close <= pp.open || ppBody < pp.close * minBody) continue;
		if (pBody > ppBody * 0.5) continue;
		if ((p.open + p.close) / 2 <= pp.close) continue;
		if (c.close >= c.open || cBody < c.close * minBody) continue;
		if (c.open >= (p.open + p.close) / 2) continue;
		const midPoint = (pp.open + pp.close) / 2;
		if (c.close >= midPoint) continue;
		signals.push({ index: i, date: c.date, type: "sell", price: c.close, reason: "EveningStar" });
	}
	return signals;
}

function threeCrowsSignals(klines: KlineRow[], _params: StrategyParams): Signal[] {
	const signals: Signal[] = [];
	for (let i = 2; i < klines.length; i++) {
		const c1 = klines[i - 2],
			c2 = klines[i - 1],
			c3 = klines[i];
		if (!c1.close || !c2.close || !c3.close || !c1.open || !c2.open || !c3.open) continue;
		if (c1.close >= c1.open || c2.close >= c2.open || c3.close >= c3.open) continue;
		if (c2.close >= c1.close || c3.close >= c2.close) continue;
		if (c2.open > c1.open || c2.open < c1.close) continue;
		if (c3.open > c2.open || c3.open < c2.close) continue;
		signals.push({ index: i, date: c3.date, type: "sell", price: c3.close, reason: "ThreeCrows" });
		i += 2; // avoid overlapping patterns
	}
	return signals;
}

function rsiOverboughtSellSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 14;
	const overbought = params.overbought ?? 70;
	if (klines.length < period + 1) return [];

	const rsi = cachedRSI(klines, { period }).values;
	const signals: Signal[] = [];

	for (let i = 1; i < klines.length; i++) {
		const prev = rsi[i - 1];
		const curr = rsi[i];
		if (prev == null || curr == null) continue;

		if (prev >= overbought && curr < overbought) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: klines[i].close ?? 0,
				reason: `RSI${period}超买回落(${curr.toFixed(1)})`,
			});
		}
	}
	return signals;
}

function alwaysBuySignals(klines: KlineRow[]): Signal[] {
	const signals: Signal[] = [];
	for (let i = 0; i < klines.length; i++) {
		const close = klines[i].close;
		if (close == null) continue;
		signals.push({
			index: i,
			date: klines[i].date,
			type: "buy",
			price: close,
			reason: "AlwaysBuy",
		});
	}
	return signals;
}

function timeExitSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 5;
	if (klines.length < period) return [];

	const signals: Signal[] = [];
	for (let i = period - 1; i < klines.length; i += period) {
		const close = klines[i].close;
		if (close == null) continue;
		signals.push({
			index: i,
			date: klines[i].date,
			type: "sell",
			price: close,
			reason: `TimeExit(${period}天)`,
		});
	}
	return signals;
}

function volumeContractionSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const lookbackDays = params.lookbackDays ?? 20;
	const contractionDays = params.contractionDays ?? 5;
	const priceDropPct = params.priceDropPct ?? 5;
	const volumeRatioMax = params.volumeRatioMax ?? 0.7;
	const volatilityRatioMax = params.volatilityRatioMax ?? 0.6;
	const requireFreshHigh = (params.requireFreshHigh ?? 0) !== 0;

	const minLength = lookbackDays + contractionDays;
	if (klines.length < minLength) return [];

	const signals: Signal[] = [];

	for (let i = minLength - 1; i < klines.length; i++) {
		const current = klines[i];
		if (current.close == null || current.volume == null) continue;

		const priorStart = i - lookbackDays - contractionDays + 1;
		const priorEnd = i - contractionDays;
		const recentStart = i - contractionDays + 1;
		const recentEnd = i;

		const priorWindow = klines.slice(priorStart, priorEnd + 1);
		const recentWindow = klines.slice(recentStart, recentEnd + 1);

		if (priorWindow.length < lookbackDays || recentWindow.length < contractionDays) continue;

		// 1. Price adjustment: recent close is lower than adjustment start
		const adjustmentStartClose = klines[priorEnd].close;
		if (adjustmentStartClose == null) continue;
		if (current.close >= adjustmentStartClose * (1 - priceDropPct / 100)) continue;

		// Optional: require the contraction to start right after a fresh high in the lookback window.
		// This filters out lower-high / M-top patterns and keeps first-pullback setups.
		if (requireFreshHigh) {
			const peakHigh = klines[priorEnd].high;
			if (peakHigh == null) continue;
			const priorHighsExcludingPeak = priorWindow
				.slice(0, -1)
				.map((k) => k.high)
				.filter((h): h is number => h != null);
			if (priorHighsExcludingPeak.length === 0) continue;
			const maxPriorHigh = Math.max(...priorHighsExcludingPeak);
			if (peakHigh <= maxPriorHigh) continue;
		}

		// 2. Volume contraction: recent average volume significantly lower than prior average
		const avgVolumePrior = average(priorWindow.map((k) => k.volume));
		const avgVolumeRecent = average(recentWindow.map((k) => k.volume));
		if (avgVolumePrior <= 0 || avgVolumeRecent > avgVolumePrior * volumeRatioMax) continue;

		// 3. Volatility contraction: recent realized vol lower than prior realized vol
		const priorVol = realizedVolatility(priorWindow);
		const recentVol = realizedVolatility(recentWindow);
		if (priorVol <= 0 || recentVol > priorVol * volatilityRatioMax) continue;

		// 4. Gradually declining price fluctuation within the recent window
		const trs = recentWindow.map((k, idx) => {
			const prevClose = idx === 0 ? adjustmentStartClose : recentWindow[idx - 1].close;
			if (k.high == null || k.low == null || prevClose == null) return 0;
			return Math.max(k.high - k.low, Math.abs(k.high - prevClose), Math.abs(k.low - prevClose));
		});
		if (slope(trs) >= 0) continue;

		const reason = requireFreshHigh
			? `VolumeContraction创新高后首次回调(价跌${priceDropPct.toFixed(0)}% 量缩${((avgVolumeRecent / avgVolumePrior) * 100).toFixed(0)}% 波动${((recentVol / priorVol) * 100).toFixed(0)}%)`
			: `VolumeContraction(价跌${priceDropPct.toFixed(0)}% 量缩${((avgVolumeRecent / avgVolumePrior) * 100).toFixed(0)}% 波动${((recentVol / priorVol) * 100).toFixed(0)}%)`;

		signals.push({
			index: i,
			date: current.date,
			type: "buy",
			price: current.close,
			reason,
		});
	}

	return signals;
}

function realizedVolatility(window: KlineRow[]): number {
	const returns: number[] = [];
	for (let i = 1; i < window.length; i++) {
		const prev = window[i - 1].close;
		const curr = window[i].close;
		if (prev != null && curr != null && prev > 0) {
			returns.push(Math.log(curr / prev));
		}
	}
	if (returns.length < 2) return 0;
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
	return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized pct
}

function slope(values: number[]): number {
	const n = values.length;
	if (n < 2) return 0;
	const meanX = (n - 1) / 2;
	const meanY = values.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let x = 0; x < n; x++) {
		num += (x - meanX) * (values[x] - meanY);
		den += (x - meanX) ** 2;
	}
	return den === 0 ? 0 : num / den;
}

// ─── Composite Signals ───────────────────────────────────────────

function techCompositeSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const buyThreshold = params.compositeThreshold ?? 65;
	const exitThreshold = params.compositeExitThreshold ?? 40;
	if (klines.length < 30) return [];
	const closes = getCloses(klines);
	const volumes = getVolumes(klines);
	const signals: Signal[] = [];
	let inPosition = false;

	for (let i = 29; i < klines.length; i++) {
		const winC = closes.slice(i - 29, i + 1).filter((c): c is number => c != null);
		const winV = volumes.slice(i - 19, i + 1).filter((v): v is number => v != null);
		if (winC.length < 30) continue;

		const sma5 = winC.slice(-5).reduce((a, b) => a + b, 0) / 5;
		const sma20 = winC.slice(-20).reduce((a, b) => a + b, 0) / 20;
		const trendScore = sma5 > sma20 ? 70 : sma5 > sma20 * 0.97 ? 50 : 30;

		const ret5d = (winC[winC.length - 1] / winC[winC.length - 6] - 1) * 100;
		const momScore = Math.min(100, Math.max(0, 50 + ret5d * 10));

		const vavg = winV.length >= 20 ? winV.slice(-20).reduce((a, b) => a + b, 0) / 20 : 1;
		const vr = (volumes[i] ?? 0) / (vavg || 1);
		const volScore = Math.min(100, Math.max(0, vr * 40 + 20));

		const rets = winC.slice(0, -1).map((c, j) => (winC[j + 1] - c) / c);
		const sq = (arr: number[]) => {
			const m = arr.reduce((a, b) => a + b, 0) / arr.length;
			return arr.reduce((s, v) => s + (v - m) ** 2, 0);
		};
		const v20 = Math.sqrt(sq(rets.slice(-20)) / 20) * Math.sqrt(252) * 100;
		const v30 = Math.sqrt(sq(rets) / rets.length) * Math.sqrt(252) * 100;
		const volaScore = v20 < v30 * 0.7 ? 70 : v20 > v30 * 1.3 ? 30 : 50;

		const comp = trendScore * 0.3 + momScore * 0.3 + volScore * 0.2 + volaScore * 0.2;
		const close = klines[i].close;
		if (close == null) continue;

		if (!inPosition && comp >= buyThreshold) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: close,
				reason: `TechComp(${comp.toFixed(0)})`,
			});
			inPosition = true;
		} else if (inPosition && comp < exitThreshold) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: close,
				reason: `TechComp(${comp.toFixed(0)})`,
			});
			inPosition = false;
		}
	}
	return signals;
}

function breakoutSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const volRatioMin = params.volRatio ?? 1.5;
	const minChange = params.minChange ?? 2;
	if (klines.length < 20) return [];
	const volumes = getVolumes(klines);
	const signals: Signal[] = [];

	for (let i = 19; i < klines.length; i++) {
		const c = klines[i];
		if (c.change_pct == null || c.volume == null) continue;
		const ct = volumes.slice(i - 19, i + 1).filter((v): v is number => v != null);
		const avg20 = ct.reduce((a, b) => a + b, 0) / (ct.length || 1);
		const vr = c.volume / (avg20 || 1);
		if (c.change_pct >= minChange && vr >= volRatioMin) {
			signals.push({
				index: i,
				date: c.date,
				type: "buy",
				price: c.close ?? c.open!,
				reason: `Breakout(+${c.change_pct.toFixed(1)}%,${vr.toFixed(1)}x)`,
			});
		}
	}
	return signals;
}

// ─── KD (Stochastic) Signals ─────────────────────────────────────

function kdSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 9;
	const smoothK = params.smoothK ?? 3;
	const smoothD = params.smoothD ?? 3;
	if (klines.length < period + Math.max(smoothK, smoothD)) return [];

	const { k, d } = cachedKD(klines, { period, smoothK, smoothD });
	const signals: Signal[] = [];

	for (let i = 1; i < klines.length; i++) {
		const kPrev = k[i - 1];
		const dPrev = d[i - 1];
		const kCurr = k[i];
		const dCurr = d[i];
		if (kPrev == null || dPrev == null || kCurr == null || dCurr == null) continue;

		if (kPrev <= dPrev && kCurr > dCurr) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: klines[i].close ?? 0,
				reason: `KD金叉(K=${kCurr.toFixed(1)},D=${dCurr.toFixed(1)})`,
			});
		} else if (kPrev >= dPrev && kCurr < dCurr) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: klines[i].close ?? 0,
				reason: `KD死叉(K=${kCurr.toFixed(1)},D=${dCurr.toFixed(1)})`,
			});
		}
	}
	return signals;
}

function kdDailySignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	return kdSignals(klines, params);
}

function getISOWeek(dateStr: string): string {
	const date = new Date(`${dateStr}T00:00:00Z`);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function buildWeeklyKlines(klines: KlineRow[]): KlineRow[] {
	const weekMap = new Map<string, KlineRow>();
	for (const k of klines) {
		const week = getISOWeek(k.date);
		const existing = weekMap.get(week);
		if (!existing) {
			weekMap.set(week, { ...k, period: "weekly" });
		} else {
			if (k.high != null && (existing.high == null || k.high > existing.high)) existing.high = k.high;
			if (k.low != null && (existing.low == null || k.low < existing.low)) existing.low = k.low;
			existing.close = k.close ?? existing.close;
			existing.volume = (existing.volume ?? 0) + (k.volume ?? 0);
			existing.date = k.date;
			existing.change_pct = k.change_pct ?? existing.change_pct;
		}
	}
	return [...weekMap.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function kdWeeklySignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const weeklyKlines = buildWeeklyKlines(klines);
	if (weeklyKlines.length < (params.period ?? 9) + Math.max(params.smoothK ?? 3, params.smoothD ?? 3)) return [];

	const dateToIndex = new Map<string, number>();
	for (let i = 0; i < klines.length; i++) {
		dateToIndex.set(klines[i].date, i);
	}

	const weeklySignals = kdSignals(weeklyKlines, params);
	const signals: Signal[] = [];
	for (const s of weeklySignals) {
		const idx = dateToIndex.get(s.date);
		if (idx != null) {
			signals.push({ ...s, index: idx });
		}
	}
	return signals;
}
// ─── MA Alignment (多头排列) ─────────────────────────────────────

function maAlignmentSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const periods = [5, 10, 20, 60];
	if (klines.length < 60) return [];
	const mas = periods.map((p) => cachedMA(klines, p).values);
	const signals: Signal[] = [];

	for (let i = 60; i < klines.length; i++) {
		const cur = mas.map((m) => m[i]);
		const prev = mas.map((m) => m[i - 1]);
		if (cur.some((v) => v == null) || prev.some((v) => v == null)) continue;

		const bullCur = cur[0]! > cur[1]! && cur[1]! > cur[2]! && cur[2]! > cur[3]!;
		const bullPrev = prev[0]! > prev[1]! && prev[1]! > prev[2]! && prev[2]! > prev[3]!;
		const bearCur = cur[0]! < cur[1]! && cur[1]! < cur[2]! && cur[2]! < cur[3]!;
		const bearPrev = prev[0]! < prev[1]! && prev[1]! < prev[2]! && prev[2]! < prev[3]!;

		if (bullCur && !bullPrev) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: klines[i].close ?? 0, reason: "MA5/10/20/60多头排列" });
		} else if (bearCur && !bearPrev) {
			signals.push({ index: i, date: klines[i].date, type: "sell", price: klines[i].close ?? 0, reason: "MA5/10/20/60空头排列" });
		}
	}
	return signals;
}

// ─── EMA Cross ──────────────────────────────────────────────────

function emaCrossSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const fast = params.fast ?? 12;
	const slow = params.slow ?? 26;
	if (klines.length < slow + 1) return [];

	const emaFast = cachedEMA(klines, fast);
	const emaSlow = cachedEMA(klines, slow);
	const signals: Signal[] = [];

	for (let i = 1; i < klines.length; i++) {
		const fPrev = emaFast[i - 1], sPrev = emaSlow[i - 1];
		const fCurr = emaFast[i], sCurr = emaSlow[i];
		if (fPrev == null || sPrev == null || fCurr == null || sCurr == null) continue;

		if (fPrev <= sPrev && fCurr > sCurr) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: klines[i].close ?? 0, reason: "EMA" + fast + "金叉EMA" + slow });
		} else if (fPrev >= sPrev && fCurr < sCurr) {
			signals.push({ index: i, date: klines[i].date, type: "sell", price: klines[i].close ?? 0, reason: "EMA" + fast + "死叉EMA" + slow });
		}
	}
	return signals;
}

// ─── Weekly Trend + Daily MA Pullback (多周期) ──────────────────

function maWeeklyTrendSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const maPeriod = params.maPeriod ?? 20;
	const weekMa = params.weekMa ?? 5;
	if (klines.length < maPeriod + 1) return [];

	const weekly = buildWeeklyKlines(klines);
	if (weekly.length < weekMa + 1) return [];

	const weekCloses = weekly.map((w) => w.close ?? 0);
	const weekMaValues: (number | null)[] = [];
	for (let i = 0; i < weekCloses.length; i++) {
		if (i < weekMa - 1) { weekMaValues.push(null); continue; }
		let sum = 0;
		for (let j = i - weekMa + 1; j <= i; j++) sum += weekCloses[j];
		weekMaValues.push(sum / weekMa);
	}

	const dailyMa = cachedMA(klines, maPeriod).values;
	const signals: Signal[] = [];

	for (let i = maPeriod; i < klines.length; i++) {
		const date = klines[i].date;
		let wIdx: number | null = null;
		for (let j = weekly.length - 1; j >= 0; j--) {
			if (weekly[j].date <= date) { wIdx = j; break; }
		}
		if (wIdx == null) continue;
		const wma = weekMaValues[wIdx];
		if (wma == null) continue;

		const weeklyBullish = weekCloses[wIdx] >= wma;
		const close = klines[i].close;
		const maVal = dailyMa[i];

		if (weeklyBullish && close != null && maVal != null && maVal > 0) {
			const touchRatio = Math.abs(close - maVal) / maVal;
			if (touchRatio <= 0.015) {
				// True pullback: previous day was clearly ABOVE the touch zone
				const prevClose = klines[i - 1]?.close;
				const prevMa = dailyMa[i - 1];
				const prevAbove = prevClose != null && prevMa != null && prevMa > 0 && (prevClose - prevMa) / prevMa > 0.015;
				if (prevAbove) {
					signals.push({ index: i, date, type: "buy", price: close, reason: "周线多头+回踩MA" + maPeriod });
				}
			}
		}
	}
	return signals;
}

// ─── Donchian Channel Breakout ─────────────────────────────────

function donchianBreakoutSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 20;
	if (klines.length < period + 1) return [];

	const signals: Signal[] = [];
	for (let i = period; i < klines.length; i++) {
		let hi = -Infinity, lo = Infinity;
		for (let j = i - period; j < i; j++) {
			if (klines[j].high != null) hi = Math.max(hi, klines[j].high!);
			if (klines[j].low != null) lo = Math.min(lo, klines[j].low!);
		}
		const close = klines[i].close ?? 0;
		const prevClose = klines[i - 1].close ?? 0;

		if (close > hi && prevClose <= hi) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: close, reason: "突破" + period + "日高点" });
		} else if (close < lo && prevClose >= lo) {
			signals.push({ index: i, date: klines[i].date, type: "sell", price: close, reason: "跌破" + period + "日低点" });
		}
	}
	return signals;
}

// ─── ROC Momentum ───────────────────────────────────────────────

function rocMomentumSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 10;
	const threshold = params.threshold ?? 5;
	if (klines.length < period + 1) return [];

	const signals: Signal[] = [];
	for (let i = period; i < klines.length; i++) {
		const prevClose = klines[i - period]?.close;
		const close = klines[i]?.close;
		if (prevClose == null || close == null || prevClose === 0) continue;
		const roc = ((close - prevClose) / prevClose) * 100;

		if (roc > threshold) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: close, reason: "ROC" + period + "动量" + roc.toFixed(1) + "%" });
		} else if (roc < -threshold) {
			signals.push({ index: i, date: klines[i].date, type: "sell", price: close, reason: "ROC" + period + "动量" + roc.toFixed(1) + "%" });
		}
	}
	return signals;
}

// ─── MACD Histogram Reversal ───────────────────────────────────

function macdHistReversalSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const macd = cachedMACD(klines, {
		fast: params.fast ?? 12,
		slow: params.slow ?? 26,
		signal: params.signal ?? 9,
	});
	const dif = macd.dif;
	const dea = macd.dea;
	if (!dif || !dea || dif.length < 2) return [];

	const signals: Signal[] = [];
	let inPosition = false;
	for (let i = 1; i < dif.length; i++) {
		const dPrev = dif[i - 1], dCurr = dif[i];
		const ePrev = dea[i - 1], eCurr = dea[i];
		if (dPrev == null || dCurr == null || ePrev == null || eCurr == null) continue;

		const histPrev = dPrev - ePrev;
		const histCurr = dCurr - eCurr;

		if (!inPosition && dPrev <= ePrev && dCurr > eCurr) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: klines[i].close ?? 0, reason: "MACD金叉" });
			inPosition = true;
		} else if (inPosition && dCurr > 0 && histCurr < histPrev) {
			signals.push({ index: i, date: klines[i].date, type: "sell", price: klines[i].close ?? 0, reason: "MACD柱状图缩短" });
			inPosition = false;
		}
	}
	return signals;
}

// ─── RSI Divergence (底背离) ───────────────────────────────────

function rsiDivergenceSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 14;
	const lookback = params.lookback ?? 20;
	if (klines.length < period + lookback) return [];

	const rsi = cachedRSI(klines, { period }).values;
	const signals: Signal[] = [];
	let inPosition = false;

	for (let i = period + lookback; i < klines.length; i++) {
		if (inPosition) continue;
		const rsiCurr = rsi[i];
		const closeCurr = klines[i]?.close;
		if (rsiCurr == null || closeCurr == null) continue;

		let priceLow = Infinity, priceLowIdx = -1, rsiLow = Infinity, rsiLowIdx = -1;
		for (let j = i - lookback; j <= i; j++) {
			const c = klines[j]?.close;
			if (c != null && c < priceLow) { priceLow = c; priceLowIdx = j; }
			const r = rsi[j];
			if (r != null && r < rsiLow) { rsiLow = r; rsiLowIdx = j; }
		}
		if (priceLowIdx < 0 || rsiLowIdx < 0) continue;

		if (closeCurr <= priceLow * 1.001 && rsiCurr > rsiLow + 3) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: closeCurr, reason: "RSI底背离(价格新低RSI未新低)" });
			inPosition = true;
		}
	}
	return signals;
}

// ─── Volume Breakout ───────────────────────────────────────────

function volumeBreakoutSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 20;
	const volPeriod = params.volPeriod ?? 10;
	const volRatio = params.volRatio ?? 1.5;
	if (klines.length < period + volPeriod) return [];

	const signals: Signal[] = [];
	for (let i = period; i < klines.length; i++) {
		let hi = -Infinity;
		for (let j = i - period; j < i; j++) {
			if (klines[j].high != null) hi = Math.max(hi, klines[j].high!);
		}
		const close = klines[i]?.close;
		const vol = klines[i]?.volume;
		if (close == null || vol == null) continue;

		let volSum = 0, volCount = 0;
		for (let j = i - volPeriod; j < i; j++) {
			if (klines[j].volume != null) { volSum += klines[j].volume!; volCount++; }
		}
		if (volCount === 0) continue;
		const avgVol = volSum / volCount;

		if (close > hi && vol > avgVol * volRatio) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: close, reason: "放量突破" + period + "日高点" });
		}
	}
	return signals;
}

// ─── Shrink Volume Pullback (缩量回踩) ─────────────────────────

function shrinkVolumePullbackSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const maPeriod = params.maPeriod ?? 20;
	const volPeriod = params.volPeriod ?? 10;
	if (klines.length < maPeriod + volPeriod) return [];

	const ma = cachedMA(klines, maPeriod).values;
	const ma10 = cachedMA(klines, 10).values;
	const signals: Signal[] = [];

	for (let i = maPeriod + volPeriod; i < klines.length; i++) {
		const close = klines[i]?.close;
		const maVal = ma[i];
		const maPrev = ma[i - 1];
		const vol = klines[i]?.volume;
		if (close == null || maVal == null || maPrev == null || vol == null) continue;

		if (maVal <= maPrev) continue;
		const ma10Val = ma10[i];
		if (ma10Val == null) continue;
		if (close > ma10Val * 1.02) continue;

		let volSum = 0, volCount = 0;
		for (let j = i - volPeriod; j < i; j++) {
			if (klines[j].volume != null) { volSum += klines[j].volume!; volCount++; }
		}
		if (volCount === 0) continue;
		const avgVol = volSum / volCount;

		if (vol < avgVol * 0.8) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: close, reason: "缩量回踩MA10" });
		}
	}
	return signals;
}

// ─── OBV Trend Confirmation ────────────────────────────────────

function obvTrendSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const period = params.period ?? 20;
	if (klines.length < period + 1) return [];

	const obv = cachedOBV(klines);
	const ma = cachedMA(klines, period).values;
	const signals: Signal[] = [];

	for (let i = period; i < klines.length; i++) {
		const obvCurr = obv[i];
		const maVal = ma[i];
		const close = klines[i]?.close;
		if (obvCurr == null || maVal == null || close == null) continue;

		let obvHi = -Infinity;
		for (let j = i - period; j < i; j++) {
			if (obv[j] != null) obvHi = Math.max(obvHi, obv[j]!);
		}
		if (obvCurr > obvHi && close > maVal) {
			signals.push({ index: i, date: klines[i].date, type: "buy", price: close, reason: "OBV创新高+站上MA" + period });
		}
	}
	return signals;
}

// ─── Harami (孕线) ─────────────────────────────────────────────

function haramiSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const minBody = params.minBodyRatio ?? 0.02;
	const signals: Signal[] = [];

	for (let i = 1; i < klines.length; i++) {
		const p = klines[i - 1], c = klines[i];
		if (p.open == null || p.close == null || c.open == null || c.close == null) continue;

		const pBody = Math.abs(p.close - p.open);
		const cBody = Math.abs(c.close - c.open);
		if (pBody < p.close * minBody || cBody > pBody * 0.6) continue;
		const inside = c.open > Math.min(p.open, p.close) && c.open < Math.max(p.open, p.close)
			&& c.close > Math.min(p.open, p.close) && c.close < Math.max(p.open, p.close);
		if (!inside) continue;

		if (p.close < p.open) {
			signals.push({ index: i, date: c.date, type: "buy", price: c.close, reason: "看涨孕线" });
		} else {
			signals.push({ index: i, date: c.date, type: "sell", price: c.close, reason: "看跌孕线" });
		}
	}
	return signals;
}

// ─── Doji Reversal (十字星反转) ────────────────────────────────

function dojiReversalSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const minBody = params.minBodyRatio ?? 0.02;
	const signals: Signal[] = [];

	for (let i = 1; i < klines.length; i++) {
		const k = klines[i];
		if (k.open == null || k.close == null || k.high == null || k.low == null) continue;

		const body = Math.abs(k.close - k.open);
		const range = k.high - k.low;
		if (range <= 0 || body > range * 0.3) continue;

		const lowerShadow = Math.min(k.open, k.close) - k.low;
		const upperShadow = k.high - Math.max(k.open, k.close);
		if (lowerShadow < body * 2 || lowerShadow < upperShadow * 1.5) continue;

		const p = klines[i - 1];
		if (p.close != null && p.open != null && p.close >= p.open) continue;

		signals.push({ index: i, date: k.date, type: "buy", price: k.close, reason: "低位十字星反转" });
	}
	return signals;
}
