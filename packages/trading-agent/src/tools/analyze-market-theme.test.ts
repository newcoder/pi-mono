import { describe, expect, it, vi } from "vitest";
import {
	analyzeMarketTheme,
	computeBoardStats,
	computeLianbanStocks,
	type ExternalConceptData,
	formatMarketTheme,
	identifyLeaders,
	mergeExternalConcepts,
	scoreSectors,
} from "../analysis/market-theme.js";
import type { DataStore, QuoteRow } from "../data/index.js";

vi.mock("../data/index.js", () => ({
	getDataStore: vi.fn(),
	requireStore: vi.fn(),
}));

vi.mock("./iwencai-screening.js", () => ({
	iwencaiScreenTool: { execute: vi.fn() },
}));

function makeQuote(overrides: {
	code: string;
	market?: number;
	name?: string;
	snapshot_date: string;
	change_pct: number;
	total_cap?: number;
	turnover?: number;
}): QuoteRow {
	return {
		code: overrides.code,
		market: overrides.market ?? 0,
		name: overrides.name ?? overrides.code,
		snapshot_date: overrides.snapshot_date,
		latest: 10,
		open: null,
		high: null,
		low: null,
		prev_close: null,
		volume: null,
		turnover: overrides.turnover ?? null,
		change_pct: overrides.change_pct,
		pe: null,
		pb: null,
		total_cap: overrides.total_cap ?? null,
		float_cap: null,
		high_52w: null,
		low_52w: null,
	};
}

function createMockStore(): DataStore {
	return {
		query: vi.fn(async (sql: string, _params?: unknown[]) => {
			const lower = sql.toLowerCase();
			if (lower.includes("max(snapshot_date)")) {
				return [{ max_date: "2026-06-24" }] as any;
			}
			if (lower.includes("distinct snapshot_date")) {
				return [
					{ snapshot_date: "2026-06-24" },
					{ snapshot_date: "2026-06-23" },
					{ snapshot_date: "2026-06-22" },
					{ snapshot_date: "2026-06-21" },
					{ snapshot_date: "2026-06-20" },
				] as any;
			}
			if (
				lower.includes("from quotes") &&
				(lower.includes("between") || (lower.includes(">=") && lower.includes("<=")))
			) {
				return [
					makeQuote({ code: "000001", name: "平安", snapshot_date: "2026-06-20", change_pct: 2, total_cap: 3000 }),
					makeQuote({
						code: "000001",
						name: "平安",
						snapshot_date: "2026-06-21",
						change_pct: 10,
						total_cap: 3000,
					}),
					makeQuote({
						code: "000001",
						name: "平安",
						snapshot_date: "2026-06-22",
						change_pct: 10,
						total_cap: 3000,
					}),
					makeQuote({
						code: "000001",
						name: "平安",
						snapshot_date: "2026-06-23",
						change_pct: 10,
						total_cap: 3000,
					}),
					makeQuote({
						code: "000001",
						name: "平安",
						snapshot_date: "2026-06-24",
						change_pct: 10,
						total_cap: 3000,
					}),
					makeQuote({
						code: "000002",
						name: "万科",
						snapshot_date: "2026-06-20",
						change_pct: -1,
						total_cap: 1500,
					}),
					makeQuote({
						code: "000002",
						name: "万科",
						snapshot_date: "2026-06-21",
						change_pct: 10,
						total_cap: 1500,
					}),
					makeQuote({
						code: "000002",
						name: "万科",
						snapshot_date: "2026-06-22",
						change_pct: 10,
						total_cap: 1500,
					}),
					makeQuote({
						code: "000002",
						name: "万科",
						snapshot_date: "2026-06-23",
						change_pct: -2,
						total_cap: 1500,
					}),
					makeQuote({ code: "000002", name: "万科", snapshot_date: "2026-06-24", change_pct: 5, total_cap: 1500 }),
					makeQuote({
						code: "300001",
						name: "特锐德",
						snapshot_date: "2026-06-20",
						change_pct: 20,
						total_cap: 80,
					}),
					makeQuote({
						code: "300001",
						name: "特锐德",
						snapshot_date: "2026-06-21",
						change_pct: 20,
						total_cap: 80,
					}),
					makeQuote({
						code: "300001",
						name: "特锐德",
						snapshot_date: "2026-06-22",
						change_pct: -5,
						total_cap: 80,
					}),
					makeQuote({
						code: "300001",
						name: "特锐德",
						snapshot_date: "2026-06-23",
						change_pct: 20,
						total_cap: 80,
					}),
					makeQuote({
						code: "300001",
						name: "特锐德",
						snapshot_date: "2026-06-24",
						change_pct: 20,
						total_cap: 80,
					}),
					makeQuote({
						code: "600519",
						name: "茅台",
						snapshot_date: "2026-06-24",
						change_pct: -0.5,
						total_cap: 20000,
					}),
				] as any;
			}
			if (lower.includes("from klines")) {
				return [
					{ code: "000001", market: 0, high: 13.3, close: 13.3, pre_close: 12.1 },
					{ code: "300001", market: 0, high: 17.2, close: 17.2, pre_close: 14.4 },
				] as any;
			}
			if (lower.includes("from industry_quotes")) {
				return [
					{ code: "BK0479", name: "半导体", snapshot_date: "2026-06-20", change_pct: 0.02 },
					{ code: "BK0479", name: "半导体", snapshot_date: "2026-06-21", change_pct: 0.03 },
					{ code: "BK0479", name: "半导体", snapshot_date: "2026-06-22", change_pct: 0.04 },
					{ code: "BK0479", name: "半导体", snapshot_date: "2026-06-23", change_pct: 0.05 },
					{ code: "BK0479", name: "半导体", snapshot_date: "2026-06-24", change_pct: 0.06 },
					{ code: "BK0480", name: "医药", snapshot_date: "2026-06-24", change_pct: 0.03 },
				] as any;
			}
			if (lower.includes("from market_news")) {
				return [
					{
						source: "cls",
						title: "AI算力需求持续旺盛",
						pub_time: "2026-06-23",
						sentiment: "positive",
						affected_sectors: '{"benefit":["半导体","AI"],"harm":[]}',
					},
					{
						source: "cls",
						title: "存储芯片涨价",
						pub_time: "2026-06-22",
						sentiment: "positive",
						affected_sectors: '{"benefit":["半导体"],"harm":[]}',
					},
				] as any;
			}
			return [] as any;
		}),
		getFactorIc: vi.fn(),
	} as unknown as DataStore;
}

