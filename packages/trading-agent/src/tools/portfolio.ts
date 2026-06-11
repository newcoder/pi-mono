import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { computeMetrics } from "../backtest/metrics.js";
import { getDataStore } from "../data/index.js";
import type { PortfolioRow, PortfolioTradeRow } from "../data/types.js";
import { buildPortfolioEquityCurve, computePortfolioValue, replayHoldings } from "../portfolio/engine.js";

const portfolioParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create", { description: "创建新组合" }),
			Type.Literal("list", { description: "列出所有组合" }),
			Type.Literal("show", { description: "显示组合详情（持仓+现金）" }),
			Type.Literal("delete", { description: "删除组合" }),
			Type.Literal("trade", { description: "记录一笔交易" }),
			Type.Literal("history", { description: "显示交易历史" }),
			Type.Literal("value", { description: "计算组合在某日期的总价值" }),
			Type.Literal("backtest", { description: "基于交易记录生成权益曲线和绩效指标" }),
		],
		{ description: "操作类型" },
	),
	id: Type.Optional(
		Type.Number({
			description: "组合编号（show/delete/trade/history/value/backtest 时使用，与 name 二选一，优先 id）",
		}),
	),
	name: Type.Optional(Type.String({ description: "组合名称（create 必填，其他可选，与 id 二选一）" })),
	description: Type.Optional(Type.String({ description: "组合描述（create 时可选）" })),
	initial_cash: Type.Optional(Type.Number({ description: "初始资金（create 时必填）" })),
	trade_date: Type.Optional(Type.String({ description: "交易日期 YYYY-MM-DD（trade 时必填）" })),
	code: Type.Optional(Type.String({ description: "股票代码（trade 时必填）" })),
	market: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(0)], { description: "1=上海, 0=深圳" })),
	direction: Type.Optional(
		Type.Union([Type.Literal("buy"), Type.Literal("sell")], { description: "交易方向（trade 时必填）" }),
	),
	quantity: Type.Optional(Type.Number({ description: "交易数量（trade 时必填）" })),
	price: Type.Optional(Type.Number({ description: "成交价格（trade 时必填）" })),
	adjust: Type.Optional(
		Type.Union([Type.Literal("bfq"), Type.Literal("qfq"), Type.Literal("hfq")], { default: "bfq" }),
	),
	commission: Type.Optional(Type.Number({ description: "手续费（trade 时可选）" })),
	tax: Type.Optional(Type.Number({ description: "印花税（trade 时可选）" })),
	memo: Type.Optional(Type.String({ description: "备注（trade 时可选）" })),
	date: Type.Optional(Type.String({ description: "查询日期 YYYY-MM-DD（value 时可选，默认今天）" })),
	start_date: Type.Optional(Type.String({ description: "起始日期 YYYY-MM-DD（backtest/history 时可选）" })),
	end_date: Type.Optional(Type.String({ description: "结束日期 YYYY-MM-DD（backtest/history 时可选）" })),
	price_mode: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("close")], { default: "close", description: "估值价格类型" }),
	),
});

interface PortfolioToolDetails {
	portfolio?: PortfolioRow;
	portfolios?: PortfolioRow[];
	trades?: PortfolioTradeRow[];
	value?: unknown;
	curve?: unknown;
	metrics?: unknown;
	tradeId?: number;
	deleted?: number;
	cash?: number;
	holdings?: Array<{ code: string; market: number; quantity: number; avgCost: number; totalCost: number }>;
	available?: number;
	error?: string;
}

async function findPortfolio(store: any, id?: number, name?: string): Promise<PortfolioRow | null> {
	if (id !== undefined && id !== null) {
		return store.getPortfolioById(id);
	}
	if (name) {
		return store.getPortfolioByName(name);
	}
	return null;
}

