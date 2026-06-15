import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { buildBenchmarkCurve, fetchIndexCurve } from "../backtest/benchmark.js";
import { runBacktest, runPoolBacktest } from "../backtest/engine.js";
import {
	formatBacktestResult,
	formatPoolBacktestResult,
	formatPoolTradeList,
	formatTradeList,
} from "../backtest/report.js";
import type { BacktestResult, PoolBacktestConfig, StrategyType } from "../backtest/types.js";
import { getDataStore } from "../data/index.js";
import type { ReportData } from "../report/generator.js";
import { generateReport } from "../report/generator.js";
import { generatePoolBacktestReport } from "../report/pool-report.js";

const backtestParams = Type.Object({
	code: Type.Optional(Type.String({ description: "6位股票代码，如 600519。与 pool_id 二选一。" })),
	market: Type.Optional(
		Type.Union([Type.Literal(1), Type.Literal(0)], {
			description: "1=上海 (默认), 0=深圳",
			default: 1,
		}),
	),
	pool_id: Type.Optional(
		Type.Number({ description: "股票池编号。提供 pool_id 时，对池中所有股票批量回测，code 参数被忽略。" }),
	),
	strategy: Type.Union(
		[
			Type.Literal("ma_cross", { description: "MA均线金叉/死叉" }),
			Type.Literal("macd_cross", { description: "MACD金叉/死叉" }),
			Type.Literal("rsi_reversal", { description: "RSI超卖买入/超买卖出" }),
			Type.Literal("bollinger_breakout", { description: "布林带下轨反弹/上轨回落" }),
			Type.Literal("supertrend", { description: "Supertrend趋势跟踪：转多买入/转空卖出" }),
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
	full_position: Type.Optional(
		Type.Boolean({
			description: "是否一直满仓。启用后每次调仓会把剩余现金用于加仓/再平衡，提高资金利用率。",
			default: false,
		}),
	),
	full_position_mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("add_to_holdings", {
					description: "把剩余现金平均加到已有持仓上（默认）。会提高集中度，收益可能更高。",
				}),
				Type.Literal("equal_weight", {
					description: "目标等权再平衡。对持仓+当日买入候选股进行买卖，使权重尽量相等，避免集中。",
				}),
			],
			{ description: "满仓模式", default: "add_to_holdings" },
		),
	),
	rebalance_threshold: Type.Optional(
		Type.Number({
			description:
				"等权再平衡触发阈值，如 0.05 表示偏离目标权重 5% 以上才调仓。仅在 full_position_mode=equal_weight 时有效。默认 0（每天严格等权）。",
			default: 0,
		}),
	),
	max_position_weight: Type.Optional(
		Type.Number({
			description: "单个标的最大权重上限，如 0.1 表示最多 10%。防止目标集合过小时 all-in 单只股票。默认 0.1。",
			default: 0.1,
		}),
	),
	min_trade_amount: Type.Optional(
		Type.Number({
			description: "最小交易金额（元），小于该金额的交易将被忽略。默认 0。强制平仓不受此限制。",
			default: 0,
		}),
	),
	slippage: Type.Optional(Type.Number({ description: "滑点比例，默认0.001(0.1%)", default: 0.001 })),
	commission: Type.Optional(Type.Number({ description: "手续费比例，默认0.0003(0.03%)", default: 0.0003 })),
	maxHoldingDays: Type.Optional(Type.Number({ description: "最大持仓天数，超出强制平仓" })),
	min_lot: Type.Optional(Type.Number({ description: "最小交易单位（股），默认100", default: 100 })),
	params: Type.Optional(
		Type.Record(Type.String(), Type.Number(), {
			description: "策略参数，如 {fast:5, slow:10}",
		}),
	),
	industry_filter: Type.Optional(
		Type.Object(
			{
				standard: Type.String({
					description: "行业分类标准，如 sw_l1",
					default: "sw_l1",
				}),
				period_days: Type.Number({
					description: "行业动量回看天数",
					default: 20,
				}),
				top_industry_count: Type.Number({
					description: "IC 高于阈值时只保留前 N 个动量行业的股票",
					default: 5,
				}),
				ic_period_days: Type.Number({
					description: "IC 滚动平均窗口",
					default: 20,
				}),
				ic_threshold: Type.Number({
					description: "IC 滚动平均阈值，超过才启用行业动量过滤",
					default: 0.05,
				}),
			},
			{
				description: "行业动量 IC 过滤：IC 高于阈值时，仅买入前 N 个动量行业的股票；否则不过滤",
			},
		),
	),
	size_filter: Type.Optional(
		Type.Object(
			{
				forward_days: Type.Number({
					description: "市值因子 IC 预测窗口，如 5 表示用 size_forward5d",
					default: 5,
				}),
				top_stock_count: Type.Number({
					description: "IC 有效时只保留市值排名头部的股票数量",
					default: 100,
				}),
				ic_period_days: Type.Number({
					description: "IC 滚动平均窗口",
					default: 20,
				}),
				ic_threshold: Type.Number({
					description:
						"IC 滚动平均阈值。direction=small 时 IC <= 阈值启用小市值过滤；direction=large 时 IC >= 阈值启用大市值过滤",
					default: -0.03,
				}),
				direction: Type.Union([Type.Literal("small"), Type.Literal("large")], {
					description: "small=买入小市值，large=买入大市值",
					default: "small",
				}),
			},
			{
				description: "市值（size）因子 IC 过滤：IC 有效时，仅买入小市值/大市值头部股票；否则不过滤",
			},
		),
	),
	save_to_portfolio: Type.Optional(
		Type.String({
			description: "将回测交易记录保存到指定组合名称。若组合不存在则自动创建，若已存在则追加交易记录。",
		}),
	),
	portfolio_description: Type.Optional(Type.String({ description: "新建组合时的描述（save_to_portfolio 时有效）" })),
	benchmark_index: Type.Optional(
		Type.String({
			description: "可选的基准指数代码，多个用逗号分隔，如 sh000905,sh000300。提供后将生成带指数对比的 HTML 报告。",
		}),
	),
	save_holdings_as_pool: Type.Optional(
		Type.Boolean({
			description: "是否将回测终点时的持仓保存为一个新的股票池。",
			default: false,
		}),
	),
});

