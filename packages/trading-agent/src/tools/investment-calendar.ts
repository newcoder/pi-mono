import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";
import { formatNumber, runJsonScript } from "./_utils.js";

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

// ─── Calendar Impact Analysis ──────────────────────────────────────

const analyzeCalendarImpactParams = Type.Object({
	startDate: Type.Optional(Type.String({ description: "开始日期 (YYYY-MM-DD)，默认今天" })),
	endDate: Type.Optional(Type.String({ description: "结束日期 (YYYY-MM-DD)，默认今天+60天" })),
	minImportance: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
			description: "最低重要性级别",
			default: "medium",
		}),
	),
	maxStocks: Type.Optional(Type.Number({ description: "最多返回多少只股票", default: 30 })),
	saveToPool: Type.Optional(Type.Boolean({ description: "是否保存到未来关注股池", default: true })),
});

interface CalendarEvent {
	event_date: string;
	title: string;
	category: string;
	description: string | null;
	code: string | null;
	market: number | null;
	affected_sectors: string[] | null;
	importance: string;
	source: string;
}

interface StockImpact {
	code: string;
	market: number;
	name: string;
	score: number;
	direction: "利好" | "利空" | "中性";
	events: Array<{
		date: string;
		title: string;
		category: string;
		impact: number;
		reason: string;
	}>;
	quote?: {
		latest: number | null;
		change_pct: number | null;
		pe: number | null;
		pb: number | null;
		total_cap: number | null;
	};
}

const IMPORTANCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/** Determine base impact score from event category and description */
function computeEventImpact(event: CalendarEvent): { score: number; reason: string } {
	const cat = event.category;
	const desc = (event.description || "").toLowerCase();
	const title = event.title.toLowerCase();

	// 限售解禁 → 利空 (supply increase)
	if (cat === "unlock") {
		return { score: -3, reason: "限售解禁增加流通股供给，短期通常构成抛压" };
	}

	// 业绩预告 → 根据类型判断
	if (cat === "earnings") {
		const positive = /预增|增长|盈利|扭亏|上升/.test(desc + title);
		const negative = /预亏|亏损|下降|下滑|预警/.test(desc + title);
		if (positive && !negative) return { score: +3, reason: "业绩预告向好，基本面预期改善" };
		if (negative && !positive) return { score: -3, reason: "业绩预告不佳，基本面预期恶化" };
		return { score: +1, reason: "业绩预告，需关注具体数据" };
	}

	// 宏观政策
	if (cat === "macro") {
		const favorable = /宽松|刺激|降准|降息|支持|扶持|利好|减税/.test(desc + title);
		const unfavorable = /收紧|加息|监管|限产|禁售|加税|利空/.test(desc + title);
		if (favorable) return { score: +2, reason: "宏观政策面偏暖，利好相关板块" };
		if (unfavorable) return { score: -2, reason: "宏观政策面偏紧，相关板块承压" };
		return { score: 0, reason: "宏观事件，影响方向待观察" };
	}

	// 行业展会/会议 → 通常带来预期炒作，偏利好
	if (cat === "conference") {
		return { score: +1, reason: "行业盛会通常带来新品/技术预期，短期偏利好" };
	}

	// 行业事件
	if (cat === "industry") {
		const favorable = /旺季|涨价|扩产|订单|高景气/.test(desc + title);
		const unfavorable = /淡季|降价|减产|库存|过剩/.test(desc + title);
		if (favorable) return { score: +2, reason: "行业景气度向上" };
		if (unfavorable) return { score: -2, reason: "行业景气度向下" };
		return { score: 0, reason: "行业事件，影响方向待观察" };
	}

	// 其他
	return { score: 0, reason: "事件影响方向不明确" };
}

