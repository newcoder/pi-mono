import type { KlineRow } from "../data/types.js";
import { getCloses, getVolumes } from "../indicators/engine.js";
import { cachedMA, cachedMACD, cachedRSI, cachedSupertrend } from "./indicator-cache.js";
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
	drawdownSellPct?: number;
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
	const drawdownSellPct = params.drawdownSellPct ?? 0;
	if (klines.length < period + 1) return [];

	const st = cachedSupertrend(klines, { period, multiplier });
	const signals: Signal[] = [];
	let inPosition = false;
	let highestCloseSinceEntry: number | null = null;

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
			highestCloseSinceEntry = close;
			continue;
		}

		if (inPosition) {
			if (highestCloseSinceEntry != null && close > highestCloseSinceEntry) {
				highestCloseSinceEntry = close;
			}

			// 1. Supertrend death cross
			if (prevTrend === "up" && currTrend === "down") {
				signals.push({
					index: i,
					date: klines[i].date,
					type: "sell",
					price: close,
					reason: `Supertrend转空(周期${period}, 倍数${multiplier})`,
				});
				inPosition = false;
				highestCloseSinceEntry = null;
				continue;
			}

			// 2. Drawdown stop loss
			if (drawdownSellPct > 0 && highestCloseSinceEntry != null) {
				const stopPrice = highestCloseSinceEntry * (1 - drawdownSellPct / 100);
				if (close < stopPrice) {
					signals.push({
						index: i,
						date: klines[i].date,
						type: "sell",
						price: close,
						reason: `Supertrend回撤卖出(从${highestCloseSinceEntry.toFixed(2)}回撤${drawdownSellPct}%)`,
					});
					inPosition = false;
					highestCloseSinceEntry = null;
				}
			}
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

		signals.push({
			index: i,
			date: current.date,
			type: "buy",
			price: current.close,
			reason: `VolumeContraction(价跌${priceDropPct.toFixed(0)}% 量缩${((avgVolumeRecent / avgVolumePrior) * 100).toFixed(0)}% 波动${((recentVol / priorVol) * 100).toFixed(0)}%)`,
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
