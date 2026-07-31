import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { loadUserConfig } from "../config/user-config.js";
import { getDataSync } from "../data/index.js";
import { resolveLocalDataScript, runPython } from "./_utils.js";

// ── sync_kline tool ─────────────────────────────────────────────────────────

const syncKlineParams = Type.Object({
	period: Type.Optional(
		Type.Union([Type.Literal("daily"), Type.Literal("week"), Type.Literal("month")], {
			description: "K线周期: daily(日线)/week(周线)/month(月线)",
			default: "daily",
		}),
	),
	batchSize: Type.Optional(Type.Number({ description: "每批处理股票数量", default: 500 })),
});

export const syncKlineTool: AgentTool<typeof syncKlineParams, { synced: number; period: string }> = {
	name: "sync_kline",
	label: "同步K线",
	description:
		"同步全市场A股K线数据到本地SQLite数据库。支持日线/周线/月线，使用增量模式只同步缺失数据。全市场约5500只股票，日线约需60-90秒。",
	parameters: syncKlineParams,
	execute: async (_id, params) => {
		const sync = getDataSync();
		if (!sync) {
			return {
				content: [{ type: "text", text: "[错误] DataSyncService 未初始化，无法执行同步。" }],
				details: { synced: 0, period: params.period || "daily" },
			};
		}

		const period = params.period || "daily";
		const batchSize = params.batchSize || 500;
		const label = period === "week" ? "周线" : period === "month" ? "月线" : "日线";

		console.log(`[sync_kline] 开始同步全市场${label}...`);
		const startTime = Date.now();
		const count = await sync.syncAllKlines(period, "bfq", batchSize);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

		const text = `【K线同步完成】\n周期: ${label}\n同步数量: ${count} 条K线\n耗时: ${elapsed} 秒\n说明: 增量模式，只同步本地数据库缺失的数据。`;

		return {
			content: [{ type: "text", text }],
			details: { synced: count, period },
		};
	},
};

// ── sync_fundamentals tool ──────────────────────────────────────────────────

const syncFundamentalsParams = Type.Object({
	batchSize: Type.Optional(Type.Number({ description: "每批处理股票数量（越小越慢但越稳定）", default: 100 })),
	historyLimit: Type.Optional(Type.Number({ description: "每只股票抓取的历史报告期数量（0=不限制）", default: 12 })),
	force: Type.Optional(Type.Boolean({ description: "强制重新同步，跳过增量检查", default: false })),
	sinceYear: Type.Optional(
		Type.Number({ description: "补全模式：抓取该年份以来的历史数据（如2019），只同步缺失的股票", default: 0 }),
	),
});

