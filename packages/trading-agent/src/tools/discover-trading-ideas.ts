import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { checkFeasibility } from "../analysis/feasibility-check.js";
import { generateIdeas } from "../analysis/idea-generator.js";
import { classifyMarketRegime } from "../analysis/market-regime.js";
import { computeMultiFactorScores } from "../analysis/multifactor.js";
import type { MarketRegime, TradingIdea } from "../analysis/types.js";
import { getDataStore } from "../data/index.js";

const discoverParams = Type.Object({
	lookback_days: Type.Number({ default: 20, description: "回看天数，用于计算因子IC和行业动量的近期趋势" }),
	max_ideas: Type.Number({ default: 5, description: "最多返回多少个交易想法" }),
	categories: Type.Array(
		Type.Union(
			[
				Type.Literal("market_style"),
				Type.Literal("technical"),
				Type.Literal("fundamental"),
				Type.Literal("event"),
				Type.Literal("classic"),
				Type.Literal("multifactor"),
			],
			{ description: "想法来源类别" },
		),
		{
			default: ["market_style", "technical", "fundamental", "event", "classic", "multifactor"],
			description: "启用的想法来源类别",
		},
	),
	min_confidence: Type.Number({ default: 50, description: "最低置信度 0-100" }),
});

interface DiscoverDetails {
	ideas: TradingIdea[];
	regime: MarketRegime;
}

function formatIdea(idea: TradingIdea, index: number): string {
	const lines: string[] = [];
	lines.push(`\n${index + 1}. [${idea.category}] ${idea.hypothesis} (置信度: ${idea.confidence})`);
	lines.push(`   逻辑: ${idea.rationale}`);
	lines.push(`   周期: ${idea.timeframe}`);
	lines.push(`   入场: ${idea.entryCriteria}`);
	lines.push(`   出场: ${idea.exitCriteria}`);
	lines.push(`   选股: ${idea.universeFilter}`);
	lines.push(
		`   建议策略: ${idea.suggestedStrategy.strategy} ${idea.suggestedStrategy.params ? JSON.stringify(idea.suggestedStrategy.params) : ""}`,
	);
	if (idea.suggestedStrategy.industryFilter) {
		lines.push(`   行业过滤: ${JSON.stringify(idea.suggestedStrategy.industryFilter)}`);
	}
	if (idea.suggestedStrategy.sizeFilter) {
		lines.push(`   市值过滤: ${JSON.stringify(idea.suggestedStrategy.sizeFilter)}`);
	}
	lines.push(`   可行性: ${idea.feasibility.pass ? "通过" : "未通过"} — ${idea.feasibility.reason}`);
	lines.push(`   风险: ${idea.risks.join("；")}`);
	lines.push(`   失效条件: ${idea.invalidationConditions.join("；")}`);
	return lines.join("\n");
}

function formatRegime(regime: MarketRegime): string {
	const lines: string[] = [];
	lines.push(`当前市场风格: ${regime.regime}`);
	lines.push(`数据最新日期: ${regime.latestDate}`);
	lines.push(`子风格: ${regime.subRegimes.join(", ") || "neutral"}`);
	if (regime.sentimentIndex != null) lines.push(`情绪指数: ${regime.sentimentIndex}`);
	if (regime.volatilityProxy != null) lines.push(`行业平均振幅: ${regime.volatilityProxy.toFixed(2)}%`);
	lines.push(
		`强势行业: ${regime.topIndustries.map((i) => `${i.name}(${(i.momentumReturn * 100).toFixed(1)}%)`).join(", ")}`,
	);
	lines.push("因子IC快照:");
	for (const [name, snap] of Object.entries(regime.factorIcSnapshot)) {
		lines.push(
			`  ${name}: 最新=${snap.latest.toFixed(3)}, 20日均值=${snap.avg20d.toFixed(3)}, 方向=${snap.direction}`,
		);
	}
	return lines.join("\n");
}

export const discoverTradingIdeasTool: AgentTool<typeof discoverParams, DiscoverDetails> = {
	name: "discover_trading_ideas",
	label: "交易策略发现",
	description:
		"基于近期市场风格、行业动量、因子IC、情绪、基本面和事件，自动发现可量化的交易策略想法。仅返回结构化想法，不保存到数据库或股票池。",
	parameters: discoverParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "数据库未初始化，无法发现交易想法。" }],
				details: { ideas: [], regime: {} as MarketRegime },
			};
		}

		const lookbackDays = params.lookback_days ?? 20;
		const maxIdeas = params.max_ideas ?? 5;
		const categories = params.categories ?? ["market_style", "technical", "fundamental", "event", "classic"];
		const minConfidence = params.min_confidence ?? 50;

		const regime = await classifyMarketRegime(store, lookbackDays);
		const multiFactorContext = categories.includes("multifactor")
			? await computeMultiFactorScores(store, regime.latestDate, { lookbackDays: 60 })
			: null;
		const candidates = generateIdeas(regime, categories, maxIdeas * 2, multiFactorContext);

		// Run lightweight feasibility checks in parallel
		const checked = await Promise.all(
			candidates.map(async (idea) => {
				const feasibility = await checkFeasibility(store, idea);
				idea.feasibility = feasibility;
				idea.dataSnapshot.lookbackDays = lookbackDays;
				return idea;
			}),
		);

		const ideas = checked
			.filter((idea) => idea.feasibility.pass && idea.confidence >= minConfidence)
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, maxIdeas);

		const textParts: string[] = [];
		textParts.push(formatRegime(regime));
		textParts.push("\n--- 候选交易想法 ---");
		if (ideas.length === 0) {
			textParts.push(
				"\n当前市场条件下未通过可行性筛选的交易想法。建议扩大 categories、降低 min_confidence 或增加 lookback_days 后重试。",
			);
		} else {
			for (const [i, idea] of ideas.entries()) {
				textParts.push(formatIdea(idea, i));
			}
		}

		return {
			content: [{ type: "text", text: textParts.join("\n") }],
			details: { ideas, regime },
		};
	},
};
