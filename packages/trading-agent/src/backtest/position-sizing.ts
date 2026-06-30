/**
 * Position sizing layer — decides how much capital to allocate per target.
 * Independence: does NOT depend on signal logic (that's the strategy layer).
 * Does NOT depend on execution (slippage, lots — that's the execution layer).
 */

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
		const linearWeight = totalTargets - rankIndex; // rankIndex is 0-based
		const targetFraction = linearWeight / totalWeight;
		return Math.min(targetFraction * totalPortfolioValue, totalPortfolioValue * maxPositionWeight);
	}
	// equal_weight (default)
	const equalTarget = totalPortfolioValue / totalTargets;
	return Math.min(equalTarget, totalPortfolioValue * maxPositionWeight);
}

/** Check if a position should be trimmed (overweight) */
export function isOverweight(currentValue: number, targetValue: number, rebalanceThreshold: number): boolean {
	return currentValue > targetValue && currentValue - targetValue > targetValue * rebalanceThreshold;
}

/** Check if a position should be topped up (underweight) */
export function isUnderweight(currentValue: number, targetValue: number, rebalanceThreshold: number): boolean {
	const deficit = targetValue - currentValue;
	return deficit > targetValue * rebalanceThreshold;
}