export const syncFundamentalsTool: AgentTool<typeof syncFundamentalsParams, { synced: number }> = {
	name: "sync_fundamentals",
	label: "同步财务数据",
	description:
		"同步全市场A股基本面财务数据到本地数据库。包括利润表、资产负债表、现金流量表。支持增量同步（默认limit=12期）和补全模式（sinceYear=2019会抓取2019年以来的所有历史数据）。约5500只股票，完整同步约需30-60分钟。",
	parameters: syncFundamentalsParams,
	execute: async (_id, params) => {
		const sync = getDataSync();
		if (!sync) {
			return {
				content: [{ type: "text", text: "[错误] DataSyncService 未初始化，无法执行同步。" }],
				details: { synced: 0 },
			};
		}

		const batchSize = params.batchSize || 100;
		const historyLimit = params.historyLimit ?? 12;
		const force = params.force || false;
		const sinceYear = params.sinceYear || 0;

		console.log(`[sync_fundamentals] 开始同步全市场财务数据...`);
		const startTime = Date.now();

		let count: number;
		if (sinceYear > 0) {
			count = await sync.backfillFundamentals(sinceYear, batchSize);
		} else {
			count = await sync.syncAllFundamentals(batchSize, historyLimit, force);
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

		const text =
			sinceYear > 0
				? `【财务数据补全完成】\n同步数量: ${count} 条财报记录\n耗时: ${elapsed} 秒\n说明: 补全 ${sinceYear} 年以来的历史数据，只同步缺失的股票。`
				: `【财务数据同步完成】\n同步数量: ${count} 条财报记录\n耗时: ${elapsed} 秒\n说明: 包括利润表、资产负债表、现金流量表。${force ? "强制模式，" : ""}每只股票最多 ${historyLimit} 期报告。`;

		return {
			content: [{ type: "text", text }],
			details: { synced: count },
		};
	},
};

// ── sync_hot_stocks tool ───────────────────────────────────────────────────

const syncHotStocksParams = Type.Object({
	date: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD，默认今天" })),
});

export const syncHotStocksTool: AgentTool<typeof syncHotStocksParams, { synced: number; date: string }> = {
	name: "sync_hot_stocks",
	label: "同步强势股",
	description:
		"同步同花顺当日热点强势股（含题材归因 reason tags）到本地数据库 hot_stocks 表。如指定日期无数据，会返回空。",
	parameters: syncHotStocksParams,
	execute: async (_id, params) => {
		const sync = getDataSync();
		if (!sync) {
			return {
				content: [{ type: "text", text: "[错误] DataSyncService 未初始化。" }],
				details: { synced: 0, date: params.date || "" },
			};
		}

		const date = params.date;
		const startTime = Date.now();
		const count = await sync.syncHotStocks(date);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		const targetDate = date || new Date().toISOString().slice(0, 10);

		const text = `【强势股同步完成】\n日期: ${targetDate}\n同步数量: ${count} 只\n耗时: ${elapsed} 秒`;
		return {
			content: [{ type: "text", text }],
			details: { synced: count, date: targetDate },
		};
	},
};

// ── sync_news tool ──────────────────────────────────────────────────────────

const syncNewsParams = Type.Object({
	scope: Type.Optional(
		Type.Union([Type.Literal("market"), Type.Literal("watchlist"), Type.Literal("all")], {
			description:
				"同步范围: market(仅市场宏观新闻)/watchlist(市场新闻+关注股票, 推荐)/all(市场新闻+全市场5500只股票, 很慢)",
			default: "watchlist",
		}),
	),
	sources: Type.Optional(
		Type.String({
			description: "新闻来源，如 eastmoney, cls, stcn。多个用逗号分隔",
			default: "eastmoney,cls",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "每来源最大抓取数量", default: 20 })),
});

export const syncNewsTool: AgentTool<typeof syncNewsParams, { marketNews: string; stockNews: string }> = {
	name: "sync_news",
	label: "同步新闻",
	description:
		"同步新闻到本地数据库。包含市场宏观新闻（政策/宏观/行业要闻）和个股新闻。建议用 watchlist 范围（只同步关注股票，快），all 范围同步全市场5500只股票新闻，可能需要10-30分钟。",
	parameters: syncNewsParams,
	execute: async (_id, params) => {
		const scope = params.scope || "watchlist";
		const sources = params.sources || "eastmoney,cls";
		const limit = params.limit || 20;
		const results: string[] = [];

		// 1. Sync market macro news (always)
		console.log(`[sync_news] 同步市场宏观新闻 (sources=${sources})...`);
		const mktStart = Date.now();
		try {
			const tmpDir = mkdtempSync(join(tmpdir(), "mkt-news-sync-"));
			const outputPath = join(tmpDir, "result.json");
			try {
				await runPython(
					resolveLocalDataScript("market_news_sync.py"),
					["--sources", sources, "--limit", String(limit), "--output", outputPath],
					120000,
				);
				results.push(`市场宏观新闻: 同步完成 (${((Date.now() - mktStart) / 1000).toFixed(1)}s)`);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			results.push(`市场宏观新闻: 同步失败 - ${msg}`);
		}

		// 2. Sync individual stock news based on scope
		if (scope === "market") {
			results.push("个股新闻: 跳过 (scope=market)");
		} else if (scope === "watchlist") {
			const config = loadUserConfig();
			const watchlist = config.watchlist || [];
			if (watchlist.length === 0) {
				results.push("个股新闻: 跳过 (关注列表为空)");
			} else {
				console.log(`[sync_news] 同步关注列表股票新闻 (${watchlist.length}只)...`);
				const stockStart = Date.now();
				const stockResults: string[] = [];
				for (const item of watchlist) {
					try {
						const tmpDir = mkdtempSync(join(tmpdir(), "stock-news-sync-"));
						const outputPath = join(tmpDir, "result.json");
						try {
							await runPython(
								resolveLocalDataScript("news_sync.py"),
								[
									"--code",
									item.code,
									"--name",
									item.name,
									"--sources",
									sources,
									"--limit",
									String(limit),
									"--output",
									outputPath,
								],
								60000,
							);
							stockResults.push(`${item.code}: 成功`);
						} finally {
							rmSync(tmpDir, { recursive: true, force: true });
						}
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						stockResults.push(`${item.code}: 失败 - ${msg.slice(0, 60)}`);
					}
				}
				results.push(
					`个股新闻: 同步完成 ${watchlist.length}只关注股票 (${((Date.now() - stockStart) / 1000).toFixed(1)}s)`,
				);
			}
		} else if (scope === "all") {
			console.log(`[sync_news] 同步全市场个股新闻 (sources=${sources})...`);
			const stockStart = Date.now();
			try {
				const tmpDir = mkdtempSync(join(tmpdir(), "stock-news-sync-"));
				const outputPath = join(tmpDir, "result.json");
				try {
					await runPython(
						resolveLocalDataScript("news_sync.py"),
						["--batch", "--sources", sources, "--limit", String(limit), "--output", outputPath],
						1800000,
					);
					results.push(`个股新闻: 全市场同步完成 (${((Date.now() - stockStart) / 1000).toFixed(1)}s)`);
				} finally {
					rmSync(tmpDir, { recursive: true, force: true });
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				results.push(`个股新闻: 同步失败 - ${msg}`);
			}
		}

		const text = `【新闻同步结果】\n${results.join("\n")}`;

		return {
			content: [{ type: "text", text }],
			details: { marketNews: results[0] || "", stockNews: results[1] || "" },
		};
	},
};
