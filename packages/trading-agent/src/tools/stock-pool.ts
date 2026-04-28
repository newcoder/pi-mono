import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";

const stockPoolParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create", { description: "创建新股票池（一次性传入所有股票）" }),
			Type.Literal("list", { description: "列出所有股票池（返回编号、名称、股票数）" }),
			Type.Literal("show", { description: "显示某个股票池的内容，可通过id或name定位" }),
			Type.Literal("delete", { description: "删除股票池，可通过id或name定位" }),
		],
		{ description: "操作类型" },
	),
	name: Type.Optional(Type.String({ description: "股票池名称（create/show/delete 时使用，与id二选一）" })),
	id: Type.Optional(Type.Number({ description: "股票池编号（show/delete 时使用，与name二选一，优先使用id）" })),
	description: Type.Optional(Type.String({ description: "股票池描述（create 时可选）" })),
	codes: Type.Optional(
		Type.Array(
			Type.Object({
				code: Type.String({ description: "6位股票代码" }),
				market: Type.Union([Type.Literal(1), Type.Literal(0)], { description: "1=上海, 0=深圳" }),
				name: Type.Optional(Type.String({ description: "股票名称（可选）" })),
			}),
			{ description: "股票列表（create 时必填）" },
		),
	),
});

interface StockPoolDetails {
	poolId?: number;
	name?: string;
	count?: number;
	pools?: unknown[];
	pool?: unknown;
	items?: unknown[];
	deleted?: number;
	existing?: unknown;
	error?: string;
}

function formatPoolList(pools: any[]): string {
	if (pools.length === 0) return "暂无股票池。";
	const lines = ["【股票池列表】", ""];
	for (const p of pools) {
		lines.push(`[${p.id}] ${p.name} (${p.item_count}只)${p.description ? ` — ${p.description}` : ""}`);
	}
	return lines.join("\n");
}

function formatPoolItems(pool: any, items: any[]): string {
	if (items.length === 0) return `【${pool.name}】暂无股票。`;
	const lines = [`【${pool.name}】共${items.length}只`, ""];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		lines.push(`${i + 1}. ${item.code}${item.market === 1 ? ".SH" : ".SZ"}${item.name ? ` ${item.name}` : ""}`);
	}
	return lines.join("\n");
}

async function findPool(store: any, name?: string, id?: number) {
	if (id !== undefined && id !== null) {
		return store.getStockPoolById(id);
	}
	if (name) {
		return store.getStockPoolByName(name);
	}
	return null;
}

export const manageStockPoolTool: AgentTool<typeof stockPoolParams, StockPoolDetails> = {
	name: "manage_stock_pool",
	label: "股票池管理",
	description:
		"创建、查询、删除股票池。股票池是一组股票的命名集合（不可变），可用于后续分析、回测、对比等操作。创建时一次性传入所有股票。查询和删除可以通过编号(id)或名称(name)定位。",
	parameters: stockPoolParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "数据库未初始化，无法管理股票池。" }],
				details: { error: "DataStore not initialized" },
			};
		}

		const action = params.action;

		// ─── create ───────────────────────────────────────────────
		if (action === "create") {
			if (!params.name) {
				return {
					content: [{ type: "text", text: "创建股票池需要提供名称（name）。" }],
					details: { error: "missing name" },
				};
			}
			if (!params.codes || params.codes.length === 0) {
				return {
					content: [{ type: "text", text: "创建股票池需要提供股票列表（codes）。" }],
					details: { error: "missing codes" },
				};
			}
			// Check if name already exists
			const existing = await store.getStockPoolByName(params.name);
			if (existing) {
				return {
					content: [
						{
							type: "text",
							text: `股票池 "${params.name}" 已存在（ID: ${existing.id}）。请使用其他名称，或先删除旧池子。`,
						},
					],
					details: { existing },
				};
			}
			const poolId = await store.createStockPool(params.name, params.description);
			await store.addToStockPool(
				poolId,
				params.codes.map((c: any) => ({ code: c.code, market: c.market, name: c.name })),
			);
			return {
				content: [
					{
						type: "text",
						text: `股票池 "${params.name}" 创建成功（ID: ${poolId}），共 ${params.codes.length} 只股票。`,
					},
				],
				details: { poolId, name: params.name, count: params.codes.length },
			};
		}

		// ─── list ─────────────────────────────────────────────────
		if (action === "list") {
			const pools = await store.getStockPools();
			return {
				content: [{ type: "text", text: formatPoolList(pools) }],
				details: { pools },
			};
		}

		// ─── show ─────────────────────────────────────────────────
		if (action === "show") {
			const pool = await findPool(store, params.name, params.id);
			if (!pool) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `股票池 ${ref} 不存在。` }],
					details: { error: "pool not found" },
				};
			}
			const items = await store.getStockPoolItems(pool.id);
			return {
				content: [{ type: "text", text: formatPoolItems(pool, items) }],
				details: { pool, items },
			};
		}

		// ─── delete ───────────────────────────────────────────────
		if (action === "delete") {
			const pool = await findPool(store, params.name, params.id);
			if (!pool) {
				const ref = params.id !== undefined ? `编号 ${params.id}` : `"${params.name}"`;
				return {
					content: [{ type: "text", text: `股票池 ${ref} 不存在。` }],
					details: { error: "pool not found" },
				};
			}
			await store.deleteStockPool(pool.id);
			return {
				content: [{ type: "text", text: `股票池 "${pool.name}"（编号 ${pool.id}）已删除。` }],
				details: { deleted: pool.id },
			};
		}

		return { content: [{ type: "text", text: `未知操作: ${action}` }], details: { error: "unknown action" } };
	},
};
