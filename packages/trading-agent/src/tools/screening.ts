import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";
import { formatNumber, runJsonScript } from "./_utils.js";
import { advancedScreenTool } from "./advanced-screening.js";
import { iwencaiScreenTool } from "./iwencai-screening.js";

const screenStocksParams = Type.Object({
	scope: Type.Optional(
		Type.Union(
			[
				Type.Literal("all"),
				Type.Literal("hs300"),
				Type.Literal("zz500"),
				Type.Literal("zz1000"),
				Type.Literal("cyb"),
				Type.Literal("kcb"),
			],
			{ description: "筛选范围", default: "hs300" },
		),
	),
	peMin: Type.Optional(Type.Number({ description: "最小PE" })),
	peMax: Type.Optional(Type.Number({ description: "最大PE" })),
	pbMin: Type.Optional(Type.Number({ description: "最小PB" })),
	pbMax: Type.Optional(Type.Number({ description: "最大PB" })),
	roeMin: Type.Optional(Type.Number({ description: "最小ROE (%)" })),
	debtRatioMax: Type.Optional(Type.Number({ description: "最大资产负债率 (%)" })),
	dividendMin: Type.Optional(Type.Number({ description: "最小股息率 (%)" })),
	marketCapMin: Type.Optional(Type.Number({ description: "最小市值 (亿)" })),
	marketCapMax: Type.Optional(Type.Number({ description: "最大市值 (亿)" })),
	sortBy: Type.Optional(
		Type.Union([Type.Literal("score"), Type.Literal("pe"), Type.Literal("pb"), Type.Literal("market_cap")], {
			description: "排序方式: score=综合评分(默认), pe, pb, market_cap",
			default: "score",
		}),
	),
	top: Type.Optional(Type.Number({ description: "返回前N只", default: 50 })),
});

interface ScreenStocksDetails {
	screen_time: string;
	scope: string;
	filters: Record<string, number | null>;
	count: number;
	results: unknown[];
	source?: string;
}

function formatScreeningResult(data: unknown): string {
	const d = data as Record<string, unknown>;
	const results = (d.results as unknown[]) ?? [];
	if (results.length === 0) return "未找到符合条件的股票。";
	const lines: string[] = [`【股票筛选结果】共${d.count}只`];
	for (const r of results) {
		const row = r as Record<string, unknown>;
		lines.push(
			`${row.代码} ${row.名称} | 价:${formatNumber(row.最新价 as number)} 涨:${row.涨跌幅}% PE:${row.市盈率 ?? "—"} PB:${row.市净率 ?? "—"} 市值:${formatNumber(row["总市值(亿)"] as number)}亿 评分:${row.评分}`,
		);
	}
	return lines.join("\n");
}

interface LocalScreenRow {
	code: string;
	name: string;
	pe?: number;
	pb?: number;
	total_cap?: number;
	change_pct?: number;
	latest?: number;
}

/** Format results from local DB query */
function formatLocalResult(rows: LocalScreenRow[], sortBy: string): string {
	if (rows.length === 0) return "未找到符合条件的股票。";

	// Sort
	const sorted = [...rows];
	if (sortBy === "pe") sorted.sort((a, b) => (a.pe ?? Infinity) - (b.pe ?? Infinity));
	else if (sortBy === "pb") sorted.sort((a, b) => (a.pb ?? Infinity) - (b.pb ?? Infinity));
	else if (sortBy === "market_cap") sorted.sort((a, b) => (b.total_cap ?? 0) - (a.total_cap ?? 0));
	else sorted.sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0)); // score = change_pct as proxy

	const lines: string[] = [`【股票筛选结果】共${rows.length}只（本地数据）`];
	for (const r of sorted) {
		lines.push(
			`${r.code} ${r.name} | 价:${formatNumber(r.latest)} 涨:${r.change_pct?.toFixed?.(2) ?? "—"}% PE:${r.pe ?? "—"} PB:${r.pb ?? "—"} 市值:${formatNumber(r.total_cap)}亿`,
		);
	}
	return lines.join("\n");
}

function validateNumberParam(value: unknown): number | null {
	if (value == null) return null;
	const num = Number(value);
	if (!Number.isFinite(num)) return null;
	return num;
}

