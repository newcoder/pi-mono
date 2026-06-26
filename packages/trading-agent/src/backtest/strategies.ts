import type { KlineRow } from "../data/types.js";
import { computeMA, computeMACD, computeRSI, computeSupertrend, getCloses, getVolumes } from "../indicators/engine.js";
import type { Signal, StrategyType } from "./types.js";

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
}

export function generateSignals(klines: KlineRow[], strategy: StrategyType, params: StrategyParams = {}): Signal[] {
	switch (strategy) {
		case "ma_cross":
			return maCrossSignals(klines, params);
		case "macd_cross":
			return macdCrossSignals(klines, params);
		case "rsi_reversal":
			return rsiReversalSignals(klines, params);
		case "bollinger_breakout":
			return bollingerSignals(klines, params);
		case "supertrend":
			return supertrendSignals(klines, params);
		case "hammer":
			return hammerSignals(klines, params);
		case "bullish_engulf":
			return bullishEngulfSignals(klines, params);
		case "morning_star":
			return morningStarSignals(klines, params);
		case "three_soldiers":
			return threeSoldiersSignals(klines, params);
		case "tech_composite":
			return techCompositeSignals(klines, params);
		case "breakout":
			return breakoutSignals(klines, params);
		default:
			return [];
	}
}

function maCrossSignals(klines: KlineRow[], params: StrategyParams): Signal[] {
	const fast = params.fast ?? 5;
	const slow = params.slow ?? 10;
	if (klines.length < slow + 1) return [];

	const closes = getCloses(klines);
	const maFast = computeMA(closes, fast).values;
	const maSlow = computeMA(closes, slow).values;
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

	const closes = getCloses(klines);
	const macd = computeMACD(closes, { fast, slow, signal: signalPeriod });
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

	const closes = getCloses(klines);
	const rsi = computeRSI(closes, { period }).values;
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
	const signals: Signal[] = [];
	let inPosition = false;

	for (let i = period; i < klines.length; i++) {
		// Compute SMA and std dev for window [i-period+1, i]
		let sum = 0;
		let count = 0;
		for (let j = i - period + 1; j <= i; j++) {
			const c = closes[j];
			if (c != null) {
				sum += c;
				count++;
			}
		}
		if (count < period * 0.8) continue; // skip if too many nulls
		const sma = sum / count;

		let sqSum = 0;
		let sqCount = 0;
		for (let j = i - period + 1; j <= i; j++) {
			const c = closes[j];
			if (c != null) {
				sqSum += (c - sma) ** 2;
				sqCount++;
			}
		}
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

	const st = computeSupertrend(klines, { period, multiplier });
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

		const rets = winC.slice(1).map((c, j) => (winC[j + 1] - c) / c);
		const sq = (arr: number[]) => {
			const m = arr.reduce((a, b) => a + b, 0) / arr.length;
			return arr.reduce((s, v) => s + (v - m) ** 2, 0);
		};
		const v20 = Math.sqrt(sq(rets.slice(-20)) / 20) * Math.sqrt(252) * 100;
		const v30 = Math.sqrt(sq(rets) / rets.length) * Math.sqrt(252) * 100;
		const volaScore = v20 < v30 * 0.7 ? 70 : v20 > v30 * 1.3 ? 30 : 50;

		const comp = trendScore * 0.3 + momScore * 0.3 + volScore * 0.2 + volaScore * 0.2;
		const close = klines[i].close!;

		if (!inPosition && comp >= buyThreshold) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "buy",
				price: close,
				reason: "TechComp(" + comp.toFixed(0) + ")",
			});
			inPosition = true;
		} else if (inPosition && comp < exitThreshold) {
			signals.push({
				index: i,
				date: klines[i].date,
				type: "sell",
				price: close,
				reason: "TechComp(" + comp.toFixed(0) + ")",
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
				reason: "Breakout(+" + c.change_pct.toFixed(1) + "%," + vr.toFixed(1) + "x)",
			});
		}
	}
	return signals;
}