/** Build a map of stock → list of impacting events */
async function mapEventsToStocks(events: CalendarEvent[]): Promise<Map<string, StockImpact>> {
	const store = getDataStore();
	if (!store) return new Map();

	const stockImpacts = new Map<string, StockImpact>();

	for (const event of events) {
		const { score, reason } = computeEventImpact(event);
		const importanceMultiplier = IMPORTANCE_RANK[event.importance] ?? 1;
		const weightedScore = score * importanceMultiplier;

		const stocksToAffect: Array<{ code: string; market: number; name?: string }> = [];

		// Direct stock mapping
		if (event.code) {
			const market = event.market ?? (event.code.startsWith("6") ? 1 : 0);
			stocksToAffect.push({ code: event.code, market });
		}

		// Sector/concept mapping
		if (event.affected_sectors && event.affected_sectors.length > 0) {
			for (const sector of event.affected_sectors) {
				try {
					// Try concept match first
					const conceptStocks = await store.getConceptStocks(sector);
					for (const cs of conceptStocks) {
						if (!stocksToAffect.some((s) => s.code === cs.code)) {
							stocksToAffect.push({ code: cs.code, market: 0, name: cs.name || undefined });
						}
					}

					// Also try industry match
					const industryStocks = await store.getStocksByIndustry(sector);
					for (const ist of industryStocks) {
						if (!stocksToAffect.some((s) => s.code === ist.code)) {
							stocksToAffect.push({ code: ist.code, market: ist.market, name: ist.name || undefined });
						}
					}
				} catch {
					// Ignore mapping errors for individual sectors
				}
			}
		}

		// Apply impact to each affected stock
		for (const stock of stocksToAffect) {
			const key = `${stock.code}.${stock.market}`;
			let impact = stockImpacts.get(key);
			if (!impact) {
				impact = {
					code: stock.code,
					market: stock.market,
					name: stock.name || "",
					score: 0,
					direction: "中性",
					events: [],
				};
				stockImpacts.set(key, impact);
			}
			impact.score += weightedScore;
			impact.events.push({
				date: event.event_date,
				title: event.title,
				category: event.category,
				impact: weightedScore,
				reason,
			});
		}
	}

	return stockImpacts;
}

/** Enrich stock impacts with current quote data */
async function enrichWithQuotes(stockImpacts: Map<string, StockImpact>): Promise<void> {
	const store = getDataStore();
	if (!store) return;

	const codes = Array.from(stockImpacts.values()).map((s) => s.code);
	if (codes.length === 0) return;

	try {
		const quotes = await store.getLatestQuotes(codes);
		for (const q of quotes) {
			const key = `${q.code}.${q.market}`;
			const impact = stockImpacts.get(key);
			if (impact) {
				impact.name = q.name || impact.name;
				impact.quote = {
					latest: q.latest ?? null,
					change_pct: q.change_pct ?? null,
					pe: q.pe ?? null,
					pb: q.pb ?? null,
					total_cap: q.total_cap ?? null,
				};
			}
		}
	} catch (e) {
		console.warn("[analyze_calendar] Failed to enrich quotes:", e);
	}
}

/** Save analyzed stocks to the 未来关注股池 */
async function saveToWatchPool(stockImpacts: StockImpact[]): Promise<string> {
	const store = getDataStore();
	if (!store) return "DataStore not available";

	const poolName = "未来关注股池";

	// Find or create pool
	const pool = await store.getStockPoolByName(poolName);
	let poolId: number;

	if (!pool) {
		poolId = await store.createStockPool(poolName, "投资日历深度分析产生的未来1-2个月关注股票，按事件影响分类");
	} else {
		poolId = pool.id;
		await store.clearStockPool(poolId);
	}

	const items = stockImpacts.map((s) => ({
		code: s.code,
		market: s.market,
		name: s.name || undefined,
	}));

	await store.addToStockPool(poolId, items);
	return poolName;
}

function formatImpactResult(impacts: StockImpact[], poolName?: string): string {
	if (impacts.length === 0) {
		return "【投资日历影响分析】\n未找到符合条件的事件或受影响股票。\n建议：先调用 refresh_calendar 刷新投资日历数据。";
	}

	const lines: string[] = [
		`【投资日历深度影响分析】`,
		`分析区间: ${impacts[0]?.events[0]?.date ?? ""} 至 ${impacts[impacts.length - 1]?.events[impacts[impacts.length - 1].events.length - 1]?.date ?? ""}`,
		`共识别 ${impacts.length} 只受影响股票`,
		"",
	];

	// Group by direction
	const bullish = impacts.filter((i) => i.direction === "利好");
	const bearish = impacts.filter((i) => i.direction === "利空");
	const neutral = impacts.filter((i) => i.direction === "中性");

	lines.push(`利好: ${bullish.length}只 | 利空: ${bearish.length}只 | 中性: ${neutral.length}只`);
	lines.push("");

	// 利空优先展示（通常更重要）
	if (bearish.length > 0) {
		lines.push("--- 利空关注 ---");
		for (const s of bearish.slice(0, 15)) {
			const q = s.quote;
			const quoteStr = q
				? `价:${formatNumber(q.latest)} 涨:${q.change_pct?.toFixed(2) ?? "—"}% PE:${q.pe?.toFixed(1) ?? "—"} 市值:${formatNumber(q.total_cap)}亿`
				: "";
			lines.push(`${s.code} ${s.name} | 影响分:${s.score} ${quoteStr}`);
			for (const ev of s.events.slice(0, 3)) {
				lines.push(`  → ${ev.date} ${ev.title} (${ev.reason})`);
			}
			if (s.events.length > 3) {
				lines.push(`  ... 还有 ${s.events.length - 3} 个事件`);
			}
		}
		lines.push("");
	}

	if (bullish.length > 0) {
		lines.push("--- 利好关注 ---");
		for (const s of bullish.slice(0, 15)) {
			const q = s.quote;
			const quoteStr = q
				? `价:${formatNumber(q.latest)} 涨:${q.change_pct?.toFixed(2) ?? "—"}% PE:${q.pe?.toFixed(1) ?? "—"} 市值:${formatNumber(q.total_cap)}亿`
				: "";
			lines.push(`${s.code} ${s.name} | 影响分:${s.score} ${quoteStr}`);
			for (const ev of s.events.slice(0, 3)) {
				lines.push(`  → ${ev.date} ${ev.title} (${ev.reason})`);
			}
			if (s.events.length > 3) {
				lines.push(`  ... 还有 ${s.events.length - 3} 个事件`);
			}
		}
		lines.push("");
	}

	if (poolName) {
		lines.push(`【已保存】结果已保存到「${poolName}」股票池`);
	}

	return lines.join("\n");
}