function formatPortfolioList(portfolios: PortfolioRow[]): string {
	if (portfolios.length === 0) return "暂无组合。";
	const lines = ["【组合列表】", ""];
	for (const p of portfolios) {
		lines.push(
			`[${p.id}] ${p.name} — 初始资金: ${p.initial_cash.toLocaleString()}${p.description ? ` (${p.description})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatPortfolioDetail(
	portfolio: PortfolioRow,
	cash: number,
	holdings: Map<string, { code: string; market: number; quantity: number; avgCost: number; totalCost: number }>,
): string {
	const lines = [
		`【${portfolio.name}】`,
		`初始资金: ${portfolio.initial_cash.toLocaleString()}`,
		`当前现金: ${cash.toLocaleString()}`,
		"",
	];
	if (holdings.size === 0) {
		lines.push("暂无持仓。");
	} else {
		lines.push("【持仓】");
		let i = 1;
		for (const [, h] of holdings) {
			lines.push(
				`${i}. ${h.code}${h.market === 1 ? ".SH" : ".SZ"} — ${h.quantity}股 @ 成本${h.avgCost.toFixed(2)} (总成本 ${h.totalCost.toFixed(2)})`,
			);
			i++;
		}
	}
	return lines.join("\n");
}

function formatValueBreakdown(value: Awaited<ReturnType<typeof computePortfolioValue>>): string {
	const lines = [
		`【组合估值 — ${value.date}】`,
		`现金: ${value.cash.toLocaleString()}`,
		`持仓市值: ${(value.totalValue - value.cash).toLocaleString()}`,
		`总市值: ${value.totalValue.toLocaleString()}`,
		`总成本: ${value.totalCost.toLocaleString()}`,
		`浮动盈亏: ${value.unrealizedPnl >= 0 ? "+" : ""}${value.unrealizedPnl.toLocaleString()} (${value.unrealizedPnlPct.toFixed(2)}%)`,
		"",
	];
	if (value.holdings.length > 0) {
		lines.push("【持仓明细】");
		for (const h of value.holdings) {
			const priceStr = h.marketPrice != null ? h.marketPrice.toFixed(2) : "N/A";
			lines.push(
				`  ${h.code}${h.market === 1 ? ".SH" : ".SZ"} — ${h.quantity}股 | 成本${h.avgCost.toFixed(2)} | 市价${priceStr} | 市值${h.marketValue.toLocaleString()} | 盈亏${h.unrealizedPnl >= 0 ? "+" : ""}${h.unrealizedPnl.toLocaleString()}`,
			);
		}
	}
	return lines.join("\n");
}

function formatTradeHistory(trades: PortfolioTradeRow[]): string {
	if (trades.length === 0) return "暂无交易记录。";
	const lines = ["【交易历史】", ""];
	for (const t of trades) {
		const dir = t.direction === "buy" ? "买入" : "卖出";
		const fees = ((t.commission ?? 0) + (t.tax ?? 0)).toFixed(2);
		lines.push(
			`[${t.trade_date}] ${dir} ${t.code}${t.market === 1 ? ".SH" : ".SZ"} — ${t.quantity}股 @ ${t.price.toFixed(2)} (费用: ${fees})${t.memo ? ` — ${t.memo}` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatBacktestReport(
	metrics: ReturnType<typeof computeMetrics>,
	curve: { date: string; equity: number }[],
): string {
	if (curve.length === 0) return "暂无权益曲线数据。";
	const lines = [
		"【组合回测报告】",
		"",
		`总收益率: ${metrics.totalReturn.toFixed(2)}%`,
		`年化收益率: ${metrics.annualizedReturn.toFixed(2)}%`,
		`夏普比率: ${metrics.sharpeRatio.toFixed(2)}`,
		`最大回撤: ${metrics.maxDrawdown.toFixed(2)}%`,
		`最大回撤天数: ${metrics.maxDrawdownDuration}`,
		"",
		`期初净值: ${curve[0].equity.toLocaleString()}`,
		`期末净值: ${curve[curve.length - 1].equity.toLocaleString()}`,
	];
	return lines.join("\n");
}

export const managePortfolioTool: AgentTool<typeof portfolioParams, PortfolioToolDetails> = {
	name: "manage_portfolio",
	label: "组合管理",
	description:
		"创建、管理投资组合，记录换仓交易，查询持仓和价值，运行回测分析。支持多组合管理，持仓成本采用加权平均法。",
	parameters: portfolioParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "数据库未初始化，无法管理组合。" }],
				details: { error: "DataStore not initialized" },
			};
		}

		const action = params.action;

		// ─── create ───────────────────────────────────────────────────
		if (action === "create") {
			if (!params.name) {
				return {
					content: [{ type: "text", text: "创建组合需要提供名称（name）。" }],
					details: { error: "missing name" },
				};
			}
			if (params.initial_cash == null || params.initial_cash <= 0) {
				return {
					content: [{ type: "text", text: "创建组合需要提供正数初始资金（initial_cash）。" }],
					details: { error: "missing initial_cash" },
				};
			}
			const existing = await store.getPortfolioByName(params.name);
			if (existing) {
				return {
					content: [
						{ type: "text", text: `组合 "${params.name}" 已存在（ID: ${existing.id}）。请使用其他名称。` },
					],
					details: { error: "portfolio exists", existing },
				};
			}
			const portfolioId = await store.createPortfolio(params.name, params.initial_cash, params.description);
			return {
				content: [
					{
						type: "text",
						text: `组合 "${params.name}" 创建成功（ID: ${portfolioId}），初始资金 ${params.initial_cash.toLocaleString()}。`,
					},
				],
				details: {
					portfolio: { id: portfolioId, name: params.name, initial_cash: params.initial_cash } as PortfolioRow,
				},
			};
		}

		// ─── list ─────────────────────────────────────────────────────
		if (action === "list") {
			const portfolios = await store.getPortfolios();
			return {
				content: [{ type: "text", text: formatPortfolioList(portfolios) }],
				details: { portfolios },
			};
		}

		// ─── show ─────────────────────────────────────────────────────
		if (action === "show") {
			const portfolio = await findPortfolio(store, params.id, params.name);
			if (!portfolio) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `组合 ${ref} 不存在。` }],
					details: { error: "portfolio not found" },
				};
			}
			const today = new Date().toISOString().slice(0, 10);
			const trades = await store.getPortfolioTrades(portfolio.id, undefined, today);
			const { cashDelta, holdings } = replayHoldings(trades, today);
			const cash = portfolio.initial_cash + cashDelta;
			return {
				content: [{ type: "text", text: formatPortfolioDetail(portfolio, cash, holdings) }],
				details: { portfolio, cash, holdings: Array.from(holdings.values()) },
			};
		}

		// ─── delete ───────────────────────────────────────────────────
		if (action === "delete") {
			const portfolio = await findPortfolio(store, params.id, params.name);
			if (!portfolio) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `组合 ${ref} 不存在。` }],
					details: { error: "portfolio not found" },
				};
			}
			await store.deletePortfolio(portfolio.id);
			return {
				content: [{ type: "text", text: `组合 "${portfolio.name}"（编号 ${portfolio.id}）已删除。` }],
				details: { deleted: portfolio.id },
			};
		}

		// ─── trade ────────────────────────────────────────────────────
		if (action === "trade") {
			const portfolio = await findPortfolio(store, params.id, params.name);
			if (!portfolio) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `组合 ${ref} 不存在。` }],
					details: { error: "portfolio not found" },
				};
			}
			if (
				!params.trade_date ||
				!params.code ||
				params.market == null ||
				!params.direction ||
				params.quantity == null ||
				params.price == null
			) {
				return {
					content: [
						{ type: "text", text: "记录交易需要提供 trade_date, code, market, direction, quantity, price。" },
					],
					details: { error: "missing trade params" },
				};
			}
			if (!Number.isInteger(params.quantity) || params.quantity <= 0 || params.price <= 0) {
				return {
					content: [{ type: "text", text: "交易数量必须为正整数，价格必须为正数。" }],
					details: { error: "invalid trade params" },
				};
			}

			// Validate sell: check if enough shares
			if (params.direction === "sell") {
				const trades = await store.getPortfolioTrades(portfolio.id, undefined, params.trade_date);
				const { holdings } = replayHoldings(trades, params.trade_date);
				const key = `${params.code}:${params.market}`;
				const pos = holdings.get(key);
				if (!pos || pos.quantity < params.quantity) {
					return {
						content: [
							{
								type: "text",
								text: `卖出失败：${params.code} 当前持仓 ${pos?.quantity ?? 0} 股，不足 ${params.quantity} 股。`,
							},
						],
						details: { error: "insufficient shares", available: pos?.quantity ?? 0 },
					};
				}
			}

			const tradeId = await store.addPortfolioTrade({
				portfolio_id: portfolio.id,
				trade_date: params.trade_date,
				code: params.code,
				market: params.market,
				direction: params.direction,
				quantity: params.quantity,
				price: params.price,
				adjust: params.adjust,
				commission: params.commission,
				tax: params.tax,
				memo: params.memo,
			});

			const dirText = params.direction === "buy" ? "买入" : "卖出";
			return {
				content: [
					{
						type: "text",
						text: `交易记录已保存（ID: ${tradeId}）：${params.trade_date} ${dirText} ${params.code}${params.market === 1 ? ".SH" : ".SZ"} ${params.quantity}股 @ ${params.price.toFixed(2)}。`,
					},
				],
				details: { tradeId },
			};
		}

		// ─── history ──────────────────────────────────────────────────
		if (action === "history") {
			const portfolio = await findPortfolio(store, params.id, params.name);
			if (!portfolio) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `组合 ${ref} 不存在。` }],
					details: { error: "portfolio not found" },
				};
			}
			const trades = await store.getPortfolioTrades(portfolio.id, params.start_date, params.end_date);
			return {
				content: [{ type: "text", text: formatTradeHistory(trades) }],
				details: { trades },
			};
		}

		// ─── value ────────────────────────────────────────────────────
		if (action === "value") {
			const portfolio = await findPortfolio(store, params.id, params.name);
			if (!portfolio) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `组合 ${ref} 不存在。` }],
					details: { error: "portfolio not found" },
				};
			}
			const date = params.date ?? new Date().toISOString().slice(0, 10);
			const value = await computePortfolioValue(portfolio.id, date, params.price_mode ?? "close");
			return {
				content: [{ type: "text", text: formatValueBreakdown(value) }],
				details: { value },
			};
		}

		// ─── backtest ─────────────────────────────────────────────────
		if (action === "backtest") {
			const portfolio = await findPortfolio(store, params.id, params.name);
			if (!portfolio) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `组合 ${ref} 不存在。` }],
					details: { error: "portfolio not found" },
				};
			}
			const startDate =
				params.start_date ??
				portfolio.created_at?.slice(0, 10) ??
				new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
			const endDate = params.end_date ?? new Date().toISOString().slice(0, 10);
			const curve = await buildPortfolioEquityCurve(portfolio.id, startDate, endDate, params.price_mode ?? "close");

			if (curve.length === 0) {
				return {
					content: [
						{ type: "text", text: "该时间段内无权益曲线数据。请确认组合有交易记录且日期范围内有行情数据。" },
					],
					details: { error: "no data" },
				};
			}

			// Convert to format expected by computeMetrics
			const equityPoints = curve.map((c) => ({ date: c.date, equity: c.equity }));
			const metrics = computeMetrics([], equityPoints, portfolio.initial_cash);

			return {
				content: [{ type: "text", text: formatBacktestReport(metrics, equityPoints) }],
				details: { metrics, curve: equityPoints },
			};
		}

		return { content: [{ type: "text", text: `未知操作: ${action}` }], details: { error: "unknown action" } };
	},
};
