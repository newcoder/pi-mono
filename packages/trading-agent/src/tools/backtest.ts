import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { runBacktest } from "../backtest/engine.js";
import { formatBacktestResult, formatTradeList } from "../backtest/report.js";
import type { BacktestResult, StrategyType } from "../backtest/types.js";
import { getDataStore } from "../data/index.js";
import type { ReportData } from "../report/generator.js";
import { generateReport } from "../report/generator.js";

const backtestParams = Type.Object({
	code: Type.String({ description: "6位股票代码，如 600519" }),
	market: Type.Optional(
		Type.Union([Type.Literal(1), Type.Literal(0)], {
			description: "1=上海 (默认), 0=深圳",
			default: 1,
		}),
	),
	strategy: Type.Union(
		[
			Type.Literal("ma_cross", { description: "MA均线金叉/死叉" }),
			Type.Literal("macd_cross", { description: "MACD金叉/死叉" }),
			Type.Literal("rsi_reversal", { description: "RSI超卖买入/超买卖出" }),
			Type.Literal("bollinger_breakout", { description: "布林带下轨反弹/上轨回落" }),
		],
		{ description: "回测策略类型" },
	),
	start: Type.Optional(Type.String({ description: "起始日期 YYYYMMDD，默认一年前" })),
	end: Type.Optional(Type.String({ description: "结束日期 YYYYMMDD，默认今天" })),
	period: Type.Optional(
		Type.Union([Type.Literal("daily"), Type.Literal("week"), Type.Literal("month")], {
			description: "K线周期",
			default: "daily",
		}),
	),
	adjust: Type.Optional(
		Type.Union([Type.Literal("bfq"), Type.Literal("qfq"), Type.Literal("hfq")], {
			description: "复权类型: bfq=不复权(默认), qfq=前复权, hfq=后复权",
			default: "bfq",
		}),
	),
	initialCapital: Type.Optional(Type.Number({ description: "初始资金，默认100000", default: 100000 })),
	positionSize: Type.Optional(Type.Number({ description: "每笔交易仓位比例 0-1，默认1.0", default: 1.0 })),
	slippage: Type.Optional(Type.Number({ description: "滑点比例，默认0.001(0.1%)", default: 0.001 })),
	commission: Type.Optional(Type.Number({ description: "手续费比例，默认0.0003(0.03%)", default: 0.0003 })),
	maxHoldingDays: Type.Optional(Type.Number({ description: "最大持仓天数，超出强制平仓" })),
	params: Type.Optional(
		Type.Record(Type.String(), Type.Number(), {
			description: "策略参数，如 {fast:5, slow:10}",
		}),
	),
	save_to_portfolio: Type.Optional(
		Type.String({
			description: "将回测交易记录保存到指定组合名称。若组合不存在则自动创建，若已存在则追加交易记录。",
		}),
	),
	portfolio_description: Type.Optional(Type.String({ description: "新建组合时的描述（save_to_portfolio 时有效）" })),
});

interface BacktestToolDetails {
	config: BacktestResult["config"];
	metrics: BacktestResult["metrics"];
	trades: BacktestResult["trades"];
	equityCurve: BacktestResult["equityCurve"];
	elapsedMs: number;
}

