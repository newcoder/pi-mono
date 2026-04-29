import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { resolveAShareScript, runJsonScript } from "./_utils.js";

const sentimentParams = Type.Object({
	date: Type.Optional(Type.String({ description: "日期 (YYYY-MM-DD)，默认今天" })),
	detail: Type.Optional(Type.Boolean({ description: "是否输出板块涨跌分布", default: false })),
});

interface SentimentData {
	date: string;
	trading_date: string;
	advance: number | null;
	decline: number | null;
	flat: number | null;
	total: number | null;
	limit_up: number;
	limit_down: number;
	northbound_flow: number;
	sentiment_index: number;
	note?: string;
}

function renderProgressBar(value: number, width = 20): string {
	const filled = Math.round((value / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

function sentimentLabel(index: number): string {
	if (index >= 80) return "强烈偏多";
	if (index >= 60) return "偏多";
	if (index >= 40) return "中性";
	if (index >= 20) return "偏空";
	return "强烈偏空";
}

function formatSentiment(data: SentimentData): string {
	const lines: string[] = [];
	lines.push(`【市场情绪快照】${data.date} 15:00`);
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	lines.push(
		`涨跌分布  上涨 ${data.advance?.toLocaleString() ?? "-"} │ 下跌 ${data.decline?.toLocaleString() ?? "-"} │ 平盘 ${data.flat?.toLocaleString() ?? "-"}`,
	);
	lines.push(`涨停跌停  涨停 ${data.limit_up}   │ 跌停 ${data.limit_down}`);
	const nbSign = data.northbound_flow >= 0 ? "+" : "";
	lines.push(`北向资金  净流入 ${nbSign}${data.northbound_flow} 亿`);
	const bar = renderProgressBar(data.sentiment_index);
	lines.push(`情绪指数  ${data.sentiment_index}/100 [${bar}] ${sentimentLabel(data.sentiment_index)}`);
	return lines.join("\n");
}

export const analyzeSentimentTool: AgentTool<typeof sentimentParams, SentimentData> = {
	name: "analyze_sentiment",
	label: "市场情绪分析",
	description: "获取并分析A股市场整体情绪：涨跌家数、涨停跌停数、北向资金流向，计算情绪指数(0-100)。",
	parameters: sentimentParams,
	execute: async (_id, params) => {
		const args: string[] = [];
		if (params.date) {
			args.push("--date", params.date);
		}

		const scriptPath = resolveAShareScript("market_sentiment_fetcher.py");
		const data: SentimentData = await runJsonScript(scriptPath, args, 300000);

		const text = formatSentiment(data);

		return {
			content: [{ type: "text", text }],
			details: data,
		};
	},
};
