import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { runPython } from "./_utils.js";

const SCRIPTS_DIR = join(
	process.env.HOME || process.env.USERPROFILE || ".",
	".agents/skills/nl-stock-screener/scripts",
);

// ── get_stock_news tool ─────────────────────────────────────────────────────

const getStockNewsParams = Type.Object({
	code: Type.String({ description: "股票代码，如600519" }),
	days: Type.Optional(Type.Number({ description: "查询最近N天的新闻", default: 7 })),
	eventTypes: Type.Optional(
		Type.Array(Type.String(), {
			description: "筛选特定事件类型，如['减持','定增']",
		}),
	),
});

interface NewsItem {
	title: string;
	source: string;
	pub_time: string;
	url: string;
	event_type: string | null;
	sentiment: string;
	impact_level: string;
}

function formatNewsDetail(data: { code: string; total: number; news: NewsItem[] }, days: number): string {
	if (!data.news || data.news.length === 0) return `${data.code} 最近${days}天内无相关新闻。`;

	const lines: string[] = [`【${data.code} 新闻资讯】最近${days}天共 ${data.total} 条`];

	// Group by event type
	const grouped: Record<string, NewsItem[]> = {};
	for (const item of data.news) {
		const et = item.event_type || "其他";
		if (!grouped[et]) grouped[et] = [];
		grouped[et].push(item);
	}

	for (const [eventType, items] of Object.entries(grouped)) {
		lines.push(`\n▸ ${eventType} (${items.length}条)`);
		for (const item of items.slice(0, 5)) {
			const sentimentLabel =
				item.sentiment === "negative" ? "[利空]" : item.sentiment === "positive" ? "[利好]" : "[中性]";
			lines.push(`  ${sentimentLabel} [${item.source}] ${item.title}`);
			lines.push(`     ${item.pub_time} | 影响:${item.impact_level} | ${item.url}`);
		}
		if (items.length > 5) {
			lines.push(`  ... 还有 ${items.length - 5} 条`);
		}
	}

	return lines.join("\n");
}

export const getStockNewsTool: AgentTool<typeof getStockNewsParams, unknown> = {
	name: "get_stock_news",
	label: "个股新闻",
	description: "获取指定股票最近的新闻资讯，包括利空/利多事件分类。数据来自本地数据库（需先同步）。",
	parameters: getStockNewsParams,
	execute: async (_id, params) => {
		const tmpDir = mkdtempSync(join(tmpdir(), "news-"));
		const outputPath = join(tmpDir, "result.json");

		try {
			const args = ["detail", "--code", params.code, "--days", String(params.days || 7), "--output", outputPath];

			if (params.eventTypes && params.eventTypes.length > 0) {
				args.push("--event-types", params.eventTypes.join(","));
			}

			await runPython(join(SCRIPTS_DIR, "news_screening.py"), args, 30000);

			const raw = readFileSync(outputPath, "utf-8");
			let result: unknown;
			try {
				result = JSON.parse(raw);
			} catch (e) {
				throw new Error(`Failed to parse news detail result: ${e instanceof Error ? e.message : String(e)}`);
			}

			return {
				content: [
					{
						type: "text",
						text: formatNewsDetail(result as { code: string; total: number; news: NewsItem[] }, params.days || 7),
					},
				],
				details: result,
			};
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	},
};

// ── screen_by_news tool ────────────────────────────────────────────────────

const screenByNewsParams = Type.Object({
	eventTypes: Type.Optional(
		Type.Array(Type.String(), {
			description: "事件类型，如['减持','定增','业绩预亏']等",
		}),
	),
	sentiment: Type.Optional(
		Type.Union([Type.Literal("positive"), Type.Literal("negative")], {
			description: "情绪筛选: positive(利多) / negative(利空)",
		}),
	),
	impactLevel: Type.Optional(
		Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
			description: "影响程度: high/medium/low",
		}),
	),
	days: Type.Optional(Type.Number({ description: "时间窗口(天)", default: 7 })),
	limit: Type.Optional(Type.Number({ description: "最大返回数量", default: 50 })),
});

interface NewsScreenResult {
	code: string;
	name: string;
	event_count: number;
	event_types: string;
	latest_time: string;
	latest_title: string;
}

