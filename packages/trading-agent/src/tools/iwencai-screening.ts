import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { runJsonScript } from "./_utils.js";

const iwencaiScreenParams = Type.Object({
	query: Type.Optional(
		Type.String({ description: "自然语言查询条件，如 '今日涨幅超5%的A股'、'MACD金叉且成交量放大'" }),
	),
	preset: Type.Optional(
		Type.Union(
			[
				Type.Literal("涨停股"),
				Type.Literal("强势股"),
				Type.Literal("主力流入"),
				Type.Literal("MACD金叉"),
				Type.Literal("低价股"),
				Type.Literal("次新股"),
				Type.Literal("高ROE"),
				Type.Literal("破净股"),
				Type.Literal("热门行业"),
				Type.Literal("行业资金"),
				Type.Literal("热门概念"),
				Type.Literal("概念资金"),
			],
			{ description: "预设模板（query 和 preset 二选一）" },
		),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("stock"), Type.Literal("plate")], {
			description: "查询模式: stock=股票(默认), plate=板块",
			default: "stock",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "返回条数", default: 20 })),
	allPages: Type.Optional(Type.Boolean({ description: "获取所有结果（自动翻页）", default: false })),
});

interface IwencaiScreenDetails {
	success: boolean;
	query: string;
	mode: string;
	count: number;
	filtered: number;
	elapsed_ms: number;
	columns: Array<{ key: string; name: string }>;
	results: unknown[];
}

function formatResult(data: IwencaiScreenDetails): string {
	if (!data.success) {
		return `【iWencai 查询失败】${data.query ?? ""}\n错误: ${(data as any).error ?? "未知错误"}`;
	}

	const results = data.results ?? [];
	if (results.length === 0) {
		return `【iWencai 查询结果】${data.query}\n未找到符合条件的结果。`;
	}

	const lines: string[] = [`【iWencai 查询结果】${data.query}`];
	lines.push(`共 ${data.count} 条 (${data.elapsed_ms}ms)`);
	if (data.filtered > 0) {
		lines.push(`(已过滤 ${data.filtered} 条)`);
	}
	lines.push("");

	// Determine display columns based on available data
	const row = results[0] as Record<string, unknown>;
	const isPlate = data.mode === "plate" || "板块名称" in row;

	if (isPlate) {
		// Plate mode: 指数简称, 最新涨跌幅:前复权:, etc.
		const nameKey =
			"指数简称" in row
				? "指数简称"
				: "板块名称" in row
					? "板块名称"
					: "股票简称" in row
						? "股票简称"
						: Object.keys(row)[0];
		const changeKey =
			"最新涨跌幅:前复权:" in row
				? "最新涨跌幅:前复权:"
				: "板块涨跌幅" in row
					? "板块涨跌幅"
					: "最新涨跌幅" in row
						? "最新涨跌幅"
						: "涨跌幅" in row
							? "涨跌幅"
							: null;
		const priceKey = "最新价" in row ? "最新价" : null;
		const flowKey = "主力净流入" in row ? "主力净流入" : null;

		for (const r of results) {
			const row = r as Record<string, unknown>;
			const name = String(row[nameKey] ?? "—");
			const change = changeKey ? String(row[changeKey] ?? "—") : null;
			const price = priceKey ? String(row[priceKey] ?? "—") : null;
			const flow = flowKey ? String(row[flowKey] ?? "—") : null;
			const parts = [name];
			if (price) parts.push(`价:${price}`);
			if (change) parts.push(`涨:${change}`);
			if (flow) parts.push(`主力:${flow}`);
			lines.push(parts.join(" | "));
		}
	} else {
		// Stock mode: show 股票代码, 股票简称, 最新价, 涨跌幅, etc.
		const codeKey = "股票代码" in row ? "股票代码" : "代码" in row ? "代码" : null;
		const nameKey = "股票简称" in row ? "股票简称" : "名称" in row ? "名称" : null;
		const priceKey = "最新价" in row ? "最新价" : "现价" in row ? "现价" : null;
		const changeKey = "最新涨跌幅" in row ? "最新涨跌幅" : "涨跌幅" in row ? "涨跌幅" : null;
		const peKey = "市盈率" in row ? "市盈率" : "PE" in row ? "PE" : null;
		const pbKey = "市净率" in row ? "市净率" : "PB" in row ? "PB" : null;

		for (const r of results.slice(0, 50)) {
			const row = r as Record<string, unknown>;
			const code = codeKey ? String(row[codeKey] ?? "—") : "—";
			const name = nameKey ? String(row[nameKey] ?? "—") : "—";
			const price = priceKey ? String(row[priceKey] ?? "—") : null;
			const change = changeKey ? String(row[changeKey] ?? "—") : null;
			const pe = peKey ? String(row[peKey] ?? "—") : null;
			const pb = pbKey ? String(row[pbKey] ?? "—") : null;
			const parts = [`${code} ${name}`];
			if (price) parts.push(`价:${price}`);
			if (change) parts.push(`涨:${change}`);
			if (pe) parts.push(`PE:${pe}`);
			if (pb) parts.push(`PB:${pb}`);
			lines.push(parts.join(" | "));
		}
		if (results.length > 50) {
			lines.push(`... 共 ${results.length} 条，仅显示前 50 条`);
		}
	}

	return lines.join("\n");
}

export const iwencaiScreenTool: AgentTool<typeof iwencaiScreenParams, IwencaiScreenDetails> = {
	name: "iwencai_screen",
	label: "iWencai选股",
	description:
		"使用同花顺问财(iWencai)自然语言选股/选板块。支持预设模板或自定义查询条件，可查询股票或板块。示例: '今日涨幅超5%的A股'、'MACD金叉且成交量放大'、'主力资金净流入前20的板块'。",
	parameters: iwencaiScreenParams,
	execute: async (_id, params) => {
		if (!params.query && !params.preset) {
			return {
				content: [{ type: "text", text: "【错误】请提供 query（自然语言查询）或 preset（预设模板）之一。" }],
				details: {
					success: false,
					error: "Missing query or preset",
					query: "",
					mode: "stock",
					count: 0,
					filtered: 0,
					elapsed_ms: 0,
					columns: [],
					results: [],
				},
			};
		}

		const args: string[] = [];
		if (params.query) args.push("--query", params.query);
		if (params.preset) args.push("--preset", params.preset);
		if (params.mode) args.push("--mode", params.mode);
		if (params.limit != null) args.push("--limit", String(params.limit));
		if (params.allPages) args.push("--all");

		const data = await runJsonScript("iwencai_screener.py", args, 60_000);
		return {
			content: [{ type: "text", text: formatResult(data as IwencaiScreenDetails) }],
			details: data as IwencaiScreenDetails,
		};
	},
};
