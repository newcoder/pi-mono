import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
	analyzeMarketTheme,
	type ExternalConceptData,
	formatMarketTheme,
	type MarketThemeAnalysis,
	type ThemeOptions,
} from "../analysis/market-theme.js";
import { getDataStore } from "../data/index.js";
import { iwencaiScreenTool } from "./iwencai-screening.js";

const analyzeMarketThemeParams = Type.Object({
	lookback_days: Type.Optional(
		Type.Number({
			default: 5,
			description: "回看交易日数，用于连板梯队、板块轮动和情绪周期判断（默认 5）",
		}),
	),
	end_date: Type.Optional(
		Type.String({
			description: "分析截止日期，格式 YYYY-MM-DD；默认使用 quotes 表最新日期",
		}),
	),
});

interface AnalyzeMarketThemeDetails {
	analysis: MarketThemeAnalysis;
	window: { startDate: string; endDate: string; lookbackDays: number };
	externalConcepts?: ExternalConceptData[];
	externalError?: string;
}

function parsePercent(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === "number") return value;
	const cleaned = String(value).replace(/%/g, "").replace(/,/g, "").trim();
	const n = Number.parseFloat(cleaned);
	return Number.isNaN(n) ? null : n;
}

function parseYi(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === "number") return value;
	const s = String(value).replace(/,/g, "").trim();
	const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(万|亿)?$/);
	if (!m) return null;
	const n = Number.parseFloat(m[1]);
	if (Number.isNaN(n)) return null;
	switch (m[2]) {
		case "万":
			return n / 10000;
		case "亿":
			return n;
		default:
			// Raw values from iWencai are usually in 元; assume yuan and convert to 亿元.
			return n >= 1e8 ? n / 1e8 : n;
	}
}

function parseIntValue(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === "number") return Number.isInteger(value) ? value : Math.round(value);
	const n = Number.parseInt(String(value).replace(/,/g, ""), 10);
	return Number.isNaN(n) ? null : n;
}

function findColumn(row: Record<string, unknown>, candidates: string[]): unknown {
	for (const key of candidates) {
		if (key in row) return row[key];
	}
	return null;
}

function findColumnByPrefix(row: Record<string, unknown>, prefix: string): unknown {
	for (const key of Object.keys(row)) {
		if (key.startsWith(prefix)) return row[key];
	}
	return null;
}

function parseIwencaiPlateResult(result: { success?: boolean; results?: unknown[] }): ExternalConceptData[] {
	if (!result.success) return [];
	const results = result.results ?? [];
	const concepts: ExternalConceptData[] = [];
	for (const r of results) {
		const row = r as Record<string, unknown>;
		const name = String(findColumn(row, ["指数简称", "板块名称", "概念名称", "股票简称"]) ?? "").trim();
		if (!name) continue;
		const change = parsePercent(
			findColumn(row, ["最新涨跌幅:前复权:", "最新涨跌幅:前复权", "板块涨跌幅", "最新涨跌幅", "涨跌幅"]),
		);
		const windowChange = parsePercent(findColumnByPrefix(row, "涨跌幅["));
		const turnover = parseYi(findColumn(row, ["成交额", "主力净流入", "净流入", "成交量"]));
		const limitUp = parseIntValue(findColumnByPrefix(row, "涨停家数["));
		concepts.push({
			name,
			latestChangePct: change,
			windowChangePct: windowChange,
			turnoverYi: turnover,
			limitUpCount: limitUp,
			leadingStocks: [],
			source: "iwencai",
		});
	}
	return concepts;
}

async function fetchExternalConcepts(): Promise<{ concepts: ExternalConceptData[]; error?: string }> {
	try {
		const hotResult = await iwencaiScreenTool.execute("theme-hot", {
			query: "近5日涨幅前20的概念板块",
			mode: "plate",
			limit: 20,
		});
		const hotDetails = (hotResult.details ?? {}) as { success?: boolean; results?: unknown[] };
		const hotConcepts = parseIwencaiPlateResult(hotDetails);

		const limitUpResult = await iwencaiScreenTool.execute("theme-limitup", {
			query: "今日涨停家数前20的概念板块",
			mode: "plate",
			limit: 20,
		});
		const limitUpDetails = (limitUpResult.details ?? {}) as { success?: boolean; results?: unknown[] };
		const limitUpConcepts = parseIwencaiPlateResult(limitUpDetails);

		// Merge limit-up counts into hot concepts.
		const merged = new Map<string, ExternalConceptData>();
		for (const c of hotConcepts) merged.set(c.name, c);
		for (const c of limitUpConcepts) {
			const existing = merged.get(c.name);
			if (existing) {
				existing.limitUpCount = c.limitUpCount ?? existing.limitUpCount;
				if (existing.turnoverYi == null) existing.turnoverYi = c.turnoverYi;
			} else {
				merged.set(c.name, c);
			}
		}
		return { concepts: [...merged.values()] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { concepts: [], error: message };
	}
}

export const analyzeMarketThemeTool: AgentTool<typeof analyzeMarketThemeParams, AnalyzeMarketThemeDetails> = {
	name: "analyze_market_theme",
	label: "A股主线识别",
	description:
		"基于最近 N 日本地市场数据，识别 A 股市场主线、次级热点、龙头中军、情绪周期和主线持续性。输出严格遵循 a-share-primary-theme-identification 技能的 8 节模板。",
	parameters: analyzeMarketThemeParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "数据库未初始化，无法执行市场主线分析。" }],
				details: {
					analysis: {} as MarketThemeAnalysis,
					window: { startDate: "", endDate: "", lookbackDays: 0 },
				},
			};
		}

		const { concepts: externalConcepts, error: externalError } = await fetchExternalConcepts();

		const options: ThemeOptions = {
			lookbackDays: params.lookback_days ?? 5,
			endDate: params.end_date,
			externalConcepts,
		};

		const analysis = await analyzeMarketTheme(store, options);
		const text = formatMarketTheme(analysis);
		const notice = externalError ? `\n\n（外部概念数据获取失败：${externalError}，已使用本地数据）` : "";

		return {
			content: [{ type: "text", text: text + notice }],
			details: {
				analysis,
				window: analysis.window,
				externalConcepts,
				externalError,
			},
		};
	},
};
