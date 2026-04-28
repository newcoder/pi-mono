import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { runBacktest } from "../backtest/engine.js";
import { formatBacktestResult, formatTradeList } from "../backtest/report.js";
import type { BacktestResult, StrategyType } from "../backtest/types.js";

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
		"对单只股票运行技术指标回测，验证策略历史表现。支持MA金叉、MACD金叉、RSI反转、布林带突破四种策略。数据从本地数据库读取。",
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

		const report = formatBacktestResult(result);
		const tradeList = formatTradeList(result.trades);

		return {
			content: [
				{ type: "text", text: report },
				{ type: "text", text: `\n--- 全部交易记录 ---\n${tradeList}` },
			],
			details: {
				config: result.config,
				metrics: result.metrics,
				trades: result.trades,
				equityCurve: result.equityCurve,
				elapsedMs: result.elapsedMs,
			},
		};
	},
};
