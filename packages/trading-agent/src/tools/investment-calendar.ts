import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";
import { runJsonScript } from "./_utils.js";

const refreshCalendarParams = Type.Object({
	scope: Type.Union([Type.Literal("market"), Type.Literal("stock")], {
		description: "刷新范围: market=市场整体事件, stock=个股事件",
		default: "market",
	}),
	code: Type.Optional(Type.String({ description: "股票代码，当 scope=stock 时必填" })),
	startDate: Type.Optional(Type.String({ description: "开始日期 (YYYY-MM-DD)" })),
	endDate: Type.Optional(Type.String({ description: "结束日期 (YYYY-MM-DD)" })),
});

export const refreshCalendarTool: AgentTool<
	typeof refreshCalendarParams,
	{ refreshed: number; scope: string; code?: string }
> = {
	name: "refresh_calendar",
	label: "刷新投资日历",
	description:
		"刷新投资日历事件数据。获取未来1-2个月及回溯1个月的市场事件（宏观数据发布、行业展会、限售解禁、财报披露等）和个股事件。市场整体事件包含硬编码的季节性事件（WWDC、SNEC、两会等）和从iWencai/akshare获取的动态事件。",
	parameters: refreshCalendarParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "【错误】DataStore 未初始化，无法刷新日历。" }],
				details: { refreshed: 0, scope: params.scope },
			};
		}

		const scope = params.scope || "market";
		if (scope === "stock" && !params.code) {
			return {
				content: [{ type: "text", text: "【错误】scope=stock 时必须提供 code（股票代码）。" }],
				details: { refreshed: 0, scope },
			};
		}

		const args = scope === "stock" && params.code ? ["--refresh-stock", params.code] : ["--refresh-market"];
		if (params.startDate) args.push("--since", params.startDate);
		if (params.endDate) args.push("--until", params.endDate);

		console.log(`[refresh_calendar] 开始刷新投资日历 (scope=${scope})...`);
		const startTime = Date.now();

		try {
			// Clean up existing events in the target date range to avoid duplicates
			const refreshStart = params.startDate || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
			const refreshEnd = params.endDate || new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
			await store.deleteCalendarEventsInRange(refreshStart, refreshEnd);

			const result = await runJsonScript("investment_calendar.py", args, 120_000);

			if (result.success && result.events && result.events.length > 0) {
				await store.saveCalendarEvents(result.events);
			}

			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			const count = result.count ?? 0;

			const lines = [
				`【投资日历刷新完成】`,
				`范围: ${scope === "market" ? "市场整体" : `个股 ${params.code}`}`,
				`事件数量: ${count} 条`,
				`耗时: ${elapsed} 秒`,
			];

			if (scope === "market") {
				lines.push("", "事件来源:");
				lines.push("- 硬编码季节性事件: WWDC、CES、SNEC、两会、OPEC+会议等");
				lines.push("- iWencai API: 宏观数据发布、业绩预告、股东大会");
				lines.push("- akshare: 限售解禁、业绩预告");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { refreshed: count, scope, code: params.code },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text", text: `【投资日历刷新失败】\n错误: ${msg}` }],
				details: { refreshed: 0, scope, code: params.code },
			};
		}
	},
};
