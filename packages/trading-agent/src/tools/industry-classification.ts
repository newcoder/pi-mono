import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";
import type { IndustryRow } from "../data/types.js";

// ─── Parameter Schemas ──────────────────────────────────────────

const listIndustriesParams = Type.Object({
	standard: Type.Optional(
		Type.Union(
			[
				Type.Literal("sw_l1"),
				Type.Literal("sw_l2"),
				Type.Literal("sw_l3"),
				Type.Literal("zjw"),
				Type.Literal("jq_l1"),
				Type.Literal("jq_l2"),
			],
			{ description: "行业分类标准，如 sw_l1=申万一级", default: "sw_l1" },
		),
	),
});

const getIndustryStocksParams = Type.Object({
	industry: Type.String({ description: '行业名称或代码，如 "白酒" 或 "801150"' }),
	standard: Type.Optional(
		Type.Union(
			[
				Type.Literal("sw_l1"),
				Type.Literal("sw_l2"),
				Type.Literal("sw_l3"),
				Type.Literal("zjw"),
				Type.Literal("jq_l1"),
				Type.Literal("jq_l2"),
			],
			{ description: "行业分类标准", default: "sw_l1" },
		),
	),
});

const getStockIndustriesParams = Type.Object({
	code: Type.String({ description: "6位股票代码，如 600519" }),
	market: Type.Optional(
		Type.Union([Type.Literal(1), Type.Literal(0)], {
			description: "1=上海, 0=深圳",
			default: 1,
		}),
	),
});

// ─── Detail Types ───────────────────────────────────────────────

interface IndustryListDetails {
	standard: string;
	count: number;
	industries: Array<{
		code: string;
		name: string;
		level?: number | null;
		parent_code?: string | null;
		stock_count?: number;
	}>;
}

interface IndustryStocksDetails {
	industry: string;
	industry_code: string;
	standard: string;
	stock_count: number;
	stocks: Array<{
		code: string;
		name: string;
		market: number;
	}>;
}

interface StockIndustriesDetails {
	code: string;
	market: number;
	standards: number;
	industries: Array<{
		standard: string;
		industry_code: string;
		industry_name: string;
		level?: number | null;
	}>;
}

// ─── Helpers ────────────────────────────────────────────────────

function inferMarket(code: string): number {
	return code.startsWith("6") ? 1 : 0;
}

function formatIndustryList(data: IndustryListDetails): string {
	const { standard, count, industries } = data;
	const standardNames: Record<string, string> = {
		sw_l1: "申万一级",
		sw_l2: "申万二级",
		sw_l3: "申万三级",
		zjw: "证监会",
		jq_l1: "聚宽一级",
		jq_l2: "聚宽二级",
	};
	const lines: string[] = [`【${standardNames[standard] ?? standard} 行业列表】共${count}个`];
	for (const ind of industries) {
		const countStr = ind.stock_count != null ? ` (${ind.stock_count}只)` : "";
		lines.push(`  ${ind.code}  ${ind.name}${countStr}`);
	}
	return lines.join("\n");
}

function formatIndustryStocks(data: IndustryStocksDetails): string {
	const { industry, industry_code, standard, stock_count, stocks } = data;
	if (stocks.length === 0) {
		return `未找到行业 "${industry}" (${industry_code}, ${standard}) 的相关股票。`;
	}
	const lines: string[] = [`【${industry}】代码: ${industry_code}  标准: ${standard}  共${stock_count}只股票`];
	for (const s of stocks) {
		lines.push(`  ${s.code} ${s.name}  ${s.market === 1 ? "SH" : "SZ"}`);
	}
	return lines.join("\n");
}

function formatStockIndustries(data: StockIndustriesDetails): string {
	const { code, market, industries } = data;
	if (industries.length === 0) {
		return `【${code}】暂无行业分类数据。`;
	}
	const lines: string[] = [`【${code} ${market === 1 ? "SH" : "SZ"} 行业分类】共${industries.length}条`];
	for (const ind of industries) {
		const levelStr = ind.level != null ? ` [L${ind.level}]` : "";
		lines.push(`  ${ind.standard.padEnd(8)}  ${ind.industry_code}  ${ind.industry_name}${levelStr}`);
	}
	return lines.join("\n");
}