/** Build iWencai natural language query from structured screening params */
function buildIwencaiQuery(params: any): string {
	const parts: string[] = [];

	const scopeMap: Record<string, string> = {
		all: "A股",
		hs300: "沪深300",
		zz500: "中证500",
		zz1000: "中证1000",
		cyb: "创业板",
		kcb: "科创板",
	};
	if (params.scope && scopeMap[params.scope]) {
		parts.push(scopeMap[params.scope]);
	} else {
		parts.push("A股");
	}

	if (params.peMin != null || params.peMax != null) {
		if (params.peMin != null && params.peMax != null) {
			parts.push(`市盈率${params.peMin}到${params.peMax}`);
		} else if (params.peMin != null) {
			parts.push(`市盈率大于${params.peMin}`);
		} else {
			parts.push(`市盈率小于${params.peMax}`);
		}
	}
	if (params.pbMin != null || params.pbMax != null) {
		if (params.pbMin != null && params.pbMax != null) {
			parts.push(`市净率${params.pbMin}到${params.pbMax}`);
		} else if (params.pbMin != null) {
			parts.push(`市净率大于${params.pbMin}`);
		} else {
			parts.push(`市净率小于${params.pbMax}`);
		}
	}
	if (params.roeMin != null) {
		parts.push(`ROE大于${params.roeMin}%`);
	}
	if (params.debtRatioMax != null) {
		parts.push(`资产负债率小于${params.debtRatioMax}%`);
	}
	if (params.dividendMin != null) {
		parts.push(`股息率大于${params.dividendMin}%`);
	}
	if (params.marketCapMin != null || params.marketCapMax != null) {
		if (params.marketCapMin != null && params.marketCapMax != null) {
			parts.push(`市值${params.marketCapMin}亿到${params.marketCapMax}亿`);
		} else if (params.marketCapMin != null) {
			parts.push(`市值大于${params.marketCapMin}亿`);
		} else {
			parts.push(`市值小于${params.marketCapMax}亿`);
		}
	}

	return parts.join("，");
}

/** Convert screen_stocks params to advanced_screen conditions */
function buildAdvancedConditions(params: any): any[] {
	const conditions: any[] = [];

	if (params.peMin != null) {
		conditions.push({ type: "fundamental", field: "pe", operator: ">=", value: params.peMin });
	}
	if (params.peMax != null) {
		conditions.push({ type: "fundamental", field: "pe", operator: "<=", value: params.peMax });
	}
	if (params.pbMin != null) {
		conditions.push({ type: "fundamental", field: "pb", operator: ">=", value: params.pbMin });
	}
	if (params.pbMax != null) {
		conditions.push({ type: "fundamental", field: "pb", operator: "<=", value: params.pbMax });
	}
	if (params.roeMin != null) {
		conditions.push({ type: "fundamental", field: "roe", operator: ">=", value: params.roeMin });
	}
	if (params.marketCapMin != null) {
		conditions.push({ type: "quote", field: "total_cap", operator: ">=", value: params.marketCapMin });
	}
	if (params.marketCapMax != null) {
		conditions.push({ type: "quote", field: "total_cap", operator: "<=", value: params.marketCapMax });
	}

	return conditions;
}

/** Format iWencai results to match screen_stocks output format */
function formatIwencaiAsScreenResult(
	iwencaiDetails: any,
	params: any,
): { content: any[]; details: ScreenStocksDetails } {
	const results = iwencaiDetails.results ?? [];
	const mappedResults = results.map((r: any) => ({
		代码: r.股票代码 || r.代码 || "",
		名称: r.股票简称 || r.名称 || "",
		最新价: r.最新价 || r.现价 || null,
		涨跌幅: r.最新涨跌幅 || r.涨跌幅 || null,
		市盈率: r.市盈率 || r.PE || null,
		市净率: r.市净率 || r.PB || null,
		"总市值(亿)": r.总市值 || r["总市值(亿)"] || null,
		评分: "—",
	}));

	const text = formatScreeningResult({
		results: mappedResults,
		count: mappedResults.length,
	});

	return {
		content: [{ type: "text" as const, text }],
		details: {
			screen_time: new Date().toISOString(),
			scope: params.scope ?? "all",
			filters: {
				pe_min: params.peMin ?? null,
				pe_max: params.peMax ?? null,
				pb_min: params.pbMin ?? null,
				pb_max: params.pbMax ?? null,
				roe_min: params.roeMin ?? null,
				debt_ratio_max: params.debtRatioMax ?? null,
				dividend_min: params.dividendMin ?? null,
				market_cap_min: params.marketCapMin ?? null,
				market_cap_max: params.marketCapMax ?? null,
			},
			count: mappedResults.length,
			results: mappedResults,
			source: "iwencai",
		},
	};
}