export const analyzeCalendarImpactTool: AgentTool<
	typeof analyzeCalendarImpactParams,
	{ analyzed: number; bullish: number; bearish: number; neutral: number; poolName?: string }
> = {
	name: "analyze_calendar_impact",
	label: "投资日历影响分析",
	description:
		"深度分析投资日历中未来1-2个月的事件，识别预计受影响最大的股票，判断利好/利空方向，并可保存到未来关注股池。执行前如数据较旧建议先调用 refresh_calendar 刷新。",
	parameters: analyzeCalendarImpactParams,
	execute: async (_id, params) => {
		const store = getDataStore();
		if (!store) {
			return {
				content: [{ type: "text", text: "【错误】DataStore 未初始化。" }],
				details: { analyzed: 0, bullish: 0, bearish: 0, neutral: 0 },
			};
		}

		// Default date range: today to +60 days
		const today = new Date().toISOString().slice(0, 10);
		const startDate = params.startDate || today;
		const endDate = params.endDate || new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
		const minImportance = params.minImportance || "medium";
		const maxStocks = params.maxStocks ?? 30;
		const saveToPool = params.saveToPool ?? true;

		try {
			// 1. Fetch calendar events
			const rawEvents = await store.getCalendarEvents(startDate, endDate);
			if (!rawEvents || rawEvents.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "【投资日历影响分析】\n指定日期范围内无事件数据。\n建议：先调用 refresh_calendar 刷新投资日历。",
						},
					],
					details: { analyzed: 0, bullish: 0, bearish: 0, neutral: 0 },
				};
			}

			// Filter by importance
			const minRank = IMPORTANCE_RANK[minImportance] ?? 2;
			const events = rawEvents.map((r) => ({
				...r,
				affected_sectors: r.affected_sectors ?? null,
			})) as CalendarEvent[];

			const filteredEvents = events.filter((e) => (IMPORTANCE_RANK[e.importance] ?? 1) >= minRank);

			// 2. Map events to affected stocks
			const stockImpactsMap = await mapEventsToStocks(filteredEvents);

			// 3. Enrich with quotes
			await enrichWithQuotes(stockImpactsMap);

			// 4. Compute direction and sort by absolute impact
			const stockImpacts = Array.from(stockImpactsMap.values());
			for (const s of stockImpacts) {
				if (s.score > 0) s.direction = "利好";
				else if (s.score < 0) s.direction = "利空";
				else s.direction = "中性";
			}
			stockImpacts.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

			// 5. Take top N
			const topImpacts = stockImpacts.slice(0, maxStocks);

			// 6. Save to watch pool
			let poolName: string | undefined;
			if (saveToPool && topImpacts.length > 0) {
				try {
					poolName = await saveToWatchPool(topImpacts);
				} catch (e) {
					console.warn("[analyze_calendar] Failed to save watch pool:", e);
				}
			}

			// 7. Format and return
			const text = formatImpactResult(topImpacts, poolName);
			const bullish = topImpacts.filter((i) => i.direction === "利好").length;
			const bearish = topImpacts.filter((i) => i.direction === "利空").length;
			const neutral = topImpacts.filter((i) => i.direction === "中性").length;

			return {
				content: [{ type: "text", text }],
				details: {
					analyzed: topImpacts.length,
					bullish,
					bearish,
					neutral,
					poolName,
					stocks: topImpacts.map((s) => ({
						code: s.code,
						name: s.name,
						market: s.market,
						score: s.score,
						direction: s.direction,
						event_count: s.events.length,
						quote: s.quote,
					})),
				},
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text", text: `【投资日历影响分析失败】\n错误: ${msg}` }],
				details: { analyzed: 0, bullish: 0, bearish: 0, neutral: 0 },
			};
		}
	},
};