describe("market-theme analysis helpers", () => {
	it("computes daily board stats", () => {
		const quotes = [
			makeQuote({ code: "A", snapshot_date: "2026-06-24", change_pct: 10 }),
			makeQuote({ code: "B", snapshot_date: "2026-06-24", change_pct: -10 }),
			makeQuote({ code: "C", snapshot_date: "2026-06-24", change_pct: 2 }),
			makeQuote({ code: "D", snapshot_date: "2026-06-24", change_pct: -1 }),
		];
		const stats = computeBoardStats(quotes);
		expect(stats).toHaveLength(1);
		expect(stats[0].up).toBe(2);
		expect(stats[0].down).toBe(2);
		expect(stats[0].limitUp).toBe(1);
		expect(stats[0].limitDown).toBe(1);
	});

	it("detects consecutive limit-up streaks", () => {
		const quotes = [
			makeQuote({ code: "A", snapshot_date: "2026-06-20", change_pct: 10 }),
			makeQuote({ code: "A", snapshot_date: "2026-06-21", change_pct: 10 }),
			makeQuote({ code: "A", snapshot_date: "2026-06-22", change_pct: 10 }),
			makeQuote({ code: "A", snapshot_date: "2026-06-23", change_pct: 5 }),
			makeQuote({ code: "A", snapshot_date: "2026-06-24", change_pct: 10 }),
			makeQuote({ code: "B", snapshot_date: "2026-06-22", change_pct: 10 }),
			makeQuote({ code: "B", snapshot_date: "2026-06-23", change_pct: 10 }),
			makeQuote({ code: "B", snapshot_date: "2026-06-24", change_pct: 10 }),
		];
		const lianban = computeLianbanStocks(quotes, "2026-06-24");
		expect(lianban.length).toBeGreaterThan(0);
		const b = lianban.find((l) => l.code === "B");
		expect(b?.streak).toBe(3);
	});

	it("classifies leaders by tier", () => {
		const quotes = [
			makeQuote({ code: "A", name: "A股", snapshot_date: "2026-06-22", change_pct: 10, total_cap: 50 }),
			makeQuote({ code: "A", name: "A股", snapshot_date: "2026-06-23", change_pct: 10, total_cap: 50 }),
			makeQuote({ code: "A", name: "A股", snapshot_date: "2026-06-24", change_pct: 10, total_cap: 50 }),
			makeQuote({
				code: "B",
				name: "B股",
				snapshot_date: "2026-06-22",
				change_pct: 3,
				total_cap: 300,
				turnover: 50000,
			}),
			makeQuote({
				code: "B",
				name: "B股",
				snapshot_date: "2026-06-23",
				change_pct: 5,
				total_cap: 300,
				turnover: 60000,
			}),
			makeQuote({
				code: "B",
				name: "B股",
				snapshot_date: "2026-06-24",
				change_pct: 7,
				total_cap: 300,
				turnover: 70000,
			}),
		];
		const lianban = computeLianbanStocks(quotes, "2026-06-24");
		const leaders = identifyLeaders(quotes, lianban);
		const leaderA = leaders.find((l) => l.code === "A");
		const leaderB = leaders.find((l) => l.code === "B");
		expect(leaderA?.tier).toBe("情绪龙头");
		expect(leaderB?.tier).toBe("趋势中军");
	});
});

