import { describe, expect, it, vi } from "vitest";
import { checkFeasibility } from "../analysis/feasibility-check.js";
import { generateIdeas } from "../analysis/idea-generator.js";
import { classifyMarketRegime } from "../analysis/market-regime.js";
import type { MultiFactorContext } from "../analysis/multifactor.js";
import type { MarketRegime } from "../analysis/types.js";
import type { DataStore } from "../data/index.js";

vi.mock("../data/index.js", () => ({
	getDataStore: vi.fn(),
	requireStore: vi.fn(),
}));

vi.mock("../analysis/backtest-validator.js", () => ({
	validateIdea: vi.fn(),
	metricsToConfidence: vi.fn(),
}));

vi.mock("../analysis/robustness-check.js", () => ({
	checkRobustness: vi.fn(),
	robustnessScore: vi.fn(),
}));

function makeValidationResult(success: boolean, confidence: number) {
	return {
		success,
		reason: success ? "回测验证通过" : "回测验证失败",
		metrics: success
			? { totalReturn: 5.2, sharpeRatio: 0.8, winRate: 55, profitFactor: 1.3, maxDrawdown: 8.5, totalTrades: 12 }
			: null,
		validatedConfidence: confidence,
		elapsedMs: 450,
	};
}

function makeRobustnessResult(success: boolean, score: number) {
	return {
		success,
		score,
		parameterCv: 0.2,
		timeConsistency: 0.67,
		poolCv: 0.3,
		reason: "参数稳定性好 (CV=0.20); 时间稳定性好 (67%窗口盈利); 股票池稳定性一般 (CV=0.30)",
	};
}

function createMockStore(overrides?: {
	latestDate?: string;
	factorIc?: Record<string, number[]>;
	industries?: Array<{ code: string; name: string; momentum_return: number; momentum_rank: number }>;
	universeCount?: number;
	klineCount?: number;
	upRatio?: number;
	volatility?: number;
}): DataStore {
	const latestDate = overrides?.latestDate ?? "2026-06-23";
	const factorIc = overrides?.factorIc ?? {
		industry_momentum_20d_forward5d: [0.06, 0.07, 0.08],
		size_forward5d: [-0.04, -0.05, -0.06],
		size_forward10d: [-0.03, -0.04, -0.05],
		size_forward20d: [-0.02, -0.03, -0.04],
	};
	const industries =
		overrides?.industries ??
		Array.from({ length: 5 }, (_, i) => ({
			code: `8010${i + 1}0`,
			name: `行业${i + 1}`,
			momentum_return: 0.05 + i * 0.01,
			momentum_rank: i + 1,
		}));

	return {
		query: vi.fn(async (sql: string) => {
			const lower = sql.toLowerCase();
			if (
				lower.includes("'factor_ic'") ||
				lower.includes("'industry_indicators'") ||
				lower.includes("'industry_quotes'") ||
				lower.includes("'quotes'")
			) {
				return [
					{ source: "factor_ic", max_date: latestDate },
					{ source: "industry_indicators", max_date: latestDate },
					{ source: "industry_quotes", max_date: latestDate },
					{ source: "quotes", max_date: latestDate },
				] as any;
			}
			if (lower.includes("industry_indicators") && lower.includes("order by ii.momentum_rank asc")) {
				return industries as any;
			}
			if (lower.includes("industry_indicators") && lower.includes("order by ii.momentum_rank desc")) {
				return [...industries].reverse() as any;
			}
			if (lower.includes("avg(amplitude)")) {
				return [{ avg_amplitude: overrides?.volatility ?? 3.5 }] as any;
			}
			if (lower.includes("avg(case when change_pct > 0")) {
				return [{ up_ratio: overrides?.upRatio ?? 0.65 }] as any;
			}
			if (lower.includes("count(distinct") && lower.includes("stock_industries")) {
				return [{ count: overrides?.universeCount ?? 200 }] as any;
			}
			if (lower.includes("count(*) as count from (") && lower.includes("quotes")) {
				return [{ count: overrides?.universeCount ?? 100 }] as any;
			}
			if (lower.includes("count(distinct q.code)") && lower.includes("pe")) {
				return [{ count: overrides?.universeCount ?? 150 }] as any;
			}
			if (lower.includes("count(distinct code) as count") && lower.includes("klines")) {
				return [{ count: overrides?.universeCount ?? 2000 }] as any;
			}
			if (lower.includes("count(distinct date) as count")) {
				return [{ count: overrides?.klineCount ?? 25 }] as any;
			}
			return [] as any;
		}),
		getFactorIc: vi.fn(async (factorName: string) => {
			const values = factorIc[factorName] ?? [];
			return values.map((v, i) => ({
				date: `2026-06-${21 + i}`,
				factor_name: factorName,
				ic_value: v,
				sample_count: 1000,
				updated_at: "2026-06-23T00:00:00Z",
			}));
		}),
	} as unknown as DataStore;
}

