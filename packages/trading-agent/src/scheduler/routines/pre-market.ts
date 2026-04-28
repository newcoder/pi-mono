import { loadPreMarketTemplate, renderTemplate } from "../../config/prompt-templates.js";
import { loadUserConfig } from "../../config/user-config.js";
import type { SessionMemory } from "../../core/session-memory.js";
import type { TradingSession } from "../../core/trading-session.js";
import { getMacroTool } from "../../tools/macro-data.js";
import { getQuoteTool } from "../../tools/market-data.js";
import { getMarketNewsTool } from "../../tools/news-analysis.js";
import { getSectorRotationTool } from "../../tools/sector-rotation.js";

export async function preMarketRoutine(session: TradingSession, memory?: SessionMemory): Promise<void> {
	const today = new Date().toISOString().slice(0, 10);
	console.log("[PreMarket] Starting pre-market routine for", today);

	const config = loadUserConfig();
	const watchlist = config.watchlist || [];

	// 1. 获取宏观数据
	let macroText = "【宏观数据获取失败】";
	try {
		const macroResult = await getMacroTool.execute("macro-1", {});
		macroText = (macroResult.content[0] as any).text;
	} catch (e) {
		console.error("[PreMarket] get_macro failed:", e);
	}

	// 2. 获取市场宏观新闻（最近1天）
	let marketNewsText = "【市场新闻获取失败】";
	try {
		const newsResult = await getMarketNewsTool.execute("premkt-news", {
			mode: "query",
			days: 1,
			limit: 20,
		});
		marketNewsText = (newsResult.content[0] as any).text;
	} catch (e) {
		console.error("[PreMarket] get_market_news failed:", e);
	}

	// 3. 获取板块轮动
	let sectorText = "【板块轮动获取失败】";
	try {
		const sectorResult = await getSectorRotationTool.execute("premkt-sector", {});
		sectorText = (sectorResult.content[0] as any).text;
	} catch (e) {
		console.error("[PreMarket] get_sector_rotation failed:", e);
	}

	// 4. 获取 watchlist 行情
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

	// 5. 获取近期记忆
	const recentMemory = memory ? memory.getContextString(3) : "";

	// 6. 加载模板并渲染
	const template = loadPreMarketTemplate();
	const prompt = renderTemplate(template, {
		date: today,
		macro_data: macroText,
		market_news: marketNewsText,
		sector_rotation: sectorText,
		watchlist_data: watchlistTexts.join("\n\n"),
		memory_context: recentMemory || "无近期交易记忆",
	});

	// 7. 调用模型生成简报
	console.log("[PreMarket] Generating briefing...");
	await session.prompt(prompt, { systemPromptSuffix: `[当前模式：盘前简报 | 日期：${today}]` });
}