describe("external concept integration", () => {
	it("merges external concepts into local sectors", () => {
		const local = [
			{
				code: "BK0479",
				name: "半导体",
				latestChangePct: 0.05,
				cumulativeReturn: 0.15,
				latestRank: 1,
				windowRank: 1,
				upDays: 4,
				downDays: 1,
			},
		];
		const external: ExternalConceptData[] = [
			{
				name: "先进封装",
				latestChangePct: 6,
				windowChangePct: 18,
				turnoverYi: 120,
				limitUpCount: 8,
				leadingStocks: [],
				source: "iwencai",
			},
		];
		const merged = mergeExternalConcepts(local as any, external);
		expect(merged.some((s) => s.name === "先进封装")).toBe(true);
		expect(merged.find((s) => s.name === "先进封装")?.cumulativeReturn).toBeCloseTo(0.18);
	});

	it("ranks sectors by multi-factor score", () => {
		const sectors = [
			{
				code: "A",
				name: "强势板块",
				latestChangePct: 0.05,
				cumulativeReturn: 0.2,
				latestRank: 0,
				windowRank: 0,
				upDays: 4,
				downDays: 1,
				limitUpCount: 10,
				turnoverYi: 200,
			},
			{
				code: "B",
				name: "弱势板块",
				latestChangePct: 0.01,
				cumulativeReturn: 0.02,
				latestRank: 0,
				windowRank: 0,
				upDays: 2,
				downDays: 3,
				limitUpCount: 0,
				turnoverYi: 20,
			},
		];
		const news = [{ theme: "强势板块", mentions: 5, positive: 5, negative: 0, neutral: 0, recentTitles: [] }];
		const ranked = scoreSectors(sectors as any, news);
		expect(ranked[0].name).toBe("强势板块");
		expect(ranked[1].name).toBe("弱势板块");
	});
});

describe("analyzeMarketTheme integration", () => {
	it("produces all 8 sections", async () => {
		const store = createMockStore();
		const analysis = await analyzeMarketTheme(store, { lookbackDays: 5, endDate: "2026-06-24" });
		const text = formatMarketTheme(analysis);
		expect(text).toContain("【1.市场环境】");
		expect(text).toContain("【2.当前主线】");
		expect(text).toContain("【3.次级热点】");
		expect(text).toContain("【4.核心龙头与中军】");
		expect(text).toContain("【5.情绪周期】");
		expect(text).toContain("【6.主线持续性评估】");
		expect(text).toContain("【7.明日观察重点】");
		expect(text).toContain("【8.一句话交易结论】");
		expect(analysis.lianbanStocks.length).toBeGreaterThan(0);
		expect(analysis.sectors.length).toBeGreaterThan(0);
	});

	it("uses external concepts to override sparse local main theme", async () => {
		const store = createMockStore();
		const external: ExternalConceptData[] = [
			{
				name: "先进封装",
				latestChangePct: 6.5,
				windowChangePct: 22.0,
				turnoverYi: 300,
				limitUpCount: 12,
				leadingStocks: [],
				source: "iwencai",
			},
		];
		const analysis = await analyzeMarketTheme(store, {
			lookbackDays: 5,
			endDate: "2026-06-24",
			externalConcepts: external,
		});
		expect(analysis.sectors[0]?.name).toBe("先进封装");
		expect(formatMarketTheme(analysis)).toContain("先进封装");
	});
});

describe("analyze_market_theme tool", () => {
	it("returns structured analysis when data is healthy", async () => {
		const { getDataStore } = await import("../data/index.js");
		const { iwencaiScreenTool } = await import("./iwencai-screening.js");
		const store = createMockStore();
		vi.mocked(getDataStore).mockReturnValue(store);
		vi.mocked(iwencaiScreenTool.execute).mockResolvedValue({
			content: [{ type: "text", text: "mock" }],
			details: {
				success: true,
				results: [{ 板块名称: "先进封装", 最新涨跌幅: "5.5%", 成交额: "120亿", 涨停家数: "8" }],
			} as any,
		});

		const { analyzeMarketThemeTool } = await import("./analyze-market-theme.js");
		const result = await analyzeMarketThemeTool.execute("test", { lookback_days: 5 });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("【1.市场环境】");
		expect(text).toContain("【8.一句话交易结论】");
		expect(result.details.analysis.lianbanStocks.length).toBeGreaterThan(0);
	});

	it("returns error when data store is not initialized", async () => {
		const { getDataStore } = await import("../data/index.js");
		vi.mocked(getDataStore).mockReturnValue(null);

		const { analyzeMarketThemeTool } = await import("./analyze-market-theme.js");
		const result = await analyzeMarketThemeTool.execute("test", {});
		expect((result.content[0] as { text: string }).text).toContain("数据库未初始化");
	});

	it("falls back to local data when iwencai fails", async () => {
		const { getDataStore } = await import("../data/index.js");
		const { iwencaiScreenTool } = await import("./iwencai-screening.js");
		const store = createMockStore();
		vi.mocked(getDataStore).mockReturnValue(store);
		vi.mocked(iwencaiScreenTool.execute).mockRejectedValue(new Error("API key missing"));

		const { analyzeMarketThemeTool } = await import("./analyze-market-theme.js");
		const result = await analyzeMarketThemeTool.execute("test", { lookback_days: 5 });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("【1.市场环境】");
		expect(text).toContain("外部概念数据获取失败");
	});
});