describe("market-regime", () => {
	it("classifies strong momentum and small-cap regime", async () => {
		const store = createMockStore();
		const regime = await classifyMarketRegime(store, 20);

		expect(regime.latestDate).toBe("2026-06-23");
		expect(regime.subRegimes).toContain("strong_momentum");
		expect(regime.subRegimes).toContain("small_cap_favored");
		expect(regime.factorIcSnapshot.industry_momentum_20d_forward5d.direction).toBe("positive");
		expect(regime.topIndustries.length).toBe(5);
		expect(regime.sentimentIndex).toBe(65);
	});

	it("classifies bearish sentiment when up ratio is low", async () => {
		const store = createMockStore({ upRatio: 0.25, volatility: 4 });
		const regime = await classifyMarketRegime(store, 20);

		expect(regime.subRegimes).toContain("bearish_sentiment");
		expect(regime.subRegimes).toContain("high_volatility");
	});
});

describe("idea-generator", () => {
	it("generates market-style ideas when momentum is strong", () => {
		const regime: MarketRegime = {
			regime: "strong_momentum_small_cap_favored",
			subRegimes: ["strong_momentum", "small_cap_favored"],
			latestDate: "2026-06-23",
			topIndustries: [
				{ code: "801010", name: "煤炭", momentumReturn: 0.08, rank: 1 },
				{ code: "801080", name: "电子", momentumReturn: 0.06, rank: 2 },
			],
			weakIndustries: [],
			factorIcSnapshot: {
				industry_momentum_20d_forward5d: {
					latest: 0.08,
					avg20d: 0.07,
					direction: "positive",
					ir: 1.0,
					hitRate: 0.65,
					tStat: 2.0,
				},
				size_forward5d: {
					latest: -0.05,
					avg20d: -0.05,
					direction: "negative",
					ir: -0.8,
					hitRate: 0.35,
					tStat: -1.8,
				},
				size_forward10d: {
					latest: -0.04,
					avg20d: -0.04,
					direction: "negative",
					ir: -0.8,
					hitRate: 0.35,
					tStat: -1.8,
				},
				size_forward20d: {
					latest: -0.03,
					avg20d: -0.03,
					direction: "negative",
					ir: -0.8,
					hitRate: 0.35,
					tStat: -1.8,
				},
			},
			sentimentIndex: 65,
			volatilityProxy: 2.5,
		};
		const ideas = generateIdeas(regime, ["market_style"], 5);
		expect(ideas.length).toBeGreaterThan(0);
		expect(ideas[0].category).toBe("market_style");
		expect(ideas[0].suggestedStrategy.strategy).toBe("supertrend");
	});

	it("generates classic ideas when regime is favorable", () => {
		const regime: MarketRegime = {
			regime: "bullish_momentum",
			subRegimes: ["bullish_sentiment", "strong_momentum"],
			latestDate: "2026-06-23",
			topIndustries: [{ code: "801010", name: "煤炭", momentumReturn: 0.08, rank: 1 }],
			weakIndustries: [],
			factorIcSnapshot: {
				industry_momentum_20d_forward5d: {
					latest: 0.08,
					avg20d: 0.07,
					direction: "positive",
					ir: 1.0,
					hitRate: 0.65,
					tStat: 2.0,
				},
				size_forward5d: {
					latest: 0,
					avg20d: 0,
					direction: "neutral",
					ir: 0,
					hitRate: 0.5,
					tStat: 0,
				},
				size_forward10d: {
					latest: 0,
					avg20d: 0,
					direction: "neutral",
					ir: 0,
					hitRate: 0.5,
					tStat: 0,
				},
				size_forward20d: {
					latest: 0,
					avg20d: 0,
					direction: "neutral",
					ir: 0,
					hitRate: 0.5,
					tStat: 0,
				},
			},
			sentimentIndex: 65,
			volatilityProxy: 2.5,
		};
		const ideas = generateIdeas(regime, ["classic"], 5);
		expect(ideas.length).toBeGreaterThan(0);
		const strategies = ideas.map((i) => i.suggestedStrategy.strategy);
		expect(strategies).toContain("ma_cross");
	});

	it("generates multifactor idea when context is provided", () => {
		const regime: MarketRegime = {
			regime: "neutral",
			subRegimes: [],
			latestDate: "2026-06-23",
			topIndustries: [],
			weakIndustries: [],
			factorIcSnapshot: {
				industry_momentum_20d_forward5d: {
					latest: 0.05,
					avg20d: 0.05,
					direction: "positive",
					ir: 0.6,
					hitRate: 0.55,
					tStat: 2.0,
				},
				size_forward5d: {
					latest: 0,
					avg20d: 0,
					direction: "neutral",
					ir: 0,
					hitRate: 0.5,
					tStat: 0,
				},
				size_forward10d: {
					latest: 0,
					avg20d: 0,
					direction: "neutral",
					ir: 0,
					hitRate: 0.5,
					tStat: 0,
				},
				size_forward20d: {
					latest: 0,
					avg20d: 0,
					direction: "neutral",
					ir: 0,
					hitRate: 0.5,
					tStat: 0,
				},
			},
			sentimentIndex: 50,
			volatilityProxy: 2.0,
		};
		const multiFactorContext: MultiFactorContext = {
			scores: Array.from({ length: 100 }, (_, i) => ({
				code: `00000${i}`,
				name: `股票${i}`,
				market: 0,
				valueZ: 0.5,
				momentumZ: 0.3,
				qualityZ: 0.4,
				lowVolZ: 0.2,
				composite: 0.5 + i * 0.01,
			})),
			topScores: Array.from({ length: 20 }, (_, i) => ({
				code: `00000${i}`,
				name: `股票${i}`,
				market: 0,
				valueZ: 1.0,
				momentumZ: 0.8,
				qualityZ: 0.9,
				lowVolZ: 0.7,
				composite: 1.0 + i * 0.01,
			})),
			bottomScores: [],
			stats: {
				value: { mean: 0, std: 1 },
				momentum: { mean: 0, std: 1 },
				quality: { mean: 0, std: 1 },
				lowVol: { mean: 0, std: 1 },
			},
			latestDate: "2026-06-23",
			lookbackDays: 60,
		};
		const ideas = generateIdeas(regime, ["multifactor"], 5, multiFactorContext);
		expect(ideas.length).toBe(1);
		expect(ideas[0].category).toBe("market_style");
		expect(ideas[0].suggestedStrategy.strategy).toBe("ma_cross");
		expect(ideas[0].universeFilter).toContain("多因子综合评分前");
	});
});

