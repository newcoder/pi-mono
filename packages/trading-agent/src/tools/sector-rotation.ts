import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataSync } from "../data/index.js";

const sectorRotationParams = Type.Object({});

interface SectorRotationDetails {
	sectors: SectorItem[];
	timestamp: string;
}

const FETCH_TIMEOUT_MS = 15000;

interface SectorItem {
	name: string;
	changePct: number;
	leadingStock: string | null | undefined;
	leadingStockCode: string | null | undefined;
	leadingChangePct: number | null | undefined;
	volumeRatio: number | null | undefined;
	capitalInflow?: number | null | undefined;
}

async function fetchSectorData(): Promise<SectorItem[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(
			"https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f13,f14,f3,f128,f136,f140,f141",
			{ signal: controller.signal },
		);
		if (!resp.ok) throw new Error(`Sector API error: ${resp.status}`);
		const json = (await resp.json()) as {
			data?: { diff?: Array<{ f14?: unknown; f3?: unknown; f128?: unknown; f136?: unknown; f140?: unknown }> };
		};
		const list = json?.data?.diff || [];
		return list.map((item) => ({
			name: String(item.f14 ?? ""),
			changePct: Number(item.f3 ?? 0),
			leadingStock: item.f128 ? String(item.f128) : null,
			leadingStockCode: item.f140 ? String(item.f140) : null,
			leadingChangePct: item.f136 != null ? Number(item.f136) : null,
			volumeRatio: null,
			capitalInflow: null,
		}));
	} finally {
		clearTimeout(timer);
	}
}

function formatSectorRotation(data: { sectors: SectorItem[]; timestamp: string }): string {
	const { sectors } = data;
	if (sectors.length === 0) return "暂无板块数据。";

	const hot = sectors.filter((s) => s.changePct > 0).slice(0, 10);
	const cold = sectors
		.filter((s) => s.changePct < 0)
		.slice(-10)
		.reverse();

	const lines: string[] = ["【板块轮动】"];

	lines.push("\n[涨] 热门板块 (涨幅前10):");
	for (const s of hot) {
		const lead = s.leadingStock ? ` 龙头:${s.leadingStock}(${s.leadingChangePct?.toFixed(2)}%)` : "";
		lines.push(`  ${s.name} +${s.changePct.toFixed(2)}%${lead}`);
	}

	lines.push("\n[跌] 冷门板块 (跌幅前10):");
	for (const s of cold) {
		const lead = s.leadingStock ? ` 龙头:${s.leadingStock}(${s.leadingChangePct?.toFixed(2)}%)` : "";
		lines.push(`  ${s.name} ${s.changePct.toFixed(2)}%${lead}`);
	}

	return lines.join("\n");
}

export const getSectorRotationTool: AgentTool<typeof sectorRotationParams, SectorRotationDetails> = {
	name: "get_sector_rotation",
	label: "板块轮动",
	description: "获取A股板块涨跌排行，识别热门和冷门板块及其龙头股。优先从本地数据库读取。",
	parameters: sectorRotationParams,
	execute: async () => {
		const sync = getDataSync();

		if (sync) {
			try {
				const rows = await sync.getSectorsWithCache();
				const sectors: SectorItem[] = rows.map((r) => ({
					name: r.name,
					changePct: r.change_pct ?? 0,
					leadingStock: r.leading_stock,
					leadingStockCode: r.leading_stock_code,
					leadingChangePct: r.leading_change_pct,
					volumeRatio: r.volume_ratio,
				}));
				const data = { sectors, timestamp: new Date().toISOString() };
				return {
					content: [{ type: "text", text: formatSectorRotation(data) }],
					details: data,
				};
			} catch (e) {
				console.warn("[get_sector_rotation] Cache fetch failed:", e);
			}
		}

		const sectors = await fetchSectorData();
		const data = { sectors, timestamp: new Date().toISOString() };
		return {
			content: [{ type: "text", text: formatSectorRotation(data) }],
			details: data,
		};
	},
};
