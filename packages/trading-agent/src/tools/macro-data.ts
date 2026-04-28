import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataSync } from "../data/index.js";

const macroParams = Type.Object({});

interface MacroIndex {
	name: string;
	latest: number | null | undefined;
	change: number | null | undefined;
	changePct: number | null | undefined;
}

interface MacroData {
	usMarkets: Record<string, MacroIndex>;
	a50: MacroIndex | null;
	fx: MacroIndex | null;
	timestamp: string;
}

const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(url, { ...options, signal: controller.signal });
		return resp;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchSinaQuotes(codes: string[]): Promise<Record<string, string>> {
	const url = `https://hq.sinajs.cn/list=${codes.join(",")}`;
	const resp = await fetchWithTimeout(url, {
		headers: { Referer: "https://finance.sina.com.cn" },
	});
	if (!resp.ok) throw new Error(`Sina API error: ${resp.status}`);

	const buffer = await resp.arrayBuffer();
	// Sina returns GBK; decode manually if needed, but most index data is ASCII-safe
	const text = new TextDecoder("gbk").decode(buffer);

	const results: Record<string, string> = {};
	for (const line of text.split(";")) {
		const match = line.match(/var hq_str_(\w+)="([^"]*)"/);
		if (match) results[match[1]] = match[2];
	}
	return results;
}

function parseUsIndex(name: string, raw: string): MacroIndex {
	const parts = raw.split(",");
	// Format: 名称,最新价,涨跌额,涨跌幅
	return {
		name,
		latest: parts[1] ? parseFloat(parts[1]) : null,
		change: parts[2] ? parseFloat(parts[2]) : null,
		changePct: parts[3] ? parseFloat(parts[3]) : null,
	};
}

function parseA50(raw: string): MacroIndex {
	const parts = raw.split(",");
	// Format: 最新价,,买价,卖价,最高,最低,时间,昨收,开盘,持仓,买量,卖量,日期,名称,?
	if (parts.length < 14) return { name: "A50期货", latest: null, change: null, changePct: null };
	const latest = parseFloat(parts[0]);
	const prev = parseFloat(parts[7]);
	const change = latest - prev;
	const changePct = prev ? (change / prev) * 100 : 0;
	return { name: parts[13] || "A50期货", latest, change, changePct };
}

function parseFx(raw: string): MacroIndex {
	const parts = raw.split(",");
	// Format: 时间,买入价,最新价,卖出价,?,最高,最低,?,昨收,名称,涨跌额,涨跌幅,?,振幅,?
	if (parts.length < 12) return { name: "USDCNH", latest: null, change: null, changePct: null };
	const latest = parseFloat(parts[2]);
	const change = parseFloat(parts[10]);
	const changePct = parseFloat(parts[11]);
	return { name: parts[9] || "USDCNH", latest, change, changePct };
}

export async function fetchMacroData(): Promise<MacroData> {
	const codes = ["int_nasdaq", "int_sp500", "int_dji", "hf_CHA50CFD", "fx_susdcnh"];
	const raw = await fetchSinaQuotes(codes);

	return {
		timestamp: new Date().toISOString(),
		usMarkets: {
			NDX: parseUsIndex("纳斯达克", raw.int_nasdaq || ""),
			SPX: parseUsIndex("标普500", raw.int_sp500 || ""),
			DJI: parseUsIndex("道琼斯", raw.int_dji || ""),
		},
		a50: raw.hf_CHA50CFD ? parseA50(raw.hf_CHA50CFD) : null,
		fx: raw.fx_susdcnh ? parseFx(raw.fx_susdcnh) : null,
	};
}

function formatMacro(data: MacroData): string {
	const lines: string[] = ["【隔夜全球市场概况】"];

	lines.push("\n美股市场：");
	for (const [, idx] of Object.entries(data.usMarkets)) {
		if (idx.latest == null) {
			lines.push(`  ${idx.name}: 数据 unavailable`);
		} else {
			const sign = (idx.changePct ?? 0) >= 0 ? "+" : "";
			lines.push(`  ${idx.name}: ${idx.latest.toFixed(2)} (${sign}${idx.changePct?.toFixed(2)}%)`);
		}
	}

	if (data.a50) {
		const sign = (data.a50.changePct ?? 0) >= 0 ? "+" : "";
		lines.push(`\nA50 期货: ${data.a50.latest?.toFixed(2)} (${sign}${data.a50.changePct?.toFixed(2)}%)`);
	}

	if (data.fx) {
		const sign = (data.fx.changePct ?? 0) >= 0 ? "+" : "";
		lines.push(`离岸人民币: ${data.fx.latest?.toFixed(4)} (${sign}${data.fx.changePct?.toFixed(3)}%)`);
	}

	return lines.join("\n");
}

export const getMacroTool: AgentTool<typeof macroParams, MacroData> = {
	name: "get_macro",
	label: "获取宏观",
	description: "获取隔夜全球市场宏观数据：美股三大指数、富时A50期货、美元兑人民币汇率。优先从本地数据库读取。",
	parameters: macroParams,
	execute: async () => {
		const sync = getDataSync();

		if (sync) {
			try {
				const row = await sync.getMacroWithCache();
				const data: MacroData = {
					timestamp: new Date().toISOString(),
					usMarkets: {
						NDX: {
							name: "纳斯达克",
							latest: row.ndx_latest,
							change: null,
							changePct: row.ndx_change_pct ?? null,
						},
						SPX: { name: "标普500", latest: row.spx_latest, change: null, changePct: row.spx_change_pct ?? null },
						DJI: { name: "道琼斯", latest: row.dji_latest, change: null, changePct: row.dji_change_pct ?? null },
					},
					a50:
						row.a50_latest != null
							? { name: "A50期货", latest: row.a50_latest, change: null, changePct: row.a50_change_pct ?? null }
							: null,
					fx:
						row.usdcnh_latest != null
							? {
									name: "USDCNH",
									latest: row.usdcnh_latest,
									change: null,
									changePct: row.usdcnh_change_pct ?? null,
								}
							: null,
				};
				return {
					content: [{ type: "text", text: formatMacro(data) }],
					details: data,
				};
			} catch (e) {
				console.warn("[get_macro] Cache fetch failed:", e);
			}
		}

		const data = await fetchMacroData();
		return {
			content: [{ type: "text", text: formatMacro(data) }],
			details: data,
		};
	},
};