function formatNewsScreen(data: {
	parameters: Record<string, unknown>;
	total: number;
	results: NewsScreenResult[];
}): string {
	if (!data.results || data.results.length === 0) {
		return "未找到符合条件的股票。提示：请先运行新闻同步（news_sync.py）确保本地数据库有新闻数据。";
	}

	const lines: string[] = [
		`【新闻筛选结果】条件: ${JSON.stringify(data.parameters)}`,
		`共找到 ${data.total} 只股票`,
		"",
		"| 代码 | 名称 | 事件数 | 事件类型 | 最新时间 | 最新标题 |",
		"|------|------|--------|----------|----------|----------|",
	];

	for (const r of data.results) {
		const name = r.name || "—";
		const title = r.latest_title.length > 30 ? `${r.latest_title.slice(0, 30)}...` : r.latest_title;
		lines.push(
			`| ${r.code} | ${name} | ${r.event_count} | ${r.event_types} | ${r.latest_time.slice(0, 10)} | ${title} |`,
		);
	}

	return lines.join("\n");
}

export const screenByNewsTool: AgentTool<typeof screenByNewsParams, unknown> = {
	name: "screen_by_news",
	label: "新闻筛选",
	description: `基于新闻事件筛选股票。支持按事件类型(减持/增持/定增/业绩预亏/业绩预增/回购/解禁等)、情绪(利多/利空)、影响程度、时间窗口筛选。

使用场景:
- "最近一周有高管减持的股票"
- "最近发布业绩预增的股票"
- "最近有利空消息的股票"

事件类型列表:
利空: 减持, 定增, 业绩预亏, 业绩亏损, 业绩下滑, 解禁, 监管处罚, 质押风险, 诉讼仲裁
利多: 增持, 业绩预增, 业绩增长, 回购, 分红, 重大合同, 产品突破`,
	parameters: screenByNewsParams,
	execute: async (_id, params) => {
		const tmpDir = mkdtempSync(join(tmpdir(), "news-screen-"));
		const outputPath = join(tmpDir, "result.json");

		try {
			const args = [
				"screen",
				"--days",
				String(params.days || 7),
				"--limit",
				String(params.limit || 50),
				"--output",
				outputPath,
			];

			if (params.eventTypes && params.eventTypes.length > 0) {
				args.push("--event-types", params.eventTypes.join(","));
			}
			if (params.sentiment) {
				args.push("--sentiment", params.sentiment);
			}
			if (params.impactLevel) {
				args.push("--impact", params.impactLevel);
			}

			await runPython(join(SCRIPTS_DIR, "news_screening.py"), args, 30000);

			const raw = readFileSync(outputPath, "utf-8");
			let result: unknown;
			try {
				result = JSON.parse(raw);
			} catch (e) {
				throw new Error(`Failed to parse news screen result: ${e instanceof Error ? e.message : String(e)}`);
			}

			return {
				content: [
					{
						type: "text",
						text: formatNewsScreen(
							result as { parameters: Record<string, unknown>; total: number; results: NewsScreenResult[] },
						),
					},
				],
				details: result,
			};
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	},
};

// ── get_market_news tool ────────────────────────────────────────────────────

const getMarketNewsParams = Type.Object({
	mode: Type.Union([Type.Literal("query"), Type.Literal("stats")], {
		description: "query=查询新闻列表, stats=统计概览",
		default: "query",
	}),
	days: Type.Optional(Type.Number({ description: "查询最近N天的新闻", default: 7 })),
	newsTypes: Type.Optional(
		Type.Array(Type.String(), {
			description: "筛选新闻类型: 政策/宏观/行业/国际/监管/其他",
		}),
	),
	sentiment: Type.Optional(
		Type.Union([Type.Literal("positive"), Type.Literal("negative"), Type.Literal("neutral")], {
			description: "情绪筛选: positive(利好)/negative(利空)/neutral(中性)",
		}),
	),
	impactScope: Type.Optional(
		Type.Union([Type.Literal("market_wide"), Type.Literal("sector_specific"), Type.Literal("mixed")], {
			description: "影响范围: market_wide(市场级)/sector_specific(行业级)/mixed(混合)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "最大返回数量", default: 50 })),
});

interface MarketNewsItem {
	title: string;
	source: string;
	pub_time: string;
	url: string;
	news_type: string;
	sentiment: string;
	impact_scope: string;
	affected_sectors: { benefit: string[]; harm: string[] };
}

function formatMarketNewsQuery(
	data: {
		parameters: Record<string, unknown>;
		total: number;
		news: MarketNewsItem[];
	},
	days: number,
): string {
	if (!data.news || data.news.length === 0) return `最近${days}天内无相关市场新闻。`;

	const lines: string[] = [`【市场宏观新闻】最近${days}天共 ${data.total} 条`];

	// Group by news type
	const grouped: Record<string, MarketNewsItem[]> = {};
	for (const item of data.news) {
		const nt = item.news_type || "其他";
		if (!grouped[nt]) grouped[nt] = [];
		grouped[nt].push(item);
	}

	for (const [newsType, items] of Object.entries(grouped)) {
		lines.push(`\n▸ ${newsType} (${items.length}条)`);
		for (const item of items.slice(0, 5)) {
			const sentimentLabel =
				item.sentiment === "negative" ? "[利空]" : item.sentiment === "positive" ? "[利好]" : "[中性]";
			lines.push(`  ${sentimentLabel} [${item.source}] ${item.title}`);
			if (item.affected_sectors?.benefit?.length || item.affected_sectors?.harm?.length) {
				const parts: string[] = [];
				if (item.affected_sectors?.benefit?.length) parts.push(`受益:${item.affected_sectors.benefit.join(",")}`);
				if (item.affected_sectors?.harm?.length) parts.push(`承压:${item.affected_sectors.harm.join(",")}`);
				lines.push(`     ${item.pub_time} | ${parts.join(" | ")}`);
			} else {
				lines.push(`     ${item.pub_time}`);
			}
		}
		if (items.length > 5) {
			lines.push(`  ... 还有 ${items.length - 5} 条`);
		}
	}

	return lines.join("\n");
}

function formatMarketNewsStats(data: {
	days: number;
	type_distribution: Record<string, { total: number; positive: number; negative: number; neutral: number }>;
	top_benefit_sectors: [string, number][];
	top_harm_sectors: [string, number][];
}): string {
	const lines: string[] = [`【市场新闻统计】最近${data.days}天`];

	// Type distribution
	lines.push("\n▸ 新闻类型分布");
	for (const [nt, stats] of Object.entries(data.type_distribution)) {
		lines.push(`  ${nt}: 共${stats.total}条 (利好${stats.positive} 利空${stats.negative} 中性${stats.neutral})`);
	}

	// Top benefit sectors
	if (data.top_benefit_sectors.length > 0) {
		lines.push("\n▸ 受益板块TOP10");
		for (const [sector, count] of data.top_benefit_sectors) {
			lines.push(`  ${sector}: ${count}次`);
		}
	}

	// Top harm sectors
	if (data.top_harm_sectors.length > 0) {
		lines.push("\n▸ 承压板块TOP10");
		for (const [sector, count] of data.top_harm_sectors) {
			lines.push(`  ${sector}: ${count}次`);
		}
	}

	return lines.join("\n");
}

export const getMarketNewsTool: AgentTool<typeof getMarketNewsParams, unknown> = {
	name: "get_market_news",
	label: "市场宏观新闻",
	description: `获取市场宏观新闻和财经要闻，分析对市场/行业的影响。支持查询新闻列表和统计概览两种模式。

使用场景:
- "最近有什么重要的财经新闻"
- "最近的政策新闻有哪些"
- "哪些板块最近受益/承压"
- "市场新闻统计概览"

新闻类型: 政策, 宏观, 行业, 国际, 监管, 其他

注意: 数据来自本地数据库，需先通过 market_news_sync.py 同步新闻数据。`,
	parameters: getMarketNewsParams,
	execute: async (_id, params) => {
		const tmpDir = mkdtempSync(join(tmpdir(), "mkt-news-"));
		const outputPath = join(tmpDir, "result.json");
		const mode = params.mode || "query";

		try {
			const args = [mode, "--days", String(params.days || 7), "--output", outputPath];

			if (mode === "query") {
				if (params.newsTypes && params.newsTypes.length > 0) {
					args.push("--news-types", params.newsTypes.join(","));
				}
				if (params.sentiment) {
					args.push("--sentiment", params.sentiment);
				}
				if (params.impactScope) {
					args.push("--impact-scope", params.impactScope);
				}
				if (params.limit) {
					args.push("--limit", String(params.limit));
				}
			}

			await runPython(join(SCRIPTS_DIR, "market_news_query.py"), args, 30000);

			const raw = readFileSync(outputPath, "utf-8");
			let result: unknown;
			try {
				result = JSON.parse(raw);
			} catch (e) {
				throw new Error(`Failed to parse market news result: ${e instanceof Error ? e.message : String(e)}`);
			}

			let text: string;
			if (mode === "stats") {
				text = formatMarketNewsStats(
					result as {
						days: number;
						type_distribution: Record<
							string,
							{ total: number; positive: number; negative: number; neutral: number }
						>;
						top_benefit_sectors: [string, number][];
						top_harm_sectors: [string, number][];
					},
				);
			} else {
				text = formatMarketNewsQuery(
					result as { parameters: Record<string, unknown>; total: number; news: MarketNewsItem[] },
					params.days || 7,
				);
			}

			return {
				content: [{ type: "text", text }],
				details: result,
			};
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	},
};
