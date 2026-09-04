/**
 * Position sizing layer — decides how much capital to allocate per target.
 * Independence: does NOT depend on signal logic (that's the strategy layer).
 * Does NOT depend on execution (slippage, lots — that's the execution layer).
 */

import type { KlineRow } from "../data/types.js";

/** Weight calculation for a single target position */
export function computeTargetWeight(
	mode: "equal_weight" | "linear",
	rankIndex: number,
	totalTargets: number,
	totalPortfolioValue: number,
	maxPositionWeight: number,
): number {
	if (mode === "linear" && totalTargets > 0) {
		// Rank 1 gets N shares, rank N gets 1 share. Sum = N*(N+1)/2.
		const totalWeight = (totalTargets * (totalTargets + 1)) / 2;
		const linearWeight = totalTargets - rankIndex;
		const targetFraction = linearWeight / totalWeight;
		return Math.min(targetFraction * totalPortfolioValue, totalPortfolioValue * maxPositionWeight);
	}
	// equal_weight (default)
	const equalTarget = totalPortfolioValue / totalTargets;
	return Math.min(equalTarget, totalPortfolioValue * maxPositionWeight);
}

/** ATR(14) as % of current close. Annualized daily range. */
export function computeATRPct(klines: KlineRow[], dateIndex: number): number {
	const period = 14;
	if (dateIndex < period) return 0;
	let trSum = 0;
	for (let i = dateIndex - period + 1; i <= dateIndex; i++) {
		const k = klines[i];
		if (!k) continue;
		const high = k.high ?? k.close ?? 0;
		const low = k.low ?? k.close ?? 0;
		const prevClose = klines[i - 1]?.close ?? k.close ?? 0;
		const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
		trSum += tr;
	}
	const atr = trSum / period;
	const close = klines[dateIndex]?.close ?? 1;
	return close > 0 ? atr / close : 0;
}

/**
 * Scale position weight by inverse ATR ratio.
 * Stocks with above-average volatility get less capital (Kelly-inspired).
 * atrRatios: Map<code, ATR%>. Median across all targets is the baseline.
 */
export function adjustWeightByVolatility(baseWeight: number, stockATRPct: number, medianATRPct: number): number {
	if (stockATRPct <= 0 || medianATRPct <= 0) return baseWeight;
	// Inverse ratio: if stock is 2x as volatile as median, halve the weight
	const ratio = medianATRPct / stockATRPct;
	// Clamp to [0.3, 2.0] to avoid extreme adjustments
	const clamped = Math.max(0.3, Math.min(2.0, ratio));
	return baseWeight * clamped;
}
