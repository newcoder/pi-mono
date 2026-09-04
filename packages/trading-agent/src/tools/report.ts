import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { computeMetrics } from "../backtest/metrics.js";
import type { Trade } from "../backtest/types.js";
import { getDataStore } from "../data/index.js";
import { buildPortfolioEquityCurve } from "../portfolio/engine.js";
import { generateReport, type ReportData } from "../report/generator.js";

function daysBetween(startDate: string, endDate: string): number {
	const start = new Date(startDate);
	const end = new Date(endDate);
	const msPerDay = 24 * 60 * 60 * 1000;
	return Math.round((end.getTime() - start.getTime()) / msPerDay);
}

// ─── generate_report tool ───────────────────────────────────────────────────
// STRICT: This tool can ONLY render reports from real portfolio data stored in
// the local SQLite database. It never accepts raw equity curves or fabricated
// trade lists. This prevents LLM hallucination of backtest results.

const reportParams = Type.Object(
	{
		portfolio_id: Type.Optional(
			Type.Number({
				description: "组合编号（id 和 name 至少填一个）",
			}),
		),
		portfolio_name: Type.Optional(
			Type.String({
				description: "组合名称（id 和 name 至少填一个）",
			}),
		),
		start_date: Type.Optional(
			Type.String({
				description: "起始日期 YYYY-MM-DD，默认从组合创建日或最早交易日起",
			}),
		),
		end_date: Type.Optional(
			Type.String({
				description: "结束日期 YYYY-MM-DD，默认到今天",
			}),
		),
	},
	{
		description:
			"从本地数据库中的真实组合交易记录生成 HTML 报告。必须提供 portfolio_id 或 portfolio_name。工具会自动读取组合持仓、重建权益曲线、计算绩效指标并渲染报告。不允许传入自定义交易数据。",
	},
);

