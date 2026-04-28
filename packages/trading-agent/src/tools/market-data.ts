import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore, getDataSync } from "../data/index.js";
import type { AdjustFactorRow, KlineRow } from "../data/types.js";
import { formatNumber, runJsonScript } from "./_utils.js";

// ─── Parameter Schemas ──────────────────────────────────────────

const getQuoteParams = Type.Object({
	code: Type.String({ description: "6位股票代码，如 600519" }),
	market: Type.Optional(
		Type.Union([Type.Literal(1), Type.Literal(0)], {
			description: "1=上海 (默认), 0=深圳",
			default: 1,
		}),
	),
});

const getFundamentalsParams = Type.Object({
	code: Type.String({ description: "6位股票代码，如 600519" }),
	market: Type.Optional(
		Type.Union([Type.Literal(1), Type.Literal(0)], {
			description: "1=上海 (默认), 0=深圳",
			default: 1,
		}),
	),
	history: Type.Optional(Type.Boolean({ description: "是否返回历史多期数据", default: false })),
	start: Type.Optional(Type.String({ description: "起始报告期 YYYY-MM-DD", default: "1970-01-01" })),
	end: Type.Optional(Type.String({ description: "结束报告期 YYYY-MM-DD", default: "2050-01-01" })),
});

const getKlineParams = Type.Object({
	code: Type.String({ description: "6位股票代码，如 600519" }),
	market: Type.Optional(
		Type.Union([Type.Literal(1), Type.Literal(0)], {
			description: "1=上海 (默认), 0=深圳",
			default: 1,
		}),
	),
	period: Type.Optional(
		Type.Union(
			[
				Type.Literal("1m"),
				Type.Literal("5m"),
				Type.Literal("15m"),
				Type.Literal("30m"),
				Type.Literal("60m"),
				Type.Literal("120m"),
				Type.Literal("daily"),
				Type.Literal("week"),
				Type.Literal("month"),
				Type.Literal("quarter"),
				Type.Literal("year"),
			],
			{ description: "周期", default: "daily" },
		),
	),
	adjust: Type.Optional(
		Type.Union([Type.Literal("bfq"), Type.Literal("qfq"), Type.Literal("hfq")], {
			description: "复权类型: bfq=不复权(默认), qfq=前复权, hfq=后复权",
			default: "bfq",
		}),
	),
	start: Type.Optional(Type.String({ description: "起始日期 YYYYMMDD", default: "19700101" })),
	end: Type.Optional(Type.String({ description: "结束日期 YYYYMMDD", default: "20500101" })),
});

// ─── Detail Types ───────────────────────────────────────────────

interface QuoteDetails {
	code: string;
	name: string;
	latest: number;
	open: number;
	high: number;
	low: number;
	prev_close: number;
	volume: number;
	turnover: number;
	change_pct: number;
	total_cap: number;
	float_cap: number;
	pe: number | null;
	"52w_high": number | null;
	"52w_low": number | null;
}

interface FundamentalsDetails {
	stock_code: string;
	market: string;
	count?: number;
	reports?: unknown[];
}

interface KlineDetails {
	code: string;
	market: string;
	period: string;
	count: number;
	klines: Array<{
		date: string;
		open: number | null;
		close: number | null;
		high: number | null;
		low: number | null;
		volume: number | null;
		amount: number | null;
		change_pct: number | null;
		change_amount: number | null;
		amplitude: number | null;
		pre_close: number | null;
	}>;
}

function inferMarket(code: string): number {
	return code.startsWith("6") ? 1 : 0;
}

