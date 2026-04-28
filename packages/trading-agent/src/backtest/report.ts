import type { BacktestResult, Trade } from "./types.js";

export function formatBacktestResult(result: BacktestResult): string {
	const { config, metrics, trades, elapsedMs } = result;
	const lines: string[] = [
		`【回测报告】${config.code} ${config.strategy}`,
		`区间: ${result.klines[0]?.date ?? ""} ~ ${result.klines[result.klines.length - 1]?.date ?? ""}`,
		`初始资金: ${config.initialCapital?.toLocaleString() ?? 100_000}  数据条数: ${result.klines.length}`,
		"",
		"--- 绩效指标 ---",
		`总收益率: ${metrics.totalReturn.toFixed(2)}%`,
		`年化收益率: ${metrics.annualizedReturn.toFixed(2)}%`,
		`夏普比率: ${metrics.sharpeRatio.toFixed(2)}`,
		`最大回撤: ${metrics.maxDrawdown.toFixed(2)}%`,
		`交易次数: ${metrics.totalTrades}  胜率: ${metrics.winRate.toFixed(1)}%`,
		`盈亏比: ${metrics.profitFactor.toFixed(2)}`,
		`平均盈利: ${metrics.avgWin.toFixed(0)}  平均亏损: ${metrics.avgLoss.toFixed(0)}`,
		`平均持仓天数: ${metrics.avgHoldingDays.toFixed(1)}`,
		"",
	];

	if (trades.length > 0) {
		lines.push("--- 最近5笔交易 ---");
		const recent = trades.slice(-5);
		for (const t of recent) {
			const sign = t.pnl >= 0 ? "+" : "";
			lines.push(
				`${t.entryDate} → ${t.exitDate} | 持仓${t.daysHeld}天 | ${sign}${t.pnl.toFixed(0)} (${sign}${t.pnlPct.toFixed(2)}%)`,
			);
		}
		lines.push("");
	}

	lines.push(formatEquityCurve(result));
	lines.push(`\n(回测耗时: ${elapsedMs}ms)`);

	return lines.join("\n");
}

function formatEquityCurve(result: BacktestResult): string {
	const { equityCurve, config } = result;
	if (equityCurve.length < 2) return "";

	const initial = config.initialCapital ?? 100_000;
	const values = equityCurve.map((e) => e.equity);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;

	// Sample ~60 points for display
	const step = Math.max(1, Math.floor(values.length / 60));
	const sampled: number[] = [];
	for (let i = 0; i < values.length; i += step) {
		sampled.push(values[i]);
	}
	if (sampled[sampled.length - 1] !== values[values.length - 1]) {
		sampled.push(values[values.length - 1]);
	}

	const height = 10;
	const rows: string[] = [];
	for (let h = height; h >= 0; h--) {
		const threshold = min + (range * h) / height;
		let line = "";
		for (const v of sampled) {
			line += v >= threshold ? "*" : " ";
		}
		// Only show y-axis labels on top, middle, bottom
		const label =
			h === height
				? `${(max / initial).toFixed(2)}x `.padStart(6)
				: h === Math.floor(height / 2)
					? `${((min + range / 2) / initial).toFixed(2)}x `.padStart(6)
					: h === 0
						? `${(min / initial).toFixed(2)}x `.padStart(6)
						: "       ";
		rows.push(label + line);
	}

	return `--- 资金曲线 ---\n${rows.join("\n")}`;
}

export function formatTradeList(trades: Trade[]): string {
	if (trades.length === 0) return "无交易记录。";
	const lines = trades.map((t, i) => {
		const sign = t.pnl >= 0 ? "+" : "";
		return `${i + 1}. ${t.entryDate} 买入@${t.entryPrice.toFixed(2)} → ${t.exitDate} 卖出@${t.exitPrice.toFixed(2)} | ${sign}${t.pnl.toFixed(0)} (${sign}${t.pnlPct.toFixed(2)}%) | ${t.daysHeld}天`;
	});
	return lines.join("\n");
}
