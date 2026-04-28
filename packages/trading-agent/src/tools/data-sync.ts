import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { loadUserConfig } from "../config/user-config.js";
import { getDataSync } from "../data/index.js";
import { runPython } from "./_utils.js";

const A_SHARE_SCRIPTS_DIR = join(
	process.env.HOME || process.env.USERPROFILE || ".",
	".agents/skills/a-share-analysis/scripts",
);

// ── sync_kline tool ─────────────────────────────────────────────────────────

const syncKlineParams = Type.Object({
	period: Type.Optional(
		Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")], {
			description: "K线周期: daily(日线)/weekly(周线)/monthly(月线)",
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
		const label = period === "weekly" ? "周线" : period === "monthly" ? "月线" : "日线";

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
});

export const syncFundamentalsTool: AgentTool<typeof syncFundamentalsParams, { synced: number }> = {
	name: "sync_fundamentals",
	label: "同步财务数据",
	description:
		"同步全市场A股基本面财务数据到本地数据库。包括利润表、资产负债表、现金流量表。约5500只股票，默认批大小100，完整同步约需30-60分钟。使用增量模式跳过最近已同步的股票。",
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

		console.log(`[sync_fundamentals] 开始同步全市场财务数据...`);
		const startTime = Date.now();
		const count = await sync.syncAllFundamentals(batchSize);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

		const text = `【财务数据同步完成】\n同步数量: ${count} 条财报记录\n耗时: ${elapsed} 秒\n说明: 包括利润表、资产负债表、现金流量表。增量模式跳过最近一周已同步的数据。`;

		return {
			content: [{ type: "text", text }],
			details: { synced: count },
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
			description: "新闻来源，如 cls, sina, eastmoney。多个用逗号分隔",
			default: "cls",
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
		const sources = params.sources || "cls";
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
					join(A_SHARE_SCRIPTS_DIR, "market_news_sync.py"),
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
								join(A_SHARE_SCRIPTS_DIR, "news_sync.py"),
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
						join(A_SHARE_SCRIPTS_DIR, "news_sync.py"),
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
