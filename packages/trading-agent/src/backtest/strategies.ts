import type { KlineRow } from "../data/types.js";
import { computeMA, computeMACD, computeRSI, computeSupertrend, getCloses } from "../indicators/engine.js";
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