describe("feasibility-check", () => {
	it("fails when universe is too small", async () => {
		const store = createMockStore({ universeCount: 3 });
		const regime: MarketRegime = {
			regime: "strong_momentum",
			subRegimes: ["strong_momentum"],
			latestDate: "2026-06-23",
			topIndustries: [{ code: "801010", name: "煤炭", momentumReturn: 0.08, rank: 1 }],
			weakIndustries: [],
			factorIcSnapshot: {
				industry_momentum_20d_forward5d: {
					latest: 0.08,
					avg20d: 0.07,
					direction: "positive",
					ir: 1.0,
					hitRate: 0.65,
					tStat: 2.0,
				},
				size_forward5d: { latest: 0, avg20d: 0, direction: "neutral", ir: 0, hitRate: 0.5, tStat: 0 },
				size_forward10d: { latest: 0, avg20d: 0, direction: "neutral", ir: 0, hitRate: 0.5, tStat: 0 },
				size_forward20d: { latest: 0, avg20d: 0, direction: "neutral", ir: 0, hitRate: 0.5, tStat: 0 },
			},
			sentimentIndex: 65,
			volatilityProxy: 2.5,
		};
		const ideas = generateIdeas(regime, ["market_style"], 5);
		expect(ideas.length).toBeGreaterThan(0);

		const result = await checkFeasibility(store, ideas[0]);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain("少于最小要求");
	});

	it("passes when data is healthy", async () => {
		const store = createMockStore({ universeCount: 200, klineCount: 25 });
		const regime: MarketRegime = {
			regime: "strong_momentum",
			subRegimes: ["strong_momentum"],
			latestDate: "2026-06-23",
			topIndustries: [{ code: "801010", name: "煤炭", momentumReturn: 0.08, rank: 1 }],
			weakIndustries: [],
			factorIcSnapshot: {
				industry_momentum_20d_forward5d: {
					latest: 0.08,
					avg20d: 0.07,
					direction: "positive",
					ir: 1.0,
					hitRate: 0.65,
					tStat: 2.0,
				},
				size_forward5d: { latest: 0, avg20d: 0, direction: "neutral", ir: 0, hitRate: 0.5, tStat: 0 },
				size_forward10d: { latest: 0, avg20d: 0, direction: "neutral", ir: 0, hitRate: 0.5, tStat: 0 },
				size_forward20d: { latest: 0, avg20d: 0, direction: "neutral", ir: 0, hitRate: 0.5, tStat: 0 },
			},
			sentimentIndex: 65,
			volatilityProxy: 2.5,
		};
		const ideas = generateIdeas(regime, ["market_style"], 5);
		const result = await checkFeasibility(store, ideas[0]);
		expect(result.pass).toBe(true);
	});
});

