import { loadPostMarketTemplate, renderTemplate } from "../../config/prompt-templates.js";
import { loadUserConfig } from "../../config/user-config.js";
import type { SessionMemory } from "../../core/session-memory.js";
import type { TradingSession } from "../../core/trading-session.js";
import { getQuoteTool } from "../../tools/market-data.js";
import { getMarketNewsTool } from "../../tools/news-analysis.js";
import { getSectorRotationTool } from "../../tools/sector-rotation.js";

export async function postMarketRoutine(session: TradingSession, memory?: SessionMemory): Promise<void> {
	if (!memory) {
		console.warn("[PostMarket] No session memory available, skipping.");
		return;
	}
	const today = new Date().toISOString().slice(0, 10);
	console.log("[PostMarket] Starting post-market routine for", today);

	// 1. Execute daily compaction to extract key decisions
	let summary: Awaited<ReturnType<typeof memory.dailyCompaction>>;
	try {
		summary = await memory.dailyCompaction(session);
		console.log("[PostMarket] Daily compaction completed:", summary.date);
	} catch (e) {
		console.error("[PostMarket] Daily compaction failed:", e);
		return;
	}

	// 2. Fetch today's watchlist closing data
	const config = loadUserConfig();
	const watchlist = config.watchlist || [];
	const watchlistTexts: string[] = [];
	for (const item of watchlist) {
		try {
			const result = await getQuoteTool.execute(`quote-${item.code}`, {
				code: item.code,
				market: item.market,
			});
			watchlistTexts.push((result.content[0] as any).text);
		} catch (_e) {
			watchlistTexts.push(`${item.name}(${item.code}): 数据获取失败`);
		}
	}

	// 3. 获取板块轮动
	let sectorText = "【板块轮动获取失败】";
	try {
		const sectorResult = await getSectorRotationTool.execute("postmkt-sector", {});
		sectorText = (sectorResult.content[0] as any).text;
	} catch (e) {
		console.error("[PostMarket] get_sector_rotation failed:", e);
	}

	// 4. 获取市场宏观新闻（最近1天）
	let marketNewsText = "【市场新闻获取失败】";
	try {
		const newsResult = await getMarketNewsTool.execute("postmkt-news", {
			mode: "query",
			days: 1,
			limit: 20,
		});
		marketNewsText = (newsResult.content[0] as any).text;
	} catch (e) {
		console.error("[PostMarket] get_market_news failed:", e);
	}

	// 5. Get recent memory context (last 3 days)
	const recentMemory = memory.getContextString(3);

	// 6. Render prompt
	const template = loadPostMarketTemplate();
	const keyDecisionsText =
		summary.keyDecisions.length > 0
			? summary.keyDecisions.map((d, i) => `${i + 1}. ${d}`).join("\n")
			: "无明确决策记录";

	const reflectionPrompt = renderTemplate(template, {
		date: today,
		watchlist_data: watchlistTexts.join("\n\n"),
		sector_rotation: sectorText,
		market_news: marketNewsText,
		key_decisions: keyDecisionsText,
		memory_context: recentMemory || "无近期交易记忆",
	});

	// 5. Generate reflection via LLM, capturing response text as it streams
	let reflectionText = "";
	const onMessageUpdate = (ev: { type: string; assistantMessageEvent?: { type: string; delta: string } }) => {
		if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
			reflectionText += ev.assistantMessageEvent.delta;
		}
	};
	session.on("agent_event", onMessageUpdate);

	try {
		await session.prompt(reflectionPrompt, { systemPromptSuffix: `[当前模式：盘后复盘 | 日期：${today}]` });
		await session.waitForIdle();

		// Use captured streaming text as reflection (trimmed)
		const text = reflectionText.trim();
		if (text) {
			memory.updateReflection(summary.date, text);
			console.log("[PostMarket] Reflection saved for", summary.date);
		} else {
			console.warn("[PostMarket] No reflection text captured");
		}
	} catch (e) {
		console.error("[PostMarket] Reflection generation failed:", e);
	} finally {
		session.off("agent_event", onMessageUpdate);
	}
}
