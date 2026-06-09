import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { resolveStockRadarScript, runPython } from "./_utils.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface RadarEvent {
	type: string;
	date: string;
	description: string;
	score: number;
	category: string;
}

interface RadarNewsItem {
	title: string;
	date: string;
	sentiment: string;
	score: number;
	source?: string;
}

interface RadarItem {
	code: string;
	name: string;
	score: number;
	event_count: number;
	news_count: number;
	direction: string;
	events: RadarEvent[];
	news: RadarNewsItem[];
}

interface RadarMeta {
	report_time: string;
	total_stocks_scanned: number;
	opportunity_count: number;
	risk_count: number;
}

interface RadarReport {
	meta: RadarMeta;
	opportunity_top: RadarItem[];
	risk_top: RadarItem[];
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function eventMarker(score: number): string {
	if (score > 0) return "[+]";
	if (score < 0) return "[-]";
	return "[ ]";
}

function newsMarker(sentiment: string): string {
	if (sentiment === "positive") return "[+]";
	if (sentiment === "negative") return "[-]";
	return "[~]";
}

function formatRadarItem(r: RadarItem, rank: number): string {
	const lines: string[] = [];
	const scoreStr = r.score >= 0 ? `+${r.score.toFixed(1)}` : r.score.toFixed(1);
	lines.push(`${rank}. ${r.code} ${r.name}  ${scoreStr}分 [事件${r.event_count}/新闻${r.news_count}] ${r.direction}`);

	for (const ev of r.events.slice(0, 3)) {
		const desc = ev.description ? ` -- ${ev.description.slice(0, 50)}` : "";
		lines.push(`   ${eventMarker(ev.score)} [${ev.date}] ${ev.type} (${ev.score > 0 ? "+" : ""}${ev.score})${desc}`);
	}
	for (const n of r.news.slice(0, 3)) {
		const src = n.source ? `${n.source} | ` : "";
		lines.push(
			`   ${newsMarker(n.sentiment)} [${n.date}] ${src}${n.title.slice(0, 50)} (${n.score > 0 ? "+" : ""}${n.score.toFixed(1)})`,
		);
	}
	return lines.join("\n");
}

function formatRadarReport(data: RadarReport, topN: number): string {
	const { meta, opportunity_top, risk_top } = data;
	const lines: string[] = [];
	lines.push(`【个股机会风险雷达】${meta.report_time}`);
	lines.push(`扫描: ${meta.total_stocks_scanned}只 | 机会: ${meta.opportunity_count}只 | 风险: ${meta.risk_count}只`);
	lines.push("");

	if (opportunity_top.length > 0) {
		lines.push(`━━━━━━━ 机会榜 TOP ${topN} ━━━━━━━`);
		for (let i = 0; i < opportunity_top.length; i++) {
			lines.push(formatRadarItem(opportunity_top[i], i + 1));
		}
		lines.push("");
	}

	if (risk_top.length > 0) {
		lines.push(`━━━━━━━ 风险榜 TOP ${topN} ━━━━━━━`);
		for (let i = 0; i < risk_top.length; i++) {
			lines.push(formatRadarItem(risk_top[i], i + 1));
		}
		lines.push("");
	}

	lines.push("*免责声明: 基于公开数据自动生成，仅供参考，不构成投资建议。*");
	return lines.join("\n");
}

// ── Tool definition ─────────────────────────────────────────────────────────

const scanStockRadarParams = Type.Object({
	universe: Type.Optional(
		Type.Union(
			[
				Type.Literal("all"),
				Type.Literal("zz1000"),
				Type.Literal("zz500"),
				Type.Literal("hs300"),
				Type.Literal("cyb"),
				Type.Literal("kcb"),
			],
			{
				description: "扫描范围：all=全市场, zz1000=中证1000, zz500=中证500, hs300=沪深300, cyb=创业板, kcb=科创板",
				default: "all",
			},
		),
	),
	top: Type.Optional(Type.Number({ description: "机会/风险榜各显示多少只", default: 30 })),
	minScore: Type.Optional(Type.Number({ description: "最小绝对评分过滤", default: 0.5 })),
	enrich: Type.Optional(Type.Number({ description: "对TOP N个股补充个股新闻，0=关闭", default: 20 })),
});

export const scanStockRadarTool: AgentTool<typeof scanStockRadarParams, RadarReport> = {
	name: "scan_stock_radar",
	label: "个股雷达扫描",
	description:
		"扫描A股中有事件/新闻动静的股票，分析利好利空，输出机会榜和风险榜。采用事件驱动架构，从iwencai事件查询（高管增减持、业绩预告、限售解禁、回购等10类事件）和财联社/东财新闻中提取有动静的股票，跳过无事件股票。支持全市场或指定指数成分股扫描。默认启用增量模式（加载历史缓存，只获取当天新数据）。",
	parameters: scanStockRadarParams,
	execute: async (_id, params) => {
		const universe = params.universe ?? "all";
		const top = params.top ?? 30;
		const minScore = params.minScore ?? 0.5;
		const enrich = params.enrich ?? 20;

		const args: string[] = [
			"--format",
			"json",
			"--universe",
			universe,
			"--top",
			String(top),
			"--min-score",
			String(minScore),
			"--enrich",
			String(enrich),
			"--incremental",
		];

		const scriptPath = resolveStockRadarScript("stock_radar.py");
		console.log(`[scan_stock_radar] 启动雷达扫描 (universe=${universe}, top=${top})...`);
		const startTime = Date.now();

		const stdout = await runPython(scriptPath, args, 300_000);

		// Extract JSON from stdout
		const start = stdout.search(/[[{]/);
		if (start === -1) {
			throw new Error(`脚本输出中未找到 JSON: ${stdout.slice(0, 200)}`);
		}
		const data: RadarReport = JSON.parse(stdout.slice(start));

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log(`[scan_stock_radar] 扫描完成，耗时 ${elapsed}s`);

		const text = formatRadarReport(data, top);

		return {
			content: [{ type: "text", text }],
			details: data,
		};
	},
};
