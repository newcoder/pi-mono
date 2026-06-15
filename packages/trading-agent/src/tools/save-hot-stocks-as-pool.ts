import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";
import { runAStockDataJsonScript } from "./_utils.js";

const saveHotStocksParams = Type.Object({
	date: Type.Optional(Type.String({ description: "日期，格式 YYYY-MM-DD，不填则使用今天" })),
	limit: Type.Optional(Type.Number({ description: "最大股票数量，默认50", default: 50 })),
	poolName: Type.Optional(Type.String({ description: "自定义股池名称，不填则自动生成（同花顺强势股_日期）" })),
});

interface SaveHotStocksDetails {
	poolId?: number;
	poolName?: string;
	count?: number;
	date?: string;
	stocks?: Array<{ code: string; name: string; change_pct: number; reason: string }>;
	error?: string;
}

export const saveHotStocksAsPoolTool: AgentTool<typeof saveHotStocksParams, SaveHotStocksDetails> = {
	name: "save_hot_stocks_as_pool",
	label: "保存强势股为股票池",
	description:
		"获取同花顺当日强势股（热点）数据，并保存为一个新的股票池。股票池名称会自动带上日期后缀，如「同花顺强势股_2026-05-26」。每只股票包含代码、名称、题材归因和涨跌幅信息。",
	parameters: saveHotStocksParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "数据库未初始化，无法保存股票池。" }],
				details: { error: "DataStore not initialized" },
			};
		}

		// 1. Fetch hot stocks from THS
		const args: string[] = [];
		if (params.date) args.push("--date", params.date);
		if (params.limit) args.push("--limit", String(params.limit));

		let result: any;
		try {
			result = await runAStockDataJsonScript("get_hot_stocks.py", args, 30000);
		} catch (e) {
			return {
				content: [{ type: "text", text: `获取同花顺强势股数据失败: ${e}` }],
				details: { error: String(e) },
			};
		}

		const rows = result.rows || [];
		const date = result.date || params.date || new Date().toISOString().slice(0, 10);

		if (rows.length === 0) {
			return {
				content: [{ type: "text", text: `${date} 暂无同花顺强势股数据。` }],
				details: { date, count: 0 },
			};
		}

		// 2. Determine pool name
		const poolName = params.poolName || `同花顺强势股_${date}`;

		// 3. Check if pool already exists
		const existing = await store.getStockPoolByName(poolName);
		if (existing) {
			return {
				content: [
					{
						type: "text",
						text: `股票池 "${poolName}" 已存在（ID: ${existing.id}）。如需重新生成，请先删除旧股池。`,
					},
				],
				details: { existing },
			};
		}

		// 4. Create pool
		const poolId = await store.createStockPool(poolName, `${date} 同花顺热点强势股，共${rows.length}只`);

		// 5. Add items with names
		const items = rows.map((row: any) => ({
			code: String(row.code),
			market: Number(row.market),
			name: row.name || undefined,
		}));
		await store.addToStockPool(poolId, items);

		// 6. Build summary
		const lines = [
			`股票池 "${poolName}" 创建成功（ID: ${poolId}），共 ${rows.length} 只股票。`,
			"",
			"【强势股列表】",
		];
		for (let i = 0; i < Math.min(rows.length, 20); i++) {
			const r = rows[i];
			const sign = r.change_pct >= 0 ? "+" : "";
			lines.push(`${i + 1}. ${r.name}(${r.code}) ${sign}${r.change_pct.toFixed(2)}%  ${r.reason}`);
		}
		if (rows.length > 20) {
			lines.push(`... 共 ${rows.length} 只，前20只已展示`);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				poolId,
				poolName,
				count: rows.length,
				date,
				stocks: rows.map((r: any) => ({
					code: r.code,
					name: r.name,
					change_pct: r.change_pct,
					reason: r.reason,
				})),
			},
		};
	},
};