export const generateReportTool: AgentTool<typeof reportParams, { filePath?: string; url?: string; error?: string }> = {
	name: "generate_report",
	label: "生成组合回测报告",
	description:
		"从本地数据库中的真实组合交易记录生成独立 HTML 报告。报告包含收益曲线图、回撤曲线、月度收益热力图、关键绩效指标卡片和调仓明细表。必须提供 portfolio_id 或 portfolio_name；工具会读取组合的真实交易记录，重建权益曲线并计算指标。禁止也不支持传入自定义交易数据。",
	parameters: reportParams,
	execute: async (_id, params) => {
		if (params.portfolio_id == null && !params.portfolio_name) {
			return {
				content: [{ type: "text", text: "请提供 portfolio_id 或 portfolio_name。" }],
				details: { error: "missing portfolio_id or portfolio_name" },
			};
		}

		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "数据库未初始化，无法生成报告。" }],
				details: { error: "DataStore not initialized" },
			};
		}

		// 1. Resolve portfolio
		const portfolio =
			params.portfolio_id != null
				? await store.getPortfolioById(params.portfolio_id)
				: await store.getPortfolioByName(params.portfolio_name!);
		if (!portfolio) {
			const ref = params.portfolio_id != null ? `编号 ${params.portfolio_id}` : `"${params.portfolio_name}"`;
			return {
				content: [{ type: "text", text: `组合 ${ref} 不存在。` }],
				details: { error: "portfolio not found" },
			};
		}

		// 2. Determine date range
		const today = new Date().toISOString().slice(0, 10);
		const allTrades = await store.getPortfolioTrades(portfolio.id);
		const earliestTradeDate = allTrades.length > 0 ? allTrades[0].trade_date : undefined;
		const latestTradeDate = allTrades.length > 0 ? allTrades[allTrades.length - 1].trade_date : undefined;
		const startDate = params.start_date ?? earliestTradeDate ?? today;
		const endDate = params.end_date ?? latestTradeDate ?? today;

		// 3. Load portfolio trades and compute realized PnL per sell
		const dbTrades = await store.getPortfolioTrades(portfolio.id, startDate, endDate);
		if (dbTrades.length === 0) {
			return {
				content: [
					{ type: "text", text: `组合 "${portfolio.name}" 在 ${startDate} ~ ${endDate} 期间没有交易记录。` },
				],
				details: { error: "no trades in range" },
			};
		}

		const positions = new Map<
			string,
			{ quantity: number; avgCost: number; lots: Array<{ quantity: number; date: string }> }
		>();
		const reportTrades: ReportData["trades"] = [];
		const sellTrades: Trade[] = [];

		for (const t of dbTrades) {
			const key = `${t.code}:${t.market}`;
			const amount = t.quantity * t.price;
			const fees = (t.commission ?? 0) + (t.tax ?? 0);
			let pnl: number | undefined;
			let pnlPct: number | undefined;

			if (t.direction === "buy") {
				const pos = positions.get(key);
				if (pos) {
					const newQty = pos.quantity + t.quantity;
					pos.avgCost = (pos.quantity * pos.avgCost + amount + fees) / newQty;
					pos.quantity = newQty;
					pos.lots.push({ quantity: t.quantity, date: t.trade_date });
				} else {
					positions.set(key, {
						quantity: t.quantity,
						avgCost: (amount + fees) / t.quantity,
						lots: [{ quantity: t.quantity, date: t.trade_date }],
					});
				}
			} else {
				const pos = positions.get(key);
				if (pos && pos.quantity > 0) {
					const costBasis = t.quantity * pos.avgCost;
					pnl = amount - fees - costBasis;
					pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

					// Compute weighted average holding days from sold lots (FIFO)
					let remainingToSell = t.quantity;
					let totalDays = 0;
					let soldQty = 0;
					while (remainingToSell > 0 && pos.lots.length > 0) {
						const lot = pos.lots[0];
						const qty = Math.min(remainingToSell, lot.quantity);
						const daysHeld = Math.max(0, daysBetween(lot.date, t.trade_date));
						totalDays += daysHeld * qty;
						soldQty += qty;
						remainingToSell -= qty;
						lot.quantity -= qty;
						if (lot.quantity <= 0) pos.lots.shift();
					}
					const avgDaysHeld = soldQty > 0 ? totalDays / soldQty : 0;

					sellTrades.push({
						entryIndex: 0,
						entryDate: t.trade_date,
						entryPrice: pos.avgCost,
						exitIndex: 0,
						exitDate: t.trade_date,
						exitPrice: t.price,
						shares: t.quantity,
						pnl,
						pnlPct,
						daysHeld: Math.round(avgDaysHeld),
						result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
					});

					pos.quantity -= t.quantity;
					if (pos.quantity <= 0) positions.delete(key);
				}
			}

			reportTrades.push({
				date: t.trade_date,
				code: t.code,
				direction: t.direction,
				quantity: t.quantity,
				price: t.price,
				amount,
				pnl,
				pnlPct,
				memo: t.memo ?? (t.direction === "buy" ? "组合买入" : "组合卖出"),
			});
		}

		// 4. Build equity curve from portfolio trades
		const equityCurve = await buildPortfolioEquityCurve(portfolio.id, startDate, endDate, "close");
		if (equityCurve.length === 0) {
			return {
				content: [{ type: "text", text: "无法构建权益曲线，请确认日期范围内有行情数据。" }],
				details: { error: "no equity curve data" },
			};
		}

		// 5. Compute metrics
		const metrics = computeMetrics(sellTrades, equityCurve, portfolio.initial_cash);

		// 6. Generate report
		const reportData: ReportData = {
			title: `${portfolio.name} 组合回测报告`,
			strategy: undefined,
			code: undefined,
			market: undefined,
			startDate,
			endDate,
			initialCapital: portfolio.initial_cash,
			equityCurve: equityCurve.map((p) => ({ date: p.date, equity: p.equity })),
			trades: reportTrades,
			metrics: {
				totalReturn: metrics.totalReturn,
				annualizedReturn: metrics.annualizedReturn,
				sharpeRatio: metrics.sharpeRatio,
				maxDrawdown: metrics.maxDrawdown,
				maxDrawdownDuration: metrics.maxDrawdownDuration,
				winRate: metrics.winRate,
				profitFactor: metrics.profitFactor,
				avgWin: metrics.avgWin,
				avgLoss: metrics.avgLoss,
				avgHoldingDays: metrics.avgHoldingDays,
				totalTrades: sellTrades.length,
			},
		};

		const outputDir = join(homedir(), ".trading-agent", "reports");
		const baseUrl = "http://localhost:3000";

		try {
			const result = await generateReport(reportData, outputDir, baseUrl);
			return {
				content: [
					{
						type: "text",
						text: `组合 "${portfolio.name}" 报告已生成：[${reportData.title}](${result.url})`,
					},
				],
				details: result,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text", text: `生成报告失败：${msg}` }],
				details: { error: msg },
			};
		}
	},
};