interface BacktestToolDetails {
	config?: BacktestResult["config"] | PoolBacktestConfig;
	metrics?: BacktestResult["metrics"];
	trades?: unknown[];
	equityCurve?: BacktestResult["equityCurve"];
	stocks?: Array<{ code: string; market: number; name?: string }>;
	elapsedMs?: number;
	reportUrl?: string;
	error?: string;
	poolName?: string;
	strategy?: StrategyType;
	formattedReport?: string;
	formattedTradeList?: string;
	holdingsPoolId?: number;
	holdingsPoolName?: string;
}

export const backtestStrategyTool: AgentTool<typeof backtestParams, BacktestToolDetails> = {
	name: "backtest_strategy",
	label: "回测策略",
	description:
		"对单只股票或股票池运行技术指标回测，验证策略历史表现。支持MA金叉、MACD金叉、RSI反转、布林带突破、Supertrend趋势跟踪五种策略。提供 code 回测单只股票，或提供 pool_id 对股票池中所有股票批量回测（共享资金池、动态仓位分配、100股整数倍）。数据从本地数据库读取。可通过 save_to_portfolio 将回测交易记录保存到组合中；通过 benchmark_index 生成带指数对比的 HTML 报告；通过 save_holdings_as_pool 将回测终点持仓保存为新股池。",
	parameters: backtestParams,
	execute: async (_id, params) => {
		const isPool = params.pool_id != null;

		if (isPool) {
			// ─── Pool backtest path ─────────────────────────────────────
			const store = getDataStore();
			if (!store) {
				return {
					content: [{ type: "text", text: "数据库未初始化，无法执行回测。" }],
					details: { error: "DataStore not initialized" },
				};
			}
			const pool = await store.getStockPoolById(params.pool_id!);
			if (!pool) {
				return {
					content: [{ type: "text", text: `股票池编号 ${params.pool_id} 不存在。` }],
					details: { error: "pool not found" },
				};
			}
			const items = await store.getStockPoolItems(pool.id);
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: `股票池 "${pool.name}" 中没有股票。` }],
					details: { error: "pool empty" },
				};
			}

			const poolConfig = {
				strategy: params.strategy as StrategyType,
				start: params.start,
				end: params.end,
				period: params.period ?? "daily",
				adjust: params.adjust ?? "bfq",
				initialCapital: params.initialCapital ?? 100_000,
				positionSize: params.positionSize ?? 1.0,
				fullPosition: params.full_position ?? false,
				fullPositionMode: params.full_position_mode ?? "add_to_holdings",
				rebalanceThreshold: params.rebalance_threshold ?? 0,
				maxPositionWeight: params.max_position_weight ?? 0.1,
				minTradeAmount: params.min_trade_amount ?? 0,
				slippage: params.slippage ?? 0.001,
				commission: params.commission ?? 0.0003,
				maxHoldingDays: params.maxHoldingDays,
				minLot: params.min_lot,
				strategyParams: params.params,
				industryFilter: params.industry_filter
					? {
							standard: params.industry_filter.standard ?? "sw_l1",
							periodDays: params.industry_filter.period_days ?? 20,
							topIndustryCount: params.industry_filter.top_industry_count ?? 5,
							icPeriodDays: params.industry_filter.ic_period_days ?? 20,
							icThreshold: params.industry_filter.ic_threshold ?? 0.05,
						}
					: undefined,
				sizeFilter: params.size_filter
					? {
							forwardDays: params.size_filter.forward_days ?? 5,
							topStockCount: params.size_filter.top_stock_count ?? 100,
							icPeriodDays: params.size_filter.ic_period_days ?? 20,
							icThreshold: params.size_filter.ic_threshold ?? -0.03,
							direction: params.size_filter.direction ?? "small",
						}
					: undefined,
			};

			const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));
			const result = await runPoolBacktest(stocks, poolConfig);

			let portfolioNote = "";
			if (params.save_to_portfolio) {
				try {
					const portfolio = await store.getPortfolioByName(params.save_to_portfolio);
					let portfolioId: number;
					if (!portfolio) {
						portfolioId = await store.createPortfolio(
							params.save_to_portfolio,
							params.initialCapital ?? 100_000,
							params.portfolio_description ?? `批量回测: ${pool.name} ${params.strategy}`,
						);
						portfolioNote = `\n已新建组合 "${params.save_to_portfolio}"（ID: ${portfolioId}）并保存 ${result.trades.length} 笔交易记录。`;
					} else {
						portfolioId = portfolio.id;
						portfolioNote = `\n已追加到组合 "${params.save_to_portfolio}"（ID: ${portfolioId}），保存 ${result.trades.length} 笔交易记录。`;
					}

					const commissionRate = params.commission ?? 0.0003;
					for (const trade of result.trades) {
						await store.addPortfolioTrade({
							portfolio_id: portfolioId,
							trade_date: trade.date,
							code: trade.code,
							market: trade.market,
							direction: trade.direction,
							quantity: trade.shares,
							price: trade.price,
							adjust: params.adjust ?? "bfq",
							commission: (trade.amount ?? 0) * commissionRate,
							tax: 0,
							memo: trade.memo ?? `${params.strategy} ${trade.direction === "buy" ? "买入" : "卖出"}`,
						});
					}
				} catch (err) {
					portfolioNote = `\n保存到组合失败: ${err instanceof Error ? err.message : String(err)}`;
				}
			}

			const report = formatPoolBacktestResult(result);
			const tradeList = formatPoolTradeList(result.trades);

			// Build benchmark curves if requested
			const benchmarks = [];
			if (params.benchmark_index) {
				const symbols = params.benchmark_index
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				for (const symbol of symbols) {
					try {
						const raw = fetchIndexCurve(symbol, result.startDate, result.endDate);
						benchmarks.push(buildBenchmarkCurve(symbol, raw, result.equityCurve, result.initialCapital));
					} catch (err) {
						console.warn(`[backtest_strategy] Failed to fetch benchmark ${symbol}:`, err);
					}
				}
			}

			// Auto-generate HTML report
			let reportUrl: string | undefined;
			let reportLink = "";
			try {
				const outputDir = join(homedir(), ".trading-agent", "reports");
				const genResult = await generatePoolBacktestReport(
					{
						title: `${pool.name} ${params.strategy} 批量回测报告`,
						poolName: pool.name,
						strategy: params.strategy,
						startDate: result.startDate,
						endDate: result.endDate,
						initialCapital: result.initialCapital,
						strategyCurve: result.equityCurve.map((p) => ({ date: p.date, equity: p.equity })),
						strategyMetrics: {
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
							totalTrades: result.trades.filter((t) => t.direction === "sell").length,
						},
						benchmarks,
						trades: result.trades,
					},
					outputDir,
					"http://localhost:3000",
				);
				reportUrl = genResult.url;
				reportLink = `\n\n[查看 HTML 报告](${genResult.url})`;
			} catch (err) {
				console.warn("[backtest_strategy] Auto report generation failed:", err);
			}

			// Save final holdings as a new stock pool if requested
			let holdingsNote = "";
			let holdingsPoolId: number | undefined;
			if (params.save_holdings_as_pool) {
				try {
					const positions = new Map<string, number>();
					for (const t of result.trades) {
						const key = `${t.code}_${t.market}`;
						const current = positions.get(key) ?? 0;
						positions.set(key, t.direction === "buy" ? current + t.shares : current - t.shares);
					}

					const holdings: Array<{ code: string; market: number; name?: string }> = [];
					for (const [key, shares] of positions.entries()) {
						if (shares <= 0) continue;
						const [code, marketStr] = key.split("_");
						const market = Number(marketStr);
						const item = items.find((i) => i.code === code && i.market === market);
						holdings.push({ code, market, name: item?.name ?? undefined });
					}

					if (holdings.length > 0) {
						const holdingsPoolName = `${pool.name}_${params.strategy}_最终持仓_${result.endDate}`;
						holdingsPoolId = await store.createStockPool(
							holdingsPoolName,
							`股池 "${pool.name}" 使用 ${params.strategy} 策略回测至 ${result.endDate} 的终点持仓。`,
						);
						await store.addToStockPool(holdingsPoolId, holdings);
						holdingsNote = `\n\n已保存最终持仓为新股池 "${holdingsPoolName}"（ID: ${holdingsPoolId}），共 ${holdings.length} 只标的。`;
					} else {
						holdingsNote = "\n\n回测终点无持仓，未创建新股池。";
					}
				} catch (err) {
					holdingsNote = `\n\n保存最终持仓失败: ${err instanceof Error ? err.message : String(err)}`;
				}
			}

			const sellCount = result.trades.filter((t) => t.direction === "sell").length;
			const summaryText =
				`股池回测完成：${pool.name} / ${params.strategy}\n` +
				`区间：${result.startDate} ~ ${result.endDate}，初始资金：${result.initialCapital.toLocaleString("zh-CN")}\n` +
				`总收益：${result.metrics.totalReturn.toFixed(2)}%，年化：${result.metrics.annualizedReturn.toFixed(2)}%，` +
				`最大回撤：${result.metrics.maxDrawdown.toFixed(2)}%，胜率：${result.metrics.winRate.toFixed(2)}%，交易次数：${sellCount}` +
				portfolioNote +
				holdingsNote +
				reportLink;

			return {
				content: [{ type: "text", text: summaryText }],
				details: {
					poolName: pool.name,
					strategy: params.strategy,
					config: poolConfig,
					stocks: result.stocks,
					metrics: result.metrics,
					trades: result.trades,
					equityCurve: result.equityCurve,
					formattedReport: report,
					formattedTradeList: tradeList,
					elapsedMs: result.elapsedMs,
					reportUrl,
					holdingsPoolId,
					holdingsPoolName: holdingsPoolId
						? `${pool.name}_${params.strategy}_最终持仓_${result.endDate}`
						: undefined,
				},
			};
		}

		// ─── Single-stock backtest path ───────────────────────────────
		if (!params.code) {
			return {
				content: [{ type: "text", text: "请提供 code（股票代码）或 pool_id（股票池编号）。" }],
				details: { error: "missing code or pool_id" },
			};
		}

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

					const commissionRate = params.commission ?? 0.0003;
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
							commission: trade.shares * trade.entryPrice * commissionRate,
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
							commission: trade.shares * trade.exitPrice * commissionRate,
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
		let reportUrl: string | undefined;
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
			reportUrl = genResult.url;
			reportLink = `\n\n[查看 HTML 报告](${genResult.url})`;
		} catch (err) {
			console.warn("[backtest_strategy] Auto report generation failed:", err);
		}

		const startDate = result.config.start ?? result.equityCurve[0]?.date ?? params.start ?? "";
		const endDate = result.config.end ?? result.equityCurve[result.equityCurve.length - 1]?.date ?? params.end ?? "";
		const summaryText =
			`回测完成：${params.code} / ${params.strategy}\n` +
			`区间：${startDate} ~ ${endDate}，初始资金：${(result.config.initialCapital ?? 100_000).toLocaleString("zh-CN")}\n` +
			`总收益：${result.metrics.totalReturn.toFixed(2)}%，年化：${result.metrics.annualizedReturn.toFixed(2)}%，` +
			`最大回撤：${result.metrics.maxDrawdown.toFixed(2)}%，胜率：${result.metrics.winRate.toFixed(2)}%，交易次数：${result.trades.length}` +
			portfolioNote +
			reportLink;

		return {
			content: [{ type: "text", text: summaryText }],
			details: {
				config: result.config,
				metrics: result.metrics,
				trades: result.trades,
				equityCurve: result.equityCurve,
				formattedReport: report,
				formattedTradeList: tradeList,
				elapsedMs: result.elapsedMs,
				reportUrl,
			},
		};
	},
};