describe("discover-trading-ideas tool", () => {
	it("returns structured ideas with backtest validation", async () => {
		const { getDataStore } = await import("../data/index.js");
		const { validateIdea } = await import("../analysis/backtest-validator.js");
		const { checkRobustness } = await import("../analysis/robustness-check.js");
		const store = createMockStore({ universeCount: 200, klineCount: 25 });
		vi.mocked(getDataStore).mockReturnValue(store);
		vi.mocked(validateIdea).mockResolvedValue(makeValidationResult(true, 65));
		vi.mocked(checkRobustness).mockResolvedValue(makeRobustnessResult(true, 75));

		const { discoverTradingIdeasTool } = await import("./discover-trading-ideas.js");
		const result = await discoverTradingIdeasTool.execute("test", {
			lookback_days: 20,
			max_ideas: 3,
			categories: ["market_style"],
			min_confidence: 50,
		});

		expect(result.details.ideas.length).toBeGreaterThan(0);
		expect(result.details.ideas[0].hypothesis).toBeTruthy();
		expect(result.details.ideas[0].feasibility.pass).toBe(true);
		expect(result.details.ideas[0].backtestValidation).toBeDefined();
		expect(result.details.ideas[0].backtestValidation!.success).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("当前市场风格");
		expect((result.content[0] as { text: string }).text).toContain("回测验证");
	});

	it("still returns ideas when backtest validation fails", async () => {
		const { getDataStore } = await import("../data/index.js");
		const { validateIdea } = await import("../analysis/backtest-validator.js");
		const { checkRobustness } = await import("../analysis/robustness-check.js");
		const store = createMockStore({ universeCount: 200, klineCount: 25 });
		vi.mocked(getDataStore).mockReturnValue(store);
		vi.mocked(validateIdea).mockResolvedValue(makeValidationResult(false, 20));
		vi.mocked(checkRobustness).mockResolvedValue(makeRobustnessResult(false, 0));

		const { discoverTradingIdeasTool } = await import("./discover-trading-ideas.js");
		const result = await discoverTradingIdeasTool.execute("test", {
			lookback_days: 20,
			max_ideas: 3,
			categories: ["market_style"],
			min_confidence: 50,
		});

		expect(result.details.ideas.length).toBe(0);
		expect((result.content[0] as { text: string }).text).toContain("未通过");
	});

	it("returns empty ideas when no data store", async () => {
		const { getDataStore } = await import("../data/index.js");
		vi.mocked(getDataStore).mockReturnValue(null);

		const { discoverTradingIdeasTool } = await import("./discover-trading-ideas.js");
		const result = await discoverTradingIdeasTool.execute("test", {
			lookback_days: 20,
			max_ideas: 5,
			categories: ["market_style", "technical", "fundamental", "event", "classic"],
			min_confidence: 50,
		});

		expect(result.details.ideas.length).toBe(0);
		expect((result.content[0] as { text: string }).text).toContain("数据库未初始化");
	});
});
