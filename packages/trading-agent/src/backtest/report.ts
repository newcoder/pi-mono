import type { BacktestResult, PoolBacktestResult, PoolTrade, Trade } from "./types.js";

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

// ─── Pool Backtest Report ─────────────────────────────────────────

export function formatPoolBacktestResult(result: PoolBacktestResult): string {
	const { stocks, strategy, startDate, endDate, initialCapital, metrics, trades, elapsedMs } = result;
	const lines: string[] = [
		`【批量回测报告】${strategy} — ${stocks.length}只股票`,
		`区间: ${startDate} ~ ${endDate}`,
		`初始资金: ${initialCapital.toLocaleString("zh-CN")}  股票数: ${stocks.length}  总交易: ${trades.length}`,
		"",
		"--- 总体绩效 ---",
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

	// Per-stock summary
	const stockStats = new Map<
		string,
		{ buys: number; sells: number; win: number; loss: number; pnl: number; days: number }
	>();
	for (const s of stocks) {
		stockStats.set(s.code, { buys: 0, sells: 0, win: 0, loss: 0, pnl: 0, days: 0 });
	}
	for (const t of trades) {
		const stat = stockStats.get(t.code);
		if (!stat) continue;
		if (t.direction === "buy") stat.buys++;
		if (t.direction === "sell") {
			stat.sells++;
			stat.pnl += t.pnl ?? 0;
			stat.days += t.daysHeld ?? 0;
			if (t.result === "win") stat.win++;
			if (t.result === "loss") stat.loss++;
		}
	}

	lines.push("--- 各股票表现 ---");
	lines.push(
		`${"股票".padEnd(12)} ${"买入".padStart(4)} ${"卖出".padStart(4)} ${"胜率".padStart(6)} ${"总盈亏".padStart(10)} ${"均持仓".padStart(6)}`,
	);
	for (const [code, stat] of stockStats) {
		const winRate = stat.sells > 0 ? `${((stat.win / stat.sells) * 100).toFixed(1)}%` : "-";
		const avgDays = stat.sells > 0 ? (stat.days / stat.sells).toFixed(1) : "-";
		const pnlStr = (stat.pnl >= 0 ? "+" : "") + stat.pnl.toFixed(0);
		lines.push(
			`${code.padEnd(12)} ${String(stat.buys).padStart(4)} ${String(stat.sells).padStart(4)} ${winRate.padStart(6)} ${pnlStr.padStart(10)} ${avgDays.padStart(6)}`,
		);
	}
	lines.push("");

	// Recent trades
	if (trades.length > 0) {
		lines.push("--- 最近10笔交易 ---");
		const recent = trades.slice(-10);
		for (const t of recent) {
			if (t.direction === "buy") {
				lines.push(
					`${t.date} | ${t.code} | 买入 ${t.shares}股 @${t.price.toFixed(2)} | 金额 ${t.amount.toFixed(0)}`,
				);
			} else {
				const sign = (t.pnl ?? 0) >= 0 ? "+" : "";
				lines.push(
					`${t.date} | ${t.code} | 卖出 ${t.shares}股 @${t.price.toFixed(2)} | ${sign}${(t.pnl ?? 0).toFixed(0)} (${sign}${(t.pnlPct ?? 0).toFixed(2)}%) | ${t.daysHeld ?? 0}天`,
				);
			}
		}
		lines.push("");
	}

	lines.push(formatPoolEquityCurve(result));
	lines.push(`\n(回测耗时: ${elapsedMs}ms)`);

	return lines.join("\n");
}

function formatPoolEquityCurve(result: PoolBacktestResult): string {
	const { equityCurve, initialCapital } = result;
	if (equityCurve.length < 2) return "";

	const values = equityCurve.map((e) => e.equity);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;

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
		const label =
			h === height
				? `${(max / initialCapital).toFixed(2)}x `.padStart(6)
				: h === Math.floor(height / 2)
					? `${((min + range / 2) / initialCapital).toFixed(2)}x `.padStart(6)
					: h === 0
						? `${(min / initialCapital).toFixed(2)}x `.padStart(6)
						: "       ";
		rows.push(label + line);
	}

	return `--- 合并资金曲线 ---\n${rows.join("\n")}`;
}

export function formatPoolTradeList(trades: PoolTrade[]): string {
	if (trades.length === 0) return "无交易记录。";
	const lines = trades.map((t, i) => {
		if (t.direction === "buy") {
			return `${i + 1}. ${t.date} ${t.code} 买入 ${t.shares}股 @${t.price.toFixed(2)} 金额 ${t.amount.toFixed(0)}`;
		}
		const sign = (t.pnl ?? 0) >= 0 ? "+" : "";
		return `${i + 1}. ${t.date} ${t.code} 卖出 ${t.shares}股 @${t.price.toFixed(2)} | ${sign}${(t.pnl ?? 0).toFixed(0)} (${sign}${(t.pnlPct ?? 0).toFixed(2)}%) | ${t.daysHeld ?? 0}天`;
	});
	return lines.join("\n");
}