function toISODate(ymd: string): string {
	return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function applyAdjustment(klines: KlineRow[], factors: AdjustFactorRow[], adjust: string): KlineRow[] {
	if (adjust === "bfq") return klines;

	// Build date -> factor lookup with forward-fill
	const factorMap = new Map<string, number>();
	let currentFactor: number | null = null;
	for (const f of factors) {
		const fac = adjust === "qfq" ? f.qfq_factor : f.hfq_factor;
		if (fac != null) {
			currentFactor = fac;
		}
		if (currentFactor != null) {
			factorMap.set(f.date, currentFactor);
		}
	}

	return klines.map((k) => {
		const fac = factorMap.get(k.date);
		if (fac == null) return k;
		return {
			...k,
			open: k.open != null ? round(k.open * fac) : null,
			high: k.high != null ? round(k.high * fac) : null,
			low: k.low != null ? round(k.low * fac) : null,
			close: k.close != null ? round(k.close * fac) : null,
			pre_close: k.pre_close != null ? round(k.pre_close * fac) : null,
		};
	});
}

function round(v: number, digits = 4): number {
	const mult = 10 ** digits;
	return Math.round(v * mult) / mult;
}

function formatQuote(data: any): string {
	return [
		`【${data.name} ${data.code}】`,
		`最新价: ${formatNumber(data.latest)}  涨跌: ${data.change_pct}%`,
		`开盘: ${formatNumber(data.open)}  最高: ${formatNumber(data.high)}  最低: ${formatNumber(data.low)}  昨收: ${formatNumber(data.prev_close)}`,
		`成交量: ${formatNumber(data.volume)}手  成交额: ${formatNumber(data.turnover, 0)}元`,
		`市值: 总${formatNumber(data.total_cap, 0)}  流通${formatNumber(data.float_cap, 0)}`,
		`PE: ${data.pe ?? "—"}  52周高: ${formatNumber(data["52w_high"])}  52周低: ${formatNumber(data["52w_low"])}`,
	].join("\n");
}

function formatFundamentals(data: any): string {
	const lines: string[] = [`【${data.stock_code} ${data.market} 财务数据】`];
	for (const [name, section] of Object.entries<any>(data)) {
		if (typeof section !== "object" || !section.data) continue;
		lines.push(`\n${name} (${section.report_date ?? ""})`);
		for (const [key, val] of Object.entries(section.data)) {
			lines.push(`  ${key}: ${val}`);
		}
	}
	return lines.join("\n");
}

function formatKline(data: any): string {
	const k = data.klines;
	if (!k || k.length === 0) return "暂无K线数据";
	const head = k[0];
	const tail = k[k.length - 1];
	return [
		`【${data.code} ${data.market} ${data.period} K线】共${data.count}条`,
		`区间: ${head.date} ~ ${tail.date}`,
		`首条: 开${head.open} 收${head.close} 高${head.high} 低${head.low}`,
		`末条: 开${tail.open} 收${tail.close} 高${tail.high} 低${tail.low}`,
		`累计涨跌: ${(((tail.close - head.close) / head.close) * 100).toFixed(2)}%`,
	].join("\n");
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

export const getQuoteTool: AgentTool<typeof getQuoteParams, QuoteDetails> = {
	name: "get_quote",
	label: "获取行情",
	description: "获取A股实时行情数据：最新价、成交量、市值、PE等。优先从本地数据库读取，缺失时自动同步。",
	parameters: getQuoteParams,
	execute: async (_id, params) => {
		const market = params.market ?? inferMarket(params.code);
		const store = getDataStore();
		const sync = getDataSync();
		const today = todayStr();

		// 1. Try local DB first (today's quote)
		let quote = null;
		if (store) {
			try {
				quote = await store.getQuote(params.code, market, today);
				if (!quote) {
					// Fallback to most recent quote for this stock
					const latest = await store.getLatestQuotes([params.code]);
					quote = latest[0] ?? null;
				}
			} catch (e) {
				console.warn("[get_quote] DB query failed:", e);
			}
		}

		// 2. If no local data, try sync service (may trigger background fetch)
		if (!quote && sync) {
			try {
				quote = await sync.getQuoteWithCache(params.code, market);
			} catch (e) {
				console.warn("[get_quote] Sync fetch failed:", e);
			}
		}

		// 3. If we have data, return it
		if (quote) {
			// Ensure name is populated
			if (!quote.name && store) {
				try {
					const stock = await store.getStock(params.code);
					if (stock) quote.name = stock.name;
				} catch {
					/* ignore */
				}
			}
			const data = {
				name: quote.name || params.code,
				code: quote.code,
				latest: quote.latest ?? 0,
				open: quote.open ?? 0,
				high: quote.high ?? 0,
				low: quote.low ?? 0,
				prev_close: quote.prev_close ?? 0,
				volume: quote.volume ?? 0,
				turnover: quote.turnover ?? 0,
				change_pct: quote.change_pct ?? 0,
				total_cap: quote.total_cap ?? 0,
				float_cap: quote.float_cap ?? 0,
				pe: quote.pe,
				"52w_high": quote.high_52w,
				"52w_low": quote.low_52w,
			};
			return {
				content: [{ type: "text", text: formatQuote(data) }],
				details: data,
			};
		}

		// 4. No data available
		throw new Error(
			`【${params.code}】暂无行情数据。请先执行同步：\n  npx pi-trading-agent --sync-quotes\n或\n  npx pi-trading-agent --sync-kline ${params.code}`,
		);
	},
};

function formatFundamentalsHistory(rows: any[], code: string, market: string): string {
	if (!rows || rows.length === 0) return "暂无财务数据";
	const lines: string[] = [`【${code} ${market} 历史财务数据】共${rows.length}期`];

	// Show latest period detail
	const latest = rows[0];
	lines.push(`\n最新期 (${latest.report_date} ${latest.report_type ?? ""})`);
	lines.push(
		`  营业总收入: ${formatNumber(latest.total_revenue)}  归母净利润: ${formatNumber(latest.parent_net_profit)}  EPS: ${latest.eps ?? "—"}`,
	);
	// Compute gross margin if cost data available
	const grossMargin =
		latest.total_revenue != null && latest.operate_cost != null && latest.total_revenue > 0
			? `${(((latest.total_revenue - latest.operate_cost) / latest.total_revenue) * 100).toFixed(2)}%`
			: "—";
	lines.push(`  营业成本: ${formatNumber(latest.operate_cost)}  毛利率: ${grossMargin}`);
	lines.push(`  资产总计: ${formatNumber(latest.total_assets)}  负债合计: ${formatNumber(latest.total_liabilities)}`);
	lines.push(
		`  经营现金流: ${formatNumber(latest.operate_cash_flow)}  投资现金流: ${formatNumber(latest.invest_cash_flow)}`,
	);
	lines.push(
		`  货币资金: ${formatNumber(latest.monetary_funds)}  存货: ${formatNumber(latest.inventory)}  应收: ${formatNumber(latest.accounts_rece)}`,
	);
	lines.push(
		`  短借: ${formatNumber(latest.short_loan)}  长借: ${formatNumber(latest.long_loan)}  研发: ${formatNumber(latest.research_expense)}`,
	);
	// New fields
	const creditImp = latest.credit_impairment != null ? formatNumber(latest.credit_impairment) : "—";
	const assetImp = latest.asset_impairment != null ? formatNumber(latest.asset_impairment) : "—";
	const nonOpIncome = latest.non_operate_income != null ? formatNumber(latest.non_operate_income) : "—";
	const nonOpExpense = latest.non_operate_expense != null ? formatNumber(latest.non_operate_expense) : "—";
	lines.push(`  信用减值: ${creditImp}  资产减值: ${assetImp}  营业外收支: ${nonOpIncome}/${nonOpExpense}`);
	lines.push(
		`  税金附加: ${latest.operate_tax_add != null ? formatNumber(latest.operate_tax_add) : "—"}  总股本: ${latest.total_shares != null ? formatNumber(latest.total_shares, 0) : "—"}`,
	);

	// Show year-over-year growth if we have enough data
	if (rows.length >= 5) {
		lines.push(`\n【核心指标趋势】(最近${Math.min(rows.length, 8)}期)`);
		lines.push("期数        营收(亿)    归母净利(亿)  EPS    毛利率    资产(亿)    经营现金流(亿)");
		for (let i = 0; i < Math.min(rows.length, 8); i++) {
			const r = rows[i];
			const rev = r.total_revenue != null ? (r.total_revenue / 1e8).toFixed(2) : "—";
			const profit = r.parent_net_profit != null ? (r.parent_net_profit / 1e8).toFixed(2) : "—";
			const eps = r.eps != null ? r.eps.toFixed(2) : "—";
			const gm =
				r.total_revenue != null && r.operate_cost != null && r.total_revenue > 0
					? `${(((r.total_revenue - r.operate_cost) / r.total_revenue) * 100).toFixed(1)}%`
					: "—";
			const assets = r.total_assets != null ? (r.total_assets / 1e8).toFixed(2) : "—";
			const cf = r.operate_cash_flow != null ? (r.operate_cash_flow / 1e8).toFixed(2) : "—";
			lines.push(
				`${r.report_date} ${String(r.report_type ?? "").padEnd(4)} ${rev.padStart(10)} ${profit.padStart(12)} ${eps.padStart(6)} ${gm.padStart(8)} ${assets.padStart(10)} ${cf.padStart(14)}`,
			);
		}
	}

	return lines.join("\n");
}

export const getFundamentalsTool: AgentTool<typeof getFundamentalsParams, FundamentalsDetails> = {
	name: "get_fundamentals",
	label: "获取财务",
	description: "获取A股三大财务报表：利润表、资产负债表、现金流量表。支持查询历史多期数据。优先从本地数据库读取。",
	parameters: getFundamentalsParams,
	execute: async (_id, params) => {
		const market = params.market ?? inferMarket(params.code);
		const sync = getDataSync();
		const history = params.history ?? false;
		const start = params.start ?? "1970-01-01";
		const end = params.end ?? "2050-01-01";

		if (sync) {
			try {
				const rows = await sync.getFundamentalsWithCache(params.code, market);
				if (rows.length > 0) {
					// Filter by date range
					const filtered = rows.filter((r) => r.report_date >= start && r.report_date <= end);
					if (history) {
						const text = formatFundamentalsHistory(filtered, params.code, market === 1 ? "SH" : "SZ");
						return {
							content: [{ type: "text", text }],
							details: {
								stock_code: params.code,
								market: market === 1 ? "SH" : "SZ",
								count: filtered.length,
								reports: filtered,
							},
						};
					}
					// Single latest report
					const row = filtered[0];
					const data: any = {
						stock_code: row.code,
						market: row.market === 1 ? "SH" : "SZ",
						利润表: {
							report_date: row.report_date,
							data: {
								营业总收入: String(row.total_revenue ?? "-"),
								营业收入: String(row.operate_revenue ?? "-"),
								营业成本: String(row.operate_cost ?? "-"),
								营业总成本: String(row.total_operate_cost ?? "-"),
								营业利润: String(row.operate_profit ?? "-"),
								利润总额: String(row.total_profit ?? "-"),
								净利润: String(row.net_profit ?? "-"),
								归母净利润: String(row.parent_net_profit ?? "-"),
								基本每股收益: String(row.eps ?? "-"),
								营业税金及附加: String(row.operate_tax_add ?? "-"),
								信用减值损失: String(row.credit_impairment ?? "-"),
								资产减值损失: String(row.asset_impairment ?? "-"),
								营业外收入: String(row.non_operate_income ?? "-"),
								营业外支出: String(row.non_operate_expense ?? "-"),
							},
						},
						资产负债表: {
							report_date: row.report_date,
							data: {
								资产总计: String(row.total_assets ?? "-"),
								负债合计: String(row.total_liabilities ?? "-"),
								所有者权益合计: String(row.total_equity ?? "-"),
								归母所有者权益: String(row.parent_equity ?? "-"),
								总股本: String(row.total_shares ?? "-"),
							},
						},
						现金流量表: {
							report_date: row.report_date,
							data: {
								经营活动现金流量净额: String(row.operate_cash_flow ?? "-"),
								投资活动现金流量净额: String(row.invest_cash_flow ?? "-"),
								筹资活动现金流量净额: String(row.finance_cash_flow ?? "-"),
								现金及现金等价物净增加额: String(row.net_cash_increase ?? "-"),
							},
						},
					};
					return {
						content: [{ type: "text", text: formatFundamentals(data) }],
						details: data,
					};
				}
			} catch (e) {
				console.warn("[get_fundamentals] Cache fetch failed, falling back to API:", e);
			}
		}

		// Fallback to direct API call
		const args = [params.code, "--market", String(market)];
		if (history) {
			args.push("--history", "--limit", "12");
		}
		const data = await runJsonScript("get_fundamentals.py", args, history ? 120_000 : undefined);
		return {
			content: [
				{
					type: "text",
					text: history
						? formatFundamentalsHistory(data.reports || [], params.code, market === 1 ? "SH" : "SZ")
						: formatFundamentals(data),
				},
			],
			details: data,
		};
	},
};

export const getKlineTool: AgentTool<typeof getKlineParams, KlineDetails> = {
	name: "get_kline",
	label: "获取K线",
	description:
		"获取A股历史K线数据（OHLCV）。支持日/周/月/分钟级。默认返回日线不复权最近一年数据。优先从本地数据库读取。",
	parameters: getKlineParams,
	execute: async (_id, params) => {
		const market = params.market ?? inferMarket(params.code);
		const period = params.period ?? "daily";
		const adjust = params.adjust ?? "bfq";
		const store = getDataStore();
		const sync = getDataSync();

		// Compute date range
		const today = new Date();
		const defaultEnd = params.end || today.toISOString().slice(0, 10).replace(/-/g, "");
		const defaultStart =
			params.start ||
			new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");

		const isoStart = toISODate(defaultStart);
		const isoEnd = toISODate(defaultEnd);
		let klines: any[] = [];

		if (store) {
			try {
				// Always query bfq from DB; adjustment applied dynamically
				let rows = await store.getKlines({
					code: params.code,
					market,
					period,
					adjust: "bfq",
					start: isoStart,
					end: isoEnd,
				});

				if (rows.length > 0) {
					// Apply adjustment if needed
					if (adjust !== "bfq") {
						const factors = await store.getAdjustFactors(params.code, market, isoStart, isoEnd);
						if (factors.length > 0) {
							rows = applyAdjustment(rows, factors, adjust);
						} else if (sync) {
							// Factors missing; trigger sync to backfill them
							await sync.syncKline(params.code, market, period, "bfq", defaultStart, defaultEnd);
							const factors2 = await store.getAdjustFactors(params.code, market, isoStart, isoEnd);
							if (factors2.length > 0) {
								rows = applyAdjustment(rows, factors2, adjust);
							}
						}
					}

					klines = rows.map((r: KlineRow) => ({
						date: r.date,
						open: r.open,
						close: r.close,
						high: r.high,
						low: r.low,
						volume: r.volume,
						amount: r.turnover,
						change_pct: r.change_pct,
						change_amount: r.change_amount,
						amplitude: r.amplitude,
						pre_close: r.pre_close,
					}));

					// Trigger background sync for missing recent data
					if (sync) {
						const latestDate = await store.getLatestKlineDate(params.code, market, period, "bfq");
						if (latestDate && latestDate < todayStr()) {
							sync.syncKline(params.code, market, period, "bfq", defaultStart, defaultEnd).catch(() => {});
						}
					}
				}
			} catch (e) {
				console.warn("[get_kline] DB fetch failed:", e);
			}
		}

		// If no local data, fetch from API and save
		if (klines.length === 0) {
			if (sync) {
				try {
					await sync.syncKline(params.code, market, period, "bfq", defaultStart, defaultEnd);
					// Re-fetch bfq from DB
					if (store) {
						let rows = await store.getKlines({
							code: params.code,
							market,
							period,
							adjust: "bfq",
							start: isoStart,
							end: isoEnd,
						});
						if (adjust !== "bfq") {
							const factors = await store.getAdjustFactors(params.code, market, isoStart, isoEnd);
							if (factors.length > 0) {
								rows = applyAdjustment(rows, factors, adjust);
							}
						}
						klines = rows.map((r: KlineRow) => ({
							date: r.date,
							open: r.open,
							close: r.close,
							high: r.high,
							low: r.low,
							volume: r.volume,
							amount: r.turnover,
							change_pct: r.change_pct,
							change_amount: r.change_amount,
							amplitude: r.amplitude,
							pre_close: r.pre_close,
						}));
					}
				} catch (e) {
					console.warn("[get_kline] Sync failed:", e);
				}
			}

			// If still no data, fall back to direct API
			if (klines.length === 0) {
				const args = [params.code, "--market", String(market), "--period", period, "--adjust", adjust];
				args.push("--start", defaultStart);
				args.push("--end", defaultEnd);
				const data = await runJsonScript("get_kline.py", args);
				klines = data.klines || [];
			}
		}

		// Truncate for display
		const displayKlines = klines.length > 30 ? klines.slice(-30) : klines;
		const data = {
			code: params.code,
			market: market === 1 ? "SH" : "SZ",
			period,
			count: klines.length,
			klines: displayKlines,
		};

		return {
			content: [{ type: "text", text: formatKline(data) }],
			details: data,
		};
	},
};
