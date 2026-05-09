import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { resolveConceptAnalysisScript, runJsonScript } from "./_utils.js";

// ─── verify_concept_stocks ────────────────────────────────────

const verifyConceptStocksParams = Type.Object({
	concept: Type.String({ description: "概念名称，如 华为昇腾、人工智能、芯片" }),
	minExcessCorrelation: Type.Optional(
		Type.Number({ description: "最低超额相关系数(概念相关-上证相关)，默认0.05", default: 0.05 }),
	),
	lookbackDays: Type.Optional(Type.Number({ description: "回溯天数，默认60", default: 60 })),
});

interface ConceptStockVerification {
	code: string;
	name: string;
	is_real: boolean;
	concept_corr: number;
	market_corr: number;
	excess_corr: number;
	trading_days: number;
}

interface VerifyConceptStocksResult {
	concept: string;
	lookback_days: number;
	min_excess_correlation: number;
	total_stocks: number;
	real_concept_stocks: number;
	fake_concept_stocks: number;
	stocks: ConceptStockVerification[];
	fetch_time: string;
	error?: string;
}

function formatVerifyResult(data: VerifyConceptStocksResult): string {
	const lines: string[] = [];
	lines.push(`【${data.concept} — 概念股相关性筛选（去除大盘beta影响）】`);

	if (data.error) {
		lines.push(`错误：${data.error}`);
		lines.push("提示：请先用 `--sync-concepts <概念名>` 同步概念成分股数据。");
		return lines.join("\n");
	}

	lines.push(
		`共${data.total_stocks}只成分股，真概念${data.real_concept_stocks}只，伪概念${data.fake_concept_stocks}只`,
	);
	lines.push(`筛选标准：近${data.lookback_days}天超额相关性(概念相关-上证相关) ≥ ${data.min_excess_correlation}`);
	lines.push("");

	const realStocks = data.stocks.filter((s) => s.is_real);
	const fakeStocks = data.stocks.filter((s) => !s.is_real);

	if (realStocks.length > 0) {
		lines.push(`真概念标的 (${realStocks.length}只，按超额相关性排序)：`);
		for (const s of realStocks.slice(0, 15)) {
			const stars = "★".repeat(Math.min(5, Math.max(1, Math.round(s.excess_corr * 20))));
			lines.push(`  ${s.code} ${s.name} — 超额相关性 ${s.excess_corr.toFixed(4)} ${stars} (${s.trading_days}天)`);
			lines.push(`           概念相关 ${s.concept_corr.toFixed(4)} | 上证相关 ${s.market_corr.toFixed(4)}`);
		}
		if (realStocks.length > 15) {
			lines.push(`  ... 及其他 ${realStocks.length - 15} 只`);
		}
		lines.push("");
	}

	if (fakeStocks.length > 0) {
		lines.push(`伪概念/蹭概念示例 (${Math.min(fakeStocks.length, 5)}只)：`);
		for (const s of fakeStocks.slice(-5).reverse()) {
			lines.push(
				`  ${s.code} ${s.name} — 超额相关性 ${s.excess_corr.toFixed(4)} (概念相关 ${s.concept_corr.toFixed(4)}，上证相关 ${s.market_corr.toFixed(4)})`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

export const verifyConceptStocksTool: AgentTool<typeof verifyConceptStocksParams, VerifyConceptStocksResult> = {
	name: "verify_concept_stocks",
	label: "概念股真伪验证",
	description:
		"通过计算成分股股价与概念指数的相关性（去除大盘beta影响）来筛选真正的概念股。从东方财富获取概念指数、上证指数和个股日线数据，计算近N日涨跌幅的Pearson相关系数，用股票-概念相关性与股票-上证指数相关性之差作为超额相关性，淘汰仅跟随大盘而非跟随概念走势的蹭概念股票。",
	parameters: verifyConceptStocksParams,
	execute: async (_id, params) => {
		const args: string[] = ["--concept", params.concept];
		if (params.minExcessCorrelation !== undefined) {
			args.push("--min-excess-correlation", String(params.minExcessCorrelation));
		}
		if (params.lookbackDays !== undefined) {
			args.push("--days", String(params.lookbackDays));
		}

		const scriptPath = resolveConceptAnalysisScript("concept_correlation_filter.py");
		const data: VerifyConceptStocksResult = await runJsonScript(scriptPath, args, 300000);

		return {
			content: [{ type: "text", text: formatVerifyResult(data) }],
			details: data,
		};
	},
};

// ─── find_concept_leaders ─────────────────────────────────────

const findConceptLeadersParams = Type.Object({
	concept: Type.String({ description: "概念名称，如 华为昇腾、人工智能、存储芯片" }),
	lookbackDays: Type.Optional(Type.Number({ description: "回溯天数，默认120（龙头识别需要更长周期）", default: 120 })),
	topN: Type.Optional(Type.Number({ description: "返回前N只龙头，默认10", default: 10 })),
});

interface ConceptLeader {
	code: string;
	name: string;
	concept_corr: number;
	market_cap: number;
	market_cap_yi: number;
	score: number;
}

interface FindConceptLeadersResult {
	concept: string;
	lookback_days: number;
	top_n: number;
	total_stocks: number;
	leaders: ConceptLeader[];
	fetch_time: string;
	error?: string;
}

function formatLeadersResult(data: FindConceptLeadersResult): string {
	const lines: string[] = [];
	lines.push(`【${data.concept} — 概念龙头识别】`);

	if (data.error) {
		lines.push(`错误：${data.error}`);
		return lines.join("\n");
	}

	lines.push(`分析周期：近${data.lookback_days}天 | 有效成分股：${data.total_stocks}只`);
	lines.push(`评分公式：综合得分 = 概念相关性 × ln(市值亿 + 1)`);
	lines.push("");

	if (data.leaders.length === 0) {
		lines.push("未找到符合条件的龙头股。");
		return lines.join("\n");
	}

	lines.push(`龙头股 TOP ${data.leaders.length}：`);
	for (let i = 0; i < data.leaders.length; i++) {
		const s = data.leaders[i];
		const rank = (i + 1).toString().padStart(2);
		const stars = "★".repeat(Math.min(5, Math.max(1, Math.round(s.score * 3))));
		lines.push(`  ${rank}. ${s.code} ${s.name} — 得分 ${s.score.toFixed(3)} ${stars}`);
		lines.push(`       概念相关性 ${s.concept_corr.toFixed(4)} | 市值 ${s.market_cap_yi.toFixed(1)}亿`);
	}

	lines.push("");
	lines.push("说明：综合得分同时考察'跟概念紧'（相关性高）和'有分量'（市值大），过滤纯炒作的小票。");

	return lines.join("\n");
}

export const findConceptLeadersTool: AgentTool<typeof findConceptLeadersParams, FindConceptLeadersResult> = {
	name: "find_concept_leaders",
	label: "概念龙头识别",
	description:
		"通过综合得分模型识别概念的龙头股。计算每只股票与概念指数的长期相关性，并结合市值进行对数加权（得分 = 相关性 × ln(市值亿+1)）。既能找出与概念走势高度同步的股票，又能排除没有市场分量的小市值炒作标的。",
	parameters: findConceptLeadersParams,
	execute: async (_id, params) => {
		const args: string[] = ["--concept", params.concept, "--find-leaders"];
		if (params.lookbackDays !== undefined) {
			args.push("--days", String(params.lookbackDays));
		}
		if (params.topN !== undefined) {
			args.push("--top-n", String(params.topN));
		}

		const scriptPath = resolveConceptAnalysisScript("concept_correlation_filter.py");
		const data: FindConceptLeadersResult = await runJsonScript(scriptPath, args, 300000);

		return {
			content: [{ type: "text", text: formatLeadersResult(data) }],
			details: data,
		};
	},
};

// ─── analyze_concept_persistence ──────────────────────────────

const analyzeConceptPersistenceParams = Type.Object({
	concept: Type.String({ description: "概念名称，如 人工智能、新能源、芯片" }),
	days: Type.Optional(Type.Number({ description: "回溯天数，默认30", default: 30 })),
});

interface DimensionDetail {
	score: number;
	details: Record<string, unknown>;
	weight: number;
	weighted_score: number;
}

interface ConceptPersistenceResult {
	concept: string;
	analysis_date: string;
	lookback_days: number;
	persistence_score: number;
	grade: string;
	verdict: string;
	dimensions: {
		policy: DimensionDetail;
		news: DimensionDetail;
		capital: DimensionDetail;
		technical: DimensionDetail;
		fundamentals: DimensionDetail;
	};
	stock_count: number;
}

function renderRadarChart(dimensions: ConceptPersistenceResult["dimensions"]): string {
	const dims = [
		{ name: "政策面", score: dimensions.policy.score },
		{ name: "新闻面", score: dimensions.news.score },
		{ name: "资金面", score: dimensions.capital.score },
		{ name: "技术面", score: dimensions.technical.score },
		{ name: "基本面", score: dimensions.fundamentals.score },
	];

	const lines: string[] = [];
	lines.push("五维雷达图 (0-100)：");
	for (const d of dims) {
		const filled = Math.round(d.score / 5);
		const empty = 20 - filled;
		const bar = "█".repeat(filled) + "░".repeat(empty);
		lines.push(`  ${d.name.padEnd(4)} ${bar} ${d.score.toFixed(1)}`);
	}
	return lines.join("\n");
}

function formatPersistenceResult(data: ConceptPersistenceResult): string {
	const lines: string[] = [];
	lines.push(`【${data.concept} — 概念持续性分析】`);
	lines.push(`分析周期：近${data.lookback_days}天 | 成分股数：${data.stock_count}只`);
	lines.push("");
	lines.push(`综合评分：${data.persistence_score.toFixed(1)}/100  [等级：${data.grade}]`);
	lines.push(`投资结论：${data.verdict}`);
	lines.push("");
	lines.push(renderRadarChart(data.dimensions));
	lines.push("");

	lines.push("维度详解：");
	const dimInfo = [
		{ key: "policy", name: "政策面", weight: 0.25 },
		{ key: "news", name: "新闻面", weight: 0.2 },
		{ key: "capital", name: "资金面", weight: 0.2 },
		{ key: "technical", name: "技术面", weight: 0.15 },
		{ key: "fundamentals", name: "基本面", weight: 0.2 },
	] as const;

	for (const d of dimInfo) {
		const dim = data.dimensions[d.key];
		lines.push(
			`  ${d.name} (权重${d.weight * 100}%) — 得分 ${dim.score.toFixed(1)} → 加权 ${dim.weighted_score.toFixed(2)}`,
		);
	}

	return lines.join("\n");
}

export const analyzeConceptPersistenceTool: AgentTool<
	typeof analyzeConceptPersistenceParams,
	ConceptPersistenceResult
> = {
	name: "analyze_concept_persistence",
	label: "概念持续性分析",
	description:
		"通过五维评分体系分析A股概念的炒作持续性：政策面(25%)、新闻面(20%)、资金面(20%)、技术面(15%)、基本面(20%)。输出综合评分、等级(A/B/C)和投资建议，帮助判断概念是长期主线还是短期炒作。",
	parameters: analyzeConceptPersistenceParams,
	execute: async (_id, params) => {
		const args: string[] = ["--concept", params.concept];
		if (params.days !== undefined) {
			args.push("--days", String(params.days));
		}

		const scriptPath = resolveConceptAnalysisScript("concept_persistence.py");
		const data: ConceptPersistenceResult = await runJsonScript(scriptPath, args, 60000);

		return {
			content: [{ type: "text", text: formatPersistenceResult(data) }],
			details: data,
		};
	},
};