export const backtestStrategyTool: AgentTool<typeof backtestParams, BacktestToolDetails> = {
	name: "backtest_strategy",
	label: "回测策略",
	description:
		"对单只股票运行技术指标回测，验证策略历史表现。支持MA金叉、MACD金叉、RSI反转、布林带突破四种策略。数据从本地数据库读取。可通过 save_to_portfolio 将回测交易记录保存到组合中，以便进行组合级别的分析和跟踪。",
	parameters: backtestParams,
	execute: async (_id, params) => {
		const config = {
			code: params.code,
			market: params.market ?? 1,
			strategy: params.strategy as StrategyType,
			start: params.start,
			end: params.end,
			period: params.period ?? "daily",
			adjust: params.adjust ?? "bfq",
			initialCapital: params.initialCapital ?? 100_000,
			positionSize: params.positionSize ?? 1.0,
			slippage: params.slippage ?? 0.001,
			commission: params.commission ?? 0.0003,
			maxHoldingDays: params.maxHoldingDays,
			strategyParams: params.params,
		};

		const result = await runBacktest(config);

		let portfolioNote = "";
		if (params.save_to_portfolio) {
			const store = getDataStore();
			if (store) {
				try {
					const portfolio = await store.getPortfolioByName(params.save_to_portfolio);
					let portfolioId: number;
					if (!portfolio) {
						portfolioId = await store.createPortfolio(
							params.save_to_portfolio,
							params.initialCapital ?? 100_000,
							params.portfolio_description ?? `策略回测: ${params.code} ${params.strategy}`,
						);
						portfolioNote = `\n已新建组合 "${params.save_to_portfolio}"（ID: ${portfolioId}）并保存 ${result.trades.length} 笔交易记录。`;
					} else {
						portfolioId = portfolio.id;
						portfolioNote = `\n已追加到组合 "${params.save_to_portfolio}"（ID: ${portfolioId}），保存 ${result.trades.length} 笔交易记录。`;
					}

					for (const trade of result.trades) {
						await store.addPortfolioTrade({
							portfolio_id: portfolioId,
							trade_date: trade.entryDate,
							code: params.code,
							market: params.market ?? 1,
							direction: "buy",
							quantity: trade.shares,
							price: trade.entryPrice,
							adjust: params.adjust ?? "bfq",
							commission: 0,
							tax: 0,
							memo: `${params.strategy} 策略买入`,
						});
						await store.addPortfolioTrade({
							portfolio_id: portfolioId,
							trade_date: trade.exitDate,
							code: params.code,
							market: params.market ?? 1,
							direction: "sell",
							quantity: trade.shares,
							price: trade.exitPrice,
							adjust: params.adjust ?? "bfq",
							commission: 0,
							tax: 0,
							memo: `${params.strategy} 策略卖出 | 持仓${trade.daysHeld}天 | 盈亏${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`,
						});
					}
				} catch (err) {
					portfolioNote = `\n保存到组合失败: ${err instanceof Error ? err.message : String(err)}`;
				}
			} else {
				portfolioNote = "\n数据库未初始化，无法保存到组合。";
			}
		}

		const report = formatBacktestResult(result);
		const tradeList = formatTradeList(result.trades);

		// Auto-generate HTML report
		let reportLink = "";
		try {
			const reportData: ReportData = {
				title: `${params.code} ${params.strategy} 策略回测报告`,
				strategy: params.strategy,
				code: params.code,
				market: params.market === 1 ? "SH" : "SZ",
				startDate: result.config.start ?? result.equityCurve[0]?.date ?? params.start ?? "",
				endDate: result.config.end ?? result.equityCurve[result.equityCurve.length - 1]?.date ?? params.end ?? "",
				initialCapital: result.config.initialCapital ?? 100_000,
				equityCurve: result.equityCurve.map((p) => ({ date: p.date, equity: p.equity })),
				trades: result.trades.flatMap((t) => [
					{
						date: t.entryDate,
						code: params.code,
						direction: "buy" as const,
						quantity: t.shares,
						price: t.entryPrice,
						amount: t.entryPrice * t.shares,
						memo: `${params.strategy} 买入`,
					},
					{
						date: t.exitDate,
						code: params.code,
						direction: "sell" as const,
						quantity: t.shares,
						price: t.exitPrice,
						amount: t.exitPrice * t.shares,
						holdingDays: t.daysHeld,
						pnl: t.pnl,
						pnlPct: t.pnlPct,
						memo: `${params.strategy} 卖出 | 持仓${t.daysHeld}天`,
					},
				]),
				metrics: {
					totalReturn: result.metrics.totalReturn,
					annualizedReturn: result.metrics.annualizedReturn,
					sharpeRatio: result.metrics.sharpeRatio,
					maxDrawdown: result.metrics.maxDrawdown,
					maxDrawdownDuration: result.metrics.maxDrawdownDuration,
					winRate: result.metrics.winRate,
					profitFactor: result.metrics.profitFactor,
					avgWin: result.metrics.avgWin,
					avgLoss: result.metrics.avgLoss,
					avgHoldingDays: result.metrics.avgHoldingDays,
					totalTrades: result.trades.length,
				},
			};
			const outputDir = join(homedir(), ".trading-agent", "reports");
			const genResult = await generateReport(reportData, outputDir, "http://localhost:3000");
			reportLink = `\n\n[查看 HTML 报告](${genResult.url})`;
		} catch (err) {
			console.warn("[backtest_strategy] Auto report generation failed:", err);
		}

		return {
			content: [
				{ type: "text", text: report + portfolioNote },
				...(reportLink ? [{ type: "text" as const, text: reportLink }] : []),
				{ type: "text", text: `\n--- 全部交易记录 ---\n${tradeList}` },
			],
			details: {
				config: result.config,
				metrics: result.metrics,
				trades: result.trades,
				equityCurve: result.equityCurve,
				elapsedMs: result.elapsedMs,
				reportUrl: reportLink ? reportLink.match(/\(([^)]+)\)/)?.[1] : undefined,
			},
		};
	},
};