/** Format advanced_screen results to match screen_stocks output format */
function formatAdvancedAsScreenResult(
	advancedDetails: any,
	params: any,
): { content: any[]; details: ScreenStocksDetails } {
	const results = advancedDetails.results ?? [];
	const mappedResults = results.map((r: any) => ({
		代码: r.code,
		名称: r.name || "",
		最新价: null,
		涨跌幅: null,
		市盈率: null,
		市净率: null,
		"总市值(亿)": null,
		评分: r.signals ? Object.keys(r.signals).length : 0,
	}));

	const text = formatScreeningResult({
		results: mappedResults,
		count: mappedResults.length,
	});

	return {
		content: [{ type: "text" as const, text }],
		details: {
			screen_time: new Date().toISOString(),
			scope: params.scope ?? "all",
			filters: {
				pe_min: params.peMin ?? null,
				pe_max: params.peMax ?? null,
				pb_min: params.pbMin ?? null,
				pb_max: params.pbMax ?? null,
				roe_min: params.roeMin ?? null,
				debt_ratio_max: params.debtRatioMax ?? null,
				dividend_min: params.dividendMin ?? null,
				market_cap_min: params.marketCapMin ?? null,
				market_cap_max: params.marketCapMax ?? null,
			},
			count: mappedResults.length,
			results: mappedResults,
			source: "advanced_screen",
		},
	};
}

/** Screen from local database (fast, no network) */
async function screenFromLocalDB(params: any): Promise<{ content: any[]; details: any } | null> {
	const store = getDataStore();
	if (!store) return null;

	// Check if any filter requires data not in local DB
	const needsFundamentals = params.roeMin != null || params.debtRatioMax != null || params.dividendMin != null;
	if (needsFundamentals) {
		// Local DB doesn't have ROE/debt/dividend — fall back to Python script
		return null;
	}

	try {
		const conditions: string[] = ["pe > 0"]; // Exclude negative PE (loss-making companies)
		const queryParams: unknown[] = [];

		const peMin = validateNumberParam(params.peMin);
		const peMax = validateNumberParam(params.peMax);
		const pbMin = validateNumberParam(params.pbMin);
		const pbMax = validateNumberParam(params.pbMax);
		const marketCapMin = validateNumberParam(params.marketCapMin);
		const marketCapMax = validateNumberParam(params.marketCapMax);
		const top = validateNumberParam(params.top);

		if (peMin != null) {
			conditions.push(`pe >= ?`);
			queryParams.push(peMin);
		}
		if (peMax != null) {
			conditions.push(`pe <= ?`);
			queryParams.push(peMax);
		}
		if (pbMin != null) {
			conditions.push(`pb >= ?`);
			queryParams.push(pbMin);
		}
		if (pbMax != null) {
			conditions.push(`pb <= ?`);
			queryParams.push(pbMax);
		}
		if (marketCapMin != null) {
			conditions.push(`total_cap >= ?`);
			queryParams.push(marketCapMin);
		}
		if (marketCapMax != null) {
			conditions.push(`total_cap <= ?`);
			queryParams.push(marketCapMax);
		}

		const whereClause = conditions.join(" AND ");
		const limit = top ?? 50;
		const sql = `SELECT code, name, market, latest, change_pct, pe, pb, total_cap FROM quotes WHERE ${whereClause} ORDER BY total_cap DESC LIMIT ?`;
		queryParams.push(limit);

		const rows = await store.query(sql, queryParams);

		// Map to expected format
		const results = rows.map((r: any) => ({
			代码: r.code,
			名称: r.name,
			最新价: r.latest,
			涨跌幅: r.change_pct,
			市盈率: r.pe,
			市净率: r.pb,
			"总市值(亿)": r.total_cap,
			评分: r.change_pct?.toFixed?.(1) ?? "—",
		}));

		return {
			content: [{ type: "text", text: formatLocalResult(rows, params.sortBy ?? "score") }],
			details: {
				screen_time: new Date().toISOString(),
				scope: params.scope ?? "all",
				filters: {
					pe_min: peMin,
					pe_max: peMax,
					pb_min: pbMin,
					pb_max: pbMax,
					market_cap_min: marketCapMin,
					market_cap_max: marketCapMax,
				},
				count: results.length,
				results,
				source: "local_db",
			},
		};
	} catch (e) {
		console.warn("[screen_stocks] Local DB screening failed:", e);
		return null;
	}
}

