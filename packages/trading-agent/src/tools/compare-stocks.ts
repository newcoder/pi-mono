import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore, getDataSync } from "../data/index.js";
import type { QuoteRow } from "../data/types.js";

const FETCH_TIMEOUT_MS = 15000;

const compareStocksParams = Type.Object({
	codes: Type.Array(Type.String({ description: "6位股票代码" }), {
		minItems: 2,
		maxItems: 5,
		description: "股票代码列表",
	}),
});

interface CompareStocksDetails {
	codes: string[];
	quotes: Record<string, StockQuote>;
}

interface StockQuote {
	code: string;
	name: string;
	price: number | null;
	changePct: number | null;
	pe: number | null;
	pb: number | null;
	marketCap: number | null;
	volume: number | null;
	turnover: number | null;
}

function inferMarket(code: string): number {
	return code.startsWith("6") ? 1 : 0;
}

function quoteRowToStockQuote(q: QuoteRow): StockQuote {
	return {
		code: q.code,
		name: q.name || q.code,
		price: q.latest,
		changePct: q.change_pct,
		pe: q.pe,
		pb: q.pb,
		marketCap: q.total_cap,
		volume: q.volume,
		turnover: q.turnover,
	};
}

async function fetchFromApi(codes: string[]): Promise<Record<string, StockQuote>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(`https://qt.gtimg.cn/q=${codes.join(",")}`, { signal: controller.signal });
		if (!resp.ok) throw new Error(`Quote API error: ${resp.status}`);
		const text = await resp.text();
		const result: Record<string, StockQuote> = {};
		for (const line of text.split(";")) {
			const m = line.match(/v_(\w+)="([^"]*)"/);
			if (!m) continue;
			const parts = m[2].split("~");
			if (parts.length < 45) continue;
			result[m[1]] = {
				code: parts[2],
				name: parts[1],
				price: parseFloat(parts[3]) || null,
				changePct: parseFloat(parts[5]) || null,
				pe: parseFloat(parts[39]) || null,
				pb: parseFloat(parts[46]) || null,
				marketCap: parseFloat(parts[44]) || null,
				volume: parseFloat(parts[36]) || null,
				turnover: parseFloat(parts[37]) || null,
			};
		}
		return result;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchBatchQuotes(codes: string[]): Promise<Record<string, StockQuote>> {
	const result: Record<string, StockQuote> = {};
	const missing: string[] = [];

	// 1. Try local DB first
	const store = getDataStore();
	if (store) {
		try {
			const rows = await store.getLatestQuotes(codes);
			for (const row of rows) {
				if (!row.name) {
					try {
						const stock = await store.getStock(row.code);
						if (stock) row.name = stock.name;
					} catch {
						/* ignore */
					}
				}
				result[row.code] = quoteRowToStockQuote(row);
			}
		} catch (e) {
			console.warn("[compare_stocks] DB query failed:", e);
		}
	}

	// Identify missing codes
	for (const code of codes) {
		if (!result[code]) missing.push(code);
	}

	// 2. Try sync service for missing codes
	const sync = getDataSync();
	if (missing.length > 0 && sync) {
		const stillMissing: string[] = [];
		for (const code of missing) {
			try {
				const row = await sync.getQuoteWithCache(code, inferMarket(code));
				if (row) {
					result[code] = quoteRowToStockQuote(row);
				} else {
					stillMissing.push(code);
				}
			} catch (e) {
				console.warn(`[compare_stocks] Sync fetch failed for ${code}:`, e);
				stillMissing.push(code);
			}
		}
		missing.length = 0;
		missing.push(...stillMissing);
	}

	// 3. Fall back to API for any remaining missing codes
	if (missing.length > 0) {
		try {
			const apiQuotes = await fetchFromApi(missing);
			Object.assign(result, apiQuotes);
		} catch (e) {
			console.warn("[compare_stocks] API fetch failed:", e);
		}
	}

	return result;
}

function formatComparison(data: { codes: string[]; quotes: Record<string, StockQuote> }): string {
	const { quotes } = data;
	const rows = Object.values(quotes);
	if (rows.length === 0) return "未能获取任何股票数据。";

	const fmt = (n: number | null, digits = 2) => {
		if (n == null || Number.isNaN(n)) return "—";
		return n.toFixed(digits);
	};

	const lines: string[] = ["【股票对比】"];
	lines.push("代码    名称      最新价    涨跌幅%   PE      PB      市值(亿)   换手%");
	lines.push("-".repeat(70));
	for (const r of rows) {
		const name = (r.name || "").padEnd(6);
		lines.push(
			`${r.code}  ${name}  ${fmt(r.price)}   ${fmt(r.changePct)}    ${fmt(r.pe)}  ${fmt(r.pb)}  ${fmt(r.marketCap)}   ${fmt(r.turnover)}`,
		);
	}
	return lines.join("\n");
}

export const compareStocksTool: AgentTool<typeof compareStocksParams, CompareStocksDetails> = {
	name: "compare_stocks",
	label: "股票对比",
	description: "对比2-5只股票的关键指标：价格、涨跌幅、PE、PB、市值、换手率。优先从本地数据库读取。",
	parameters: compareStocksParams,
	execute: async (_id, params) => {
		const quotes = await fetchBatchQuotes(params.codes);
		const data = { codes: params.codes, quotes };
		return {
			content: [{ type: "text", text: formatComparison(data) }],
			details: data,
		};
	},
};
