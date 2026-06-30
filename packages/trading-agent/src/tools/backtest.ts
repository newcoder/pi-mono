import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { buildBenchmarkCurve, fetchIndexCurve } from "../backtest/benchmark.js";
import { runBacktest, runDynamicPoolBacktest, runPoolBacktest } from "../backtest/engine.js";
import {
	formatBacktestResult,
	formatPoolBacktestResult,
	formatPoolTradeList,
	formatTradeList,
} from "../backtest/report.js";
import type { BacktestResult, PoolBacktestConfig, StrategyType } from "../backtest/types.js";
import { getDataStore } from "../data/index.js";
import type { ReportBenchmark, ReportData } from "../report/generator.js";
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
		Type.Number({ description: "静态股票池编号。提供 pool_id 时，对池中所有股票批量回测，code 参数被忽略。" }),
	),
	dynamic_pool_id: Type.Optional(
		Type.Number({ description: "动态股票池编号。成分股按交易日变化；与 pool_id、code 互斥。" }),
	),
	strategy: Type.Union(
		[
			Type.Literal("ma_cross", { description: "MA均线金叉/死叉" }),
			Type.Literal("macd_cross", { description: "MACD金叉/死叉" }),
			Type.Literal("rsi_reversal", { description: "RSI超卖买入/超买卖出" }),
			Type.Literal("bollinger_breakout", { description: "布林带下轨反弹/上轨回落" }),
			Type.Literal("supertrend", { description: "Supertrend趋势跟踪：转多买入/转空卖出" }),
			Type.Literal("hammer", { description: "锤子线反转：长下影+小实体，前日阴线" }),
			Type.Literal("bullish_engulf", { description: "阳包阴：阳线实体完全吞没前日阴线" }),
			Type.Literal("morning_star", { description: "晨星：大阴→小星→大阳，底部反转" }),
			Type.Literal("three_soldiers", { description: "红三兵：连续三阳，逐步放量" }),
			Type.Literal("tech_composite", { description: "技术综合打分：趋势+动量+量能+波动率四维评分" }),
			Type.Literal("breakout", { description: "突破买入：放量上涨，量比阈值+涨幅阈值" }),
			Type.Literal("volume_contraction", { description: "缩量调整：价格下跌+成交量萎缩+波动率收敛后买入" }),
			Type.Literal("shooting_star", { description: "流星线反转：长上影+小实体，顶部卖出信号" }),
			Type.Literal("bearish_engulf", { description: "阴包阳：阴线实体完全吞没前日阳线，卖出信号" }),
			Type.Literal("evening_star", { description: "暮星：大阳→小星→大阴，顶部反转卖出信号" }),
			Type.Literal("three_crows", { description: "三只乌鸦：连续三阴，逐步下跌，卖出信号" }),
			Type.Literal("rsi_overbought_sell", { description: "RSI超买回落：RSI从超买区下穿，卖出信号" }),
			Type.Literal("time_exit", { description: "定时换仓：每N个交易日强制卖出，用作固定周期再平衡" }),
			Type.Literal("always_buy", { description: "每日全买入：用于排序测试，每天给所有股票发买入信号" }),
		],
		{ description: "回测策略类型" },
	),
	exit_strategy: Type.Optional(
		Type.Union(
			[
				Type.Literal("ma_cross", { description: "MA均线死叉" }),
				Type.Literal("macd_cross", { description: "MACD死叉" }),
				Type.Literal("rsi_reversal", { description: "RSI超买回落" }),
				Type.Literal("bollinger_breakout", { description: "布林带上轨回落" }),
				Type.Literal("supertrend", { description: "Supertrend转空" }),
				Type.Literal("shooting_star", { description: "流星线反转" }),
				Type.Literal("bearish_engulf", { description: "阴包阳" }),
				Type.Literal("evening_star", { description: "暮星" }),
				Type.Literal("three_crows", { description: "三只乌鸦" }),
				Type.Literal("rsi_overbought_sell", { description: "RSI超买回落" }),
				Type.Literal("time_exit", { description: "定时换仓：每N个交易日强制卖出" }),
			],
			{ description: "独立的卖出信号策略，与主策略买入信号配合作为退出条件；不生成买入信号" },
		),
	),
	exit_params: Type.Optional(
		Type.Record(Type.String(), Type.Number(), {
			description: "退出策略参数，如 {fast:5, slow:10} 或 {period:14, overbought:70}",
		}),
	),
	buy_strategies: Type.Optional(
		Type.Array(
			Type.Object({
				strategy: Type.Union([
					Type.Literal("ma_cross"),
					Type.Literal("macd_cross"),
					Type.Literal("rsi_reversal"),
					Type.Literal("bollinger_breakout"),
					Type.Literal("supertrend"),
					Type.Literal("hammer"),
					Type.Literal("bullish_engulf"),
					Type.Literal("morning_star"),
					Type.Literal("three_soldiers"),
					Type.Literal("tech_composite"),
					Type.Literal("breakout"),
					Type.Literal("volume_contraction"),
					Type.Literal("always_buy"),
				]),
				params: Type.Optional(Type.Record(Type.String(), Type.Number())),
			}),
			{ description: "买入信号源列表，任意一个触发即买入；自动双向指标只取买入信号" },
		),
	),
	sell_strategies: Type.Optional(
		Type.Array(
			Type.Object({
				strategy: Type.Union([
					Type.Literal("ma_cross"),
					Type.Literal("macd_cross"),
					Type.Literal("rsi_reversal"),
					Type.Literal("bollinger_breakout"),
					Type.Literal("supertrend"),
					Type.Literal("shooting_star"),
					Type.Literal("bearish_engulf"),
					Type.Literal("evening_star"),
					Type.Literal("three_crows"),
					Type.Literal("rsi_overbought_sell"),
					Type.Literal("time_exit"),
				]),
				params: Type.Optional(Type.Record(Type.String(), Type.Number())),
			}),
			{ description: "卖出信号源列表，任意一个触发即卖出；自动双向指标只取卖出信号" },
		),
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
			description: "是否一直满仓。启用后每次调仓会把剩余现金用于加仓/再平衡，提高资金利用率。默认 true。",
			default: true,
		}),
	),
	full_position_mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("add_to_holdings", {
					description: "买入新目标仓位后，把剩余现金平均加到已有持仓上。会提高集中度，收益可能更高。",
				}),
				Type.Literal("equal_weight", {
					description:
						"目标等权再平衡。对持仓+当日买入候选股进行买卖，使权重尽量相等，避免集中。默认 equal_weight。",
				}),
			],
			{ description: "满仓模式", default: "equal_weight" },
		),
	),
	rebalance_threshold: Type.Optional(
		Type.Number({
			description:
				"等权再平衡触发阈值，如 0.05 表示偏离目标权重 5% 以上才调仓。仅在 full_position_mode=equal_weight 时有效。默认 0（每天严格等权）。",
			default: 0,
		}),
	),
	rebalance_frequency: Type.Optional(
		Type.Number({
			description:
				"调仓频率（交易日）。如 5 表示每 5 个交易日才根据排名调仓一次，期间只处理卖出信号/强制平仓/调出股池，不平换仓。用于配合 always_buy 做固定周期排序测试。默认 1（每天调仓）。",
			default: 1,
		}),
	),
	rebalance_full_portfolio: Type.Optional(
		Type.Boolean({
			description:
				"配合 rebalance_frequency 使用。为 true 时，在调仓日先强制卖出全部持仓，再按排名重新买入目标组合，实现固定周期的全仓换仓。默认 false。",
			default: false,
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
	tax_rate: Type.Optional(Type.Number({ description: "印花税比例，仅卖出时扣除，默认0", default: 0 })),
	transfer_fee: Type.Optional(Type.Number({ description: "过户费比例，买卖双向，默认0", default: 0 })),
	skip_no_volume: Type.Optional(
		Type.Boolean({ description: "是否跳过成交量为0或价格缺失的交易日（停牌），默认true", default: true }),
	),
	maxHoldingDays: Type.Optional(Type.Number({ description: "最大持仓天数，超出强制平仓" })),
	stop_loss_pct: Type.Optional(Type.Number({ description: "止损比例，如 5 表示从入场价下跌 5% 时强制卖出" })),
	take_profit_pct: Type.Optional(Type.Number({ description: "止盈比例，如 20 表示从入场价上涨 20% 时强制卖出" })),
	trailing_stop_pct: Type.Optional(
		Type.Number({ description: "移动止损比例，如 10 表示从持仓期间最高点回撤 10% 时强制卖出" }),
	),
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

	rank_by: Type.Optional(
		Type.Union(
			[
				Type.Literal("momentum", { description: "按涨跌幅排序，追涨" }),
				Type.Literal("value", { description: "按价格倒数排序，买便宜" }),
				Type.Literal("turnover", { description: "按换手率排序，买活跃" }),
				Type.Literal("technical", { description: "按技术综合分排序" }),
				Type.Literal("low_volatility", { description: "按近期收益率波动排序，波动低的排前面" }),
				Type.Literal("signal_recency", { description: "按买入信号产生时间排序，越近的排前面" }),
				Type.Literal("ma_alignment", { description: "按10/20/60日均线多头排列强度排序，越强越靠前" }),
				Type.Literal("weekly_ma_alignment", { description: "按5/10/20周均线多头排列强度排序，越强越靠前" }),
				Type.Literal("random", { description: "随机选择，多次运行取平均" }),
			],
			{ description: "买入候选的二级排序因子" },
		),
	),
	max_positions: Type.Optional(
		Type.Number({
			description: "最大同时持仓数，只买入排名前N的",
		}),
	),
	volatility_lookback_days: Type.Optional(
		Type.Number({
			description: "low_volatility 排序时回看交易日天数，默认 5",
			default: 5,
		}),
	),

	random_runs: Type.Optional(
		Type.Number({
			description: "随机选择时运行次数，>1时多次采样取中位数",
			default: 1,
		}),
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
		"对单只股票或股票池运行技术指标回测，验证策略历史表现。支持MA均线金叉/死叉、MACD金叉/死叉、RSI超卖买入/超买卖出、布林带下轨反弹/上轨回落、Supertrend趋势跟踪、锤子线反转、阳包阴、晨星、红三兵、技术综合打分、突破买入、缩量调整、流星线、阴包阳、暮星、三只乌鸦、RSI超买回落、定时换仓、每日全买入共19种策略。可通过 buy_strategies/sell_strategies 分别配置多个买入/卖出信号源，任意一个触发即买卖；自动双向指标（ma_cross/macd_cross/rsi_reversal/bollinger_breakout/supertrend/tech_composite）在买入列表里只取买入信号，在卖出列表里只取卖出信号。time_exit 为纯卖出策略，每 period 个交易日强制卖出，可用于固定周期再平衡；always_buy 每天给所有股票发出买入信号，常用于排序能力测试。旧的 strategy/exit_strategy 仍兼容。提供 code 回测单只股票，或提供 pool_id 对股票池中所有股票批量回测（共享资金池、动态仓位分配、100股整数倍）。数据从本地数据库读取。可通过 save_to_portfolio 将回测交易记录保存到组合中；通过 benchmark_index 生成带指数对比的 HTML 报告；通过 save_holdings_as_pool 将回测终点持仓保存为新股池。",
	parameters: backtestParams,
	execute: async (_id, params) => {
		// ── Input validation ──────────────────────────────────────
		const minLot = params.min_lot ?? 100;
		if (minLot <= 0) {
			return {
				content: [{ type: "text", text: "参数错误: min_lot 必须大于 0。" }],
				details: { error: `invalid min_lot: ${minLot}` },
			};
		}
		const rf = params.rebalance_frequency;
		if (rf != null && rf < 1) {
			return {
				content: [{ type: "text", text: "参数错误: rebalance_frequency 必须 >= 1（交易日）。" }],
				details: { error: `invalid rebalance_frequency: ${rf}` },
			};
		}
		if (params.industry_filter) {
			const ic = params.industry_filter.ic_period_days;
			if (ic != null && ic < 1) {
				return {
					content: [{ type: "text", text: "参数错误: industry_filter.ic_period_days 必须 >= 1。" }],
					details: { error: `invalid ic_period_days: ${ic}` },
				};
			}
		}
		if (params.size_filter) {
			const ic = params.size_filter.ic_period_days;
			if (ic != null && ic < 1) {
				return {
					content: [{ type: "text", text: "参数错误: size_filter.ic_period_days 必须 >= 1。" }],
					details: { error: `invalid ic_period_days: ${ic}` },
				};
			}
		}

		const isStaticPool = params.pool_id != null;
		const isDynamicPool = params.dynamic_pool_id != null;
		const isPool = isStaticPool || isDynamicPool;

		if (isPool) {
			// ─── Pool backtest path ─────────────────────────────────────
			const store = getDataStore();
			if (!store) {
				return {
					content: [{ type: "text", text: "数据库未初始化，无法执行回测。" }],
					details: { error: "DataStore not initialized" },
				};
			}
			const poolId = isDynamicPool ? params.dynamic_pool_id! : params.pool_id!;
			const pool = await store.getStockPoolById(poolId);
			if (!pool) {
				return {
					content: [{ type: "text", text: `股票池编号 ${poolId} 不存在。` }],
					details: { error: "pool not found" },
				};
			}
			let items: Array<{ code: string; market: number; name: string | null; added_at: string }> = [];
			if (isStaticPool) {
				items = await store.getStockPoolItems(pool.id);
				if (items.length === 0) {
					return {
						content: [{ type: "text", text: `股票池 "${pool.name}" 中没有股票。` }],
						details: { error: "pool empty" },
					};
				}
			}

			const poolConfig = {
				strategy: params.strategy as StrategyType,
				exitStrategy: params.exit_strategy as StrategyType | undefined,
				exitStrategyParams: params.exit_params,
				buyStrategies: params.buy_strategies?.map((s) => ({ strategy: s.strategy, params: s.params })),
				sellStrategies: params.sell_strategies?.map((s) => ({ strategy: s.strategy, params: s.params })),
				start: params.start,
				end: params.end,
				period: params.period ?? "daily",
				adjust: params.adjust ?? "bfq",
				initialCapital: params.initialCapital ?? 100_000,
				positionSize: params.positionSize ?? 1.0,
				fullPosition: params.full_position ?? true,
				fullPositionMode: params.full_position_mode ?? "equal_weight",
				rebalanceThreshold: params.rebalance_threshold ?? 0,
				rebalanceFrequency: params.rebalance_frequency ?? 1,
				rebalanceFullPortfolio: params.rebalance_full_portfolio ?? false,
				maxPositionWeight: params.max_position_weight ?? 0.1,
				minTradeAmount: params.min_trade_amount ?? 0,
				slippage: params.slippage ?? 0.001,
				commission: params.commission ?? 0.0003,
				taxRate: params.tax_rate ?? 0,
				transferFee: params.transfer_fee ?? 0,
				maxHoldingDays: params.maxHoldingDays,
				skipNoVolume: params.skip_no_volume ?? true,
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
				rankBy: params.rank_by as
					| "momentum"
					| "value"
					| "turnover"
					| "technical"
					| "low_volatility"
					| "signal_recency"
					| "ma_alignment"
					| undefined,
				maxPositions: params.max_positions,
				randomRuns: params.random_runs,
				volatilityLookbackDays: params.volatility_lookback_days,
			};

			const result = isDynamicPool
				? await runDynamicPoolBacktest(pool.id, poolConfig)
				: await runPoolBacktest(
						items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined })),
						poolConfig,
					);

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
					const transferFeeRate = params.transfer_fee ?? 0;
					const taxRate = params.tax_rate ?? 0;
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
							commission: (trade.amount ?? 0) * (commissionRate + transferFeeRate),
							tax: trade.direction === "sell" ? (trade.amount ?? 0) * taxRate : 0,
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
					// Build a name lookup from both static pool items and result stocks (covers dynamic pools)
					const nameMap = new Map<string, string | null | undefined>();
					for (const item of items) nameMap.set(`${item.code}_${item.market}`, item.name);
					for (const s of result.stocks) {
						const key = `${s.code}_${s.market}`;
						if (!nameMap.has(key)) nameMap.set(key, s.name);
					}
					for (const [key, shares] of positions.entries()) {
						if (shares <= 0) continue;
						const [code, marketStr] = key.split("_");
						const market = Number(marketStr);
						holdings.push({ code, market, name: nameMap.get(key) ?? undefined });
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
				content: [
					{
						type: "text",
						text: "请提供 code（股票代码）、pool_id（静态股票池编号）或 dynamic_pool_id（动态股票池编号）。",
					},
				],
				details: { error: "missing code or pool_id" },
			};
		}

		const config = {
			code: params.code,
			market: params.market ?? 1,
			strategy: params.strategy as StrategyType,
			exitStrategy: params.exit_strategy as StrategyType | undefined,
			exitStrategyParams: params.exit_params,
			buyStrategies: params.buy_strategies?.map((s) => ({ strategy: s.strategy, params: s.params })),
			sellStrategies: params.sell_strategies?.map((s) => ({ strategy: s.strategy, params: s.params })),
			start: params.start,
			end: params.end,
			period: params.period ?? "daily",
			adjust: params.adjust ?? "bfq",
			initialCapital: params.initialCapital ?? 100_000,
			positionSize: params.positionSize ?? 1.0,
			slippage: params.slippage ?? 0.001,
			commission: params.commission ?? 0.0003,
			taxRate: params.tax_rate ?? 0,
			transferFee: params.transfer_fee ?? 0,
			maxHoldingDays: params.maxHoldingDays,
			stopLossPct: params.stop_loss_pct,
			takeProfitPct: params.take_profit_pct,
			trailingStopPct: params.trailing_stop_pct,
			skipNoVolume: params.skip_no_volume ?? true,
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
					const transferFeeRate = params.transfer_fee ?? 0;
					const taxRate = params.tax_rate ?? 0;
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
							commission: trade.shares * trade.entryPrice * (commissionRate + transferFeeRate),
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
							commission: trade.shares * trade.exitPrice * (commissionRate + transferFeeRate),
							tax: trade.shares * trade.exitPrice * taxRate,
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

			// Build benchmark curves if requested
			const benchmarks: ReportBenchmark[] = [];
			if (params.benchmark_index) {
				const symbols = params.benchmark_index
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				for (const symbol of symbols) {
					try {
						const raw = fetchIndexCurve(symbol, reportData.startDate, reportData.endDate);
						benchmarks.push(buildBenchmarkCurve(symbol, raw, reportData.equityCurve, reportData.initialCapital));
					} catch (err) {
						console.warn(`[backtest_strategy] Failed to fetch benchmark ${symbol}:`, err);
					}
				}
				reportData.benchmarks = benchmarks;
			}

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