export const screenStocksTool: AgentTool<typeof screenStocksParams, ScreenStocksDetails> = {
	name: "screen_stocks",
	label: "股票筛选",
	description:
		"多因子股票筛选：根据PE、PB、ROE、市值、股息率等条件筛选股票。执行顺序：1)优先调用iWencai获取实时数据；2)失败时自动回退到高级选股器（本地技术指标+基本面组合）；3)最后回退到本地数据库或Python脚本。默认从沪深300筛选。",
	parameters: screenStocksParams,
	execute: async (_id, params) => {
		// 1. Try iWencai first (real-time data, broader coverage)
		try {
			const query = buildIwencaiQuery(params);
			const iwencaiResult = await iwencaiScreenTool.execute(_id, {
				query,
				mode: "stock",
				limit: params.top ?? 50,
			});
			const iwencaiDetails = iwencaiResult.details as any;
			if (iwencaiDetails?.success && iwencaiDetails.results && iwencaiDetails.results.length > 0) {
				return formatIwencaiAsScreenResult(iwencaiDetails, params);
			}
		} catch (e) {
			console.warn("[screen_stocks] iWencai failed, falling back to advanced_screen:", e);
		}

		// 2. Fall back to advanced_screen (local DB, technical + fundamental combo)
		try {
			const conditions = buildAdvancedConditions(params);
			if (conditions.length > 0) {
				const advancedResult = await advancedScreenTool.execute(_id, {
					scope: params.scope ?? "all",
					conditions,
					targetCount: params.top ?? 50,
					autoTune: true,
				});
				const advancedDetails = advancedResult.details as any;
				if (advancedDetails?.results && advancedDetails.results.length > 0) {
					return formatAdvancedAsScreenResult(advancedDetails, params);
				}
			}
		} catch (e) {
			console.warn("[screen_stocks] advanced_screen failed, falling back to local DB:", e);
		}

		// 3. Try local DB (fast, no network) for supported filters
		const localResult = await screenFromLocalDB(params);
		if (localResult) {
			return localResult;
		}

		// 4. Final fallback to Python script (supports ROE/debt/dividend + index scopes)
		const args: string[] = [];
		if (params.scope) args.push("--scope", params.scope);
		if (params.peMin != null) args.push("--pe-min", String(params.peMin));
		if (params.peMax != null) args.push("--pe-max", String(params.peMax));
		if (params.pbMin != null) args.push("--pb-min", String(params.pbMin));
		if (params.pbMax != null) args.push("--pb-max", String(params.pbMax));
		if (params.roeMin != null) args.push("--roe-min", String(params.roeMin));
		if (params.debtRatioMax != null) args.push("--debt-ratio-max", String(params.debtRatioMax));
		if (params.dividendMin != null) args.push("--dividend-min", String(params.dividendMin));
		if (params.marketCapMin != null) args.push("--market-cap-min", String(params.marketCapMin));
		if (params.marketCapMax != null) args.push("--market-cap-max", String(params.marketCapMax));
		if (params.sortBy) args.push("--sort-by", params.sortBy);
		if (params.top != null) args.push("--top", String(params.top));

		const data = await runJsonScript("stock_screener.py", args);
		return {
			content: [{ type: "text", text: formatScreeningResult(data) }],
			details: data,
		};
	},
};
