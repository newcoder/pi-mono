import type { BacktestMetrics, EquityPoint, Trade } from "./types.js";

export function computeMetrics(trades: Trade[], equityCurve: EquityPoint[], initialCapital: number): BacktestMetrics {
	const totalTrades = trades.length;
	const winningTrades = trades.filter((t) => t.result === "win").length;
	const losingTrades = trades.filter((t) => t.result === "loss").length;
	const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

	const wins = trades.filter((t) => t.result === "win").map((t) => t.pnl);
	const losses = trades.filter((t) => t.result === "loss").map((t) => t.pnl);
	const grossProfit = wins.reduce((s, v) => s + v, 0);
	const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
	const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

	const avgWin = winningTrades > 0 ? grossProfit / winningTrades : 0;
	const avgLoss = losingTrades > 0 ? grossLoss / losingTrades : 0;

	const avgHoldingDays = totalTrades > 0 ? trades.reduce((s, t) => s + t.daysHeld, 0) / totalTrades : 0;

	// Equity curve metrics
	const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
	const totalReturn = initialCapital > 0 ? ((finalEquity - initialCapital) / initialCapital) * 100 : 0;

	// Annualized return
	const years = equityCurve.length > 1 ? equityCurve.length / 252 : 1; // approximate trading days per year
	const annualizedReturn = years > 0 ? ((1 + totalReturn / 100) ** (1 / years) - 1) * 100 : 0;

	// Max drawdown
	let maxDrawdown = 0;
	let maxDrawdownDuration = 0;
	let peak = initialCapital;
	let peakIndex = 0;
	for (let i = 0; i < equityCurve.length; i++) {
		const equity = equityCurve[i].equity;
		if (equity > peak) {
			peak = equity;
			peakIndex = i;
		}
		const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
		if (dd > maxDrawdown) {
			maxDrawdown = dd;
			maxDrawdownDuration = i - peakIndex;
		}
	}

	// Sharpe ratio from daily returns
	const dailyReturns: number[] = [];
	for (let i = 1; i < equityCurve.length; i++) {
		const prev = equityCurve[i - 1].equity;
		const curr = equityCurve[i].equity;
		if (prev > 0) {
			dailyReturns.push((curr - prev) / prev);
		}
	}
	const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length : 0;
	const variance =
		dailyReturns.length > 0 ? dailyReturns.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / dailyReturns.length : 0;
	const stdDev = Math.sqrt(variance);
	const riskFreeRate = 0.02 / 252; // 2% annual risk-free rate, daily
	const sharpeRatio = stdDev > 0 ? ((avgReturn - riskFreeRate) / stdDev) * Math.sqrt(252) : 0;

	return {
		totalReturn,
		annualizedReturn,
		sharpeRatio,
		maxDrawdown,
		maxDrawdownDuration,
		winRate,
		profitFactor,
		avgWin,
		avgLoss,
		totalTrades,
		winningTrades,
		losingTrades,
		avgHoldingDays,
	};
}
