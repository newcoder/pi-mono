import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";
import { formatNumber, runJsonScript } from "./_utils.js";

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
		"多因子股票筛选：根据PE、PB、ROE、市值、股息率等条件从指数成分股或全市场中筛选股票。默认从沪深300筛选。",
	parameters: screenStocksParams,
	execute: async (_id, params) => {
		// 1. Try local DB first (fast, no network) for supported filters
		const localResult = await screenFromLocalDB(params);
		if (localResult) {
			return localResult;
		}

		// 2. Fall back to Python script (supports ROE/debt/dividend + index scopes)
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
