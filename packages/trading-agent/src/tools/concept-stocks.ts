import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore, getDataSync } from "../data/index.js";
import type { ConceptStockRow } from "../data/types.js";

const listConceptsParams = Type.Object({});

const conceptStocksParams = Type.Object({
	concept: Type.String({ description: "概念名称，如 人工智能、新能源、芯片" }),
});

interface ConceptStocksDetails {
	concept: string;
	stocks: ConceptStock[];
}

interface ConceptStock {
	code: string;
	name: string;
	price: number | null;
	changePct: number | null;
}

const FETCH_TIMEOUT_MS = 15000;

async function fetchConceptStocksFromApi(conceptName: string): Promise<{ concept: string; stocks: ConceptStock[] }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		// First, search for the concept code
		const searchResp = await fetch(
			`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(conceptName)}&type=14&count=5`,
			{ signal: controller.signal },
		);
		if (!searchResp.ok) throw new Error(`Concept search API error: ${searchResp.status}`);
		const searchJson = (await searchResp.json()) as any;
		const suggestions = searchJson?.QuotationCodeTable?.Data || [];
		if (suggestions.length === 0) {
			return { concept: conceptName, stocks: [] };
		}

		const conceptCode = suggestions[0].Code as string;
		const conceptLabel = suggestions[0].Name as string;

		// Fetch stocks in this concept
		const listResp = await fetch(
			`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${conceptCode}&fields=f12,f14,f2,f3`,
			{ signal: controller.signal },
		);
		if (!listResp.ok) throw new Error(`Concept stocks API error: ${listResp.status}`);
		const listJson = (await listResp.json()) as any;
		const list = listJson?.data?.diff || [];

		const stocks: ConceptStock[] = list.map((item: any) => ({
			code: item.f12 || "",
			name: item.f14 || "",
			price: item.f2 ? parseFloat(item.f2) : null,
			changePct: item.f3 ? parseFloat(item.f3) : null,
		}));

		return { concept: conceptLabel, stocks };
	} finally {
		clearTimeout(timer);
	}
}

function rowToConceptStock(row: ConceptStockRow): ConceptStock {
	return {
		code: row.code,
		name: row.name || row.code,
		price: null,
		changePct: null,
	};
}

async function fetchConceptStocks(conceptName: string): Promise<{ concept: string; stocks: ConceptStock[] }> {
	// 1. Try local DB first
	const store = getDataStore();
	if (store) {
		try {
			const rows = await store.getConceptStocks(conceptName);
			if (rows.length > 0) {
				return {
					concept: conceptName,
					stocks: rows.map(rowToConceptStock),
				};
			}
		} catch (e) {
			console.warn(`[get_concept_stocks] DB query failed for "${conceptName}":`, e);
		}
	}

	// 2. Try sync service (may trigger background fetch via Python script)
	const sync = getDataSync();
	if (sync) {
		try {
			const rows = await sync.getConceptStocksWithCache(conceptName);
			if (rows.length > 0) {
				return {
					concept: conceptName,
					stocks: rows.map(rowToConceptStock),
				};
			}
		} catch (e) {
			console.warn(`[get_concept_stocks] Sync fetch failed for "${conceptName}":`, e);
		}
	}

	// 3. Fall back to direct API
	return fetchConceptStocksFromApi(conceptName);
}

function formatConceptStocks(data: { concept: string; stocks: ConceptStock[] }): string {
	const { concept, stocks } = data;
	if (stocks.length === 0) return `未找到概念 "${concept}" 的相关股票。`;

	const lines: string[] = [`【${concept} 概念股】共${stocks.length}只`];

	// Sort by change pct desc
	const sorted = [...stocks].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
	const top10 = sorted.slice(0, 10);
	const bottom5 = sorted.slice(-5).reverse();

	lines.push("\n涨幅前列:");
	for (const s of top10) {
		const sign = (s.changePct ?? 0) >= 0 ? "+" : "";
		lines.push(`  ${s.code} ${s.name}  ${s.price ?? "—"}  ${sign}${s.changePct?.toFixed(2) ?? "—"}%`);
	}

	lines.push("\n跌幅前列:");
	for (const s of bottom5) {
		lines.push(`  ${s.code} ${s.name}  ${s.price ?? "—"}  ${s.changePct?.toFixed(2) ?? "—"}%`);
	}

	return lines.join("\n");
}

interface ConceptListDetails {
	count: number;
	concepts: string[];
}

function formatConceptList(data: ConceptListDetails): string {
	if (data.concepts.length === 0) return "暂无概念数据。请先执行概念同步。";
	const lines: string[] = [`【概念列表】共${data.count}个概念`];
	for (let i = 0; i < data.concepts.length; i++) {
		lines.push(`  ${String(i + 1).padStart(3)}. ${data.concepts[i]}`);
	}
	return lines.join("\n");
}

export const listConceptsTool: AgentTool<typeof listConceptsParams, ConceptListDetails> = {
	name: "list_concepts",
	label: "列出概念",
	description: "列出本地数据库中所有已同步的概念/主题列表。可用于查看有哪些概念股分类可用。",
	parameters: listConceptsParams,
	execute: async (_id, _params) => {
		const store = getDataStore();
		if (!store) {
			throw new Error("数据存储未初始化");
		}
		const concepts = await store.getAllConcepts();
		const data: ConceptListDetails = {
			count: concepts.length,
			concepts,
		};
		return {
			content: [{ type: "text", text: formatConceptList(data) }],
			details: data,
		};
	},
};

export const getConceptStocksTool: AgentTool<typeof conceptStocksParams, ConceptStocksDetails> = {
	name: "get_concept_stocks",
	label: "概念股",
	description: '按概念/主题查找相关股票，如"人工智能"、"新能源"、"芯片"等。优先从本地数据库读取。',
	parameters: conceptStocksParams,
	execute: async (_id, params) => {
		const data = await fetchConceptStocks(params.concept);
		return {
			content: [{ type: "text", text: formatConceptStocks(data) }],
			details: data,
		};
	},
};
