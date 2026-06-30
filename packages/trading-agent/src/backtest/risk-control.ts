/**
 * Risk control layer — portfolio-level constraints.
 *
 * Layer separation:
 *   Strategy  → "should we buy/sell this stock?"   (signal generation)
 *   Sizing    → "how much capital?"                (position-sizing.ts)
 *   Risk      → "are we within safe limits?"        (this file)
 *   Execution → "can we fill at this price?"        (slippage, lots, limit-up)
 *
 * Risk controls operate on the ENTIRE portfolio, not per-position entry prices.
 * They answer: "given the current portfolio state, is it safe to proceed?"
 * They do NOT trigger trades — they either allow or reject proposed actions.
 */

export interface RiskControlConfig {
	/** Maximum portfolio drawdown from peak equity (percent, e.g. 20). Exceeded → go to cash. */
	maxDrawdownLimit?: number;
	/** Maximum single-position weight (fraction, e.g. 0.1). Enforced in position sizing. */
	maxPositionWeight: number;
	/** Maximum holding days per position. Enforced in daily loop force-sell. */
	maxHoldingDays: number;
	/** Minimum trade amount (yuan). Skip trades below this. */
	minTradeAmount: number;
}

export interface RiskControlState {
	peakEquity: number;
}

export function initRiskState(): RiskControlState {
	return { peakEquity: 0 };
}

/** Update peak equity and check if drawdown limit is breached. */
export function checkPortfolioRisk(
	state: RiskControlState,
	currentEquity: number,
	config: RiskControlConfig,
): { drawdownExceeded: boolean; currentDrawdown: number } {
	if (currentEquity > state.peakEquity) {
		state.peakEquity = currentEquity;
	}
	const ddFromPeak = state.peakEquity > 0 ? ((currentEquity - state.peakEquity) / state.peakEquity) * 100 : 0;

	const limit = config.maxDrawdownLimit ?? Infinity;
	return {
		drawdownExceeded: ddFromPeak < -limit,
		currentDrawdown: ddFromPeak,
	};
}