// ─── Tool Implementations ───────────────────────────────────────

export const listIndustriesTool: AgentTool<typeof listIndustriesParams, IndustryListDetails> = {
	name: "list_industries",
	label: "列出行业",
	description:
		"列出所有行业分类。支持按标准筛选：sw_l1(申万一级)、sw_l2(申万二级)、sw_l3(申万三级)、zjw(证监会)、jq_l1/jq_l2(聚宽)。默认返回申万一级。",
	parameters: listIndustriesParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			throw new Error("数据存储未初始化");
		}

		const standard = params.standard ?? "sw_l1";

		// For SW standards, derive level from standard name
		const levelMap: Record<string, number> = {
			sw_l1: 1,
			sw_l2: 2,
			sw_l3: 3,
		};
		const level = levelMap[standard];

		const industries = await store.getIndustries(standard, level);

		// Get stock counts for each industry
		const resultIndustries = await Promise.all(
			industries.map(async (ind) => {
				const stocks = await store!.getIndustryStocks(ind.industry_code, standard);
				return {
					code: ind.industry_code,
					name: ind.name,
					level: ind.level,
					parent_code: ind.parent_code,
					stock_count: stocks.length,
				};
			}),
		);

		const data: IndustryListDetails = {
			standard,
			count: resultIndustries.length,
			industries: resultIndustries,
		};

		return {
			content: [{ type: "text", text: formatIndustryList(data) }],
			details: data,
		};
	},
};

export const getIndustryStocksTool: AgentTool<typeof getIndustryStocksParams, IndustryStocksDetails> = {
	name: "get_industry_stocks",
	label: "行业股票",
	description: "按行业名称或代码查询该行业下的所有股票。支持多种分类标准。优先从本地数据库读取。",
	parameters: getIndustryStocksParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			throw new Error("数据存储未初始化");
		}

		const standard = params.standard ?? "sw_l1";
		const industryInput = params.industry.trim();

		// Try to find industry by code first, then by name
		let industryRows: IndustryRow[];
		if (/^\d+$/.test(industryInput)) {
			// Numeric code — exact match
			industryRows = await store.getIndustries(standard);
			industryRows = industryRows.filter((r) => r.industry_code === industryInput);
		} else {
			// Name search
			industryRows = await store.findIndustryByName(industryInput, standard);
		}

		if (industryRows.length === 0) {
			return {
				content: [{ type: "text", text: `未找到行业 "${industryInput}" (${standard})。` }],
				details: {
					industry: industryInput,
					industry_code: "",
					standard,
					stock_count: 0,
					stocks: [],
				},
			};
		}

		// Use the first match
		const industry = industryRows[0];
		const stocks = await store.getIndustryStocks(industry.industry_code, standard);

		const data: IndustryStocksDetails = {
			industry: industry.name,
			industry_code: industry.industry_code,
			standard,
			stock_count: stocks.length,
			stocks: stocks.map((s) => ({
				code: s.code,
				name: s.name || s.code,
				market: s.market,
			})),
		};

		return {
			content: [{ type: "text", text: formatIndustryStocks(data) }],
			details: data,
		};
	},
};

export const getStockIndustriesTool: AgentTool<typeof getStockIndustriesParams, StockIndustriesDetails> = {
	name: "get_stock_industries",
	label: "股票行业",
	description: "查询一只股票在所有行业分类标准下的行业归属。优先从本地数据库读取。",
	parameters: getStockIndustriesParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			throw new Error("数据存储未初始化");
		}

		const market = params.market ?? inferMarket(params.code);
		const rows = await store.getStockIndustries(params.code, market);

		const data: StockIndustriesDetails = {
			code: params.code,
			market,
			standards: rows.length,
			industries: rows.map((r) => ({
				standard: r.standard,
				industry_code: r.industry_code,
				industry_name: (r as any).industry_name || r.industry_code,
				level: (r as any).level,
			})),
		};

		return {
			content: [{ type: "text", text: formatStockIndustries(data) }],
			details: data,
		};
	},
};
