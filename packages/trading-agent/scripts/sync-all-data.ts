#!/usr/bin/env tsx
/**
 * 全量数据同步脚本
 * 依次同步：股票列表 → 行业分类 → 概念 → 板块 → K线 → 财务数据 → 宏观数据
 *
 * 用法:
 *   npx tsx scripts/sync-all-data.ts [--skip-existing]
 *
 * 注意：完整同步全市场 K线(5500只)约需 1-2 分钟，
 *       财务数据约需 30-60 分钟。建议在盘后运行。
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createDataStore, DataSyncService } from "../src/data/index.js";

const HOME = process.env.HOME || process.env.USERPROFILE || ".";
const DATA_DIR = process.env.TRADING_AGENT_DATA_DIR || join(HOME, ".trading-agent/data");

const SKIP_EXISTING = process.argv.includes("--skip-existing");

async function main() {
	console.log(`[SyncAll] 数据目录: ${DATA_DIR}`);
	console.log(`[SyncAll] 跳过已存在: ${SKIP_EXISTING}`);
	console.log("========================================");

	const store = createDataStore(DATA_DIR);
	await store.init();
	const sync = new DataSyncService(store);
	const startTime = Date.now();
	const results: string[] = [];

	// Helper to run each step with error isolation
	async function runStep<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
		try {
			return await fn();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`  ✗ ${name} 失败: ${msg.slice(0, 200)}`);
			results.push(`${name}: 失败 - ${msg.slice(0, 60)}`);
			return null;
		}
	}

	// 1. 股票列表
	console.log("\n[1/7] 同步股票列表...");
	const stockCount = await runStep("股票列表", () => sync.syncStockList("all"));
	if (stockCount !== null) {
		results.push(`股票列表: ${stockCount} 只`);
		console.log(`  ✓ ${stockCount} 只股票`);
	}

	// 2. 行业分类
	console.log("\n[2/7] 同步行业分类...");
	const industryResult = await runStep("行业分类", () => sync.syncIndustries());
	if (industryResult !== null) {
		results.push(
			`行业分类: ${industryResult.standards} 个标准, ${industryResult.industries} 个行业, ${industryResult.mappings} 条映射`,
		);
		console.log(
			`  ✓ ${industryResult.standards} 个标准, ${industryResult.industries} 个行业, ${industryResult.mappings} 条映射`,
		);
		if (industryResult.errors.length > 0) {
			console.warn(`  ⚠ ${industryResult.errors.length} 个标准失败`);
		}
	}

	// 3. 概念数据
	console.log("\n[3/7] 同步概念数据...");
	const conceptCount = await runStep("概念数据", () => sync.syncAllConcepts());
	if (conceptCount !== null) {
		results.push(`概念数据: ${conceptCount} 个概念`);
		console.log(`  ✓ ${conceptCount} 个概念`);
	}

	// 4. 板块数据
	console.log("\n[4/7] 同步板块数据...");
	const sectors = await runStep("板块数据", () => sync.syncSectors());
	if (sectors !== null) {
		results.push(`板块数据: ${sectors.length} 个板块`);
		console.log(`  ✓ ${sectors.length} 个板块`);
	}

	// 5. K线数据（增量）
	console.log("\n[5/7] 同步K线数据(日线, 增量)...");
	const klineCount = await runStep("K线数据", () => sync.syncAllKlines("daily", "bfq", 500));
	if (klineCount !== null) {
		results.push(`K线数据: ${klineCount} 条`);
		console.log(`  ✓ ${klineCount} 条K线`);
	}

	// 6. 财务数据（增量）
	console.log("\n[6/7] 同步财务数据(增量)...");
	const fundCount = await runStep("财务数据", () => sync.syncAllFundamentals(100));
	if (fundCount !== null) {
		results.push(`财务数据: ${fundCount} 条记录`);
		console.log(`  ✓ ${fundCount} 条财报记录`);
	}

	// 7. 宏观数据
	console.log("\n[7/7] 同步宏观数据...");
	const macro = await runStep("宏观数据", () => sync.syncMacro());
	if (macro !== null) {
		results.push("宏观数据: 已同步");
		console.log("  ✓ 已同步");
	}

	// 8. 数据质量抽样验证
	console.log("\n[8/8] 数据质量抽样验证...");
	try {
		const samplerScript = join(
			__dirname,
			"../skills/local-data/scripts/data_quality_sampler.py",
		);
		const logDir = join(HOME, ".trading-agent/logs");
		const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
		const reportPath = join(logDir, `data_quality_${today}.json`);
		const output = execSync(
			`python "${samplerScript}" --stocks 5 --dates 3 --output "${reportPath}"`,
			{ encoding: "utf-8", timeout: 120_000 },
		);
		const balanced = (output.match(/\[平衡\]/g) || []).length;
		const unbalanced = (output.match(/\[不平衡/g) || []).length;
		results.push(`数据质量: 抽样检查完成, 平衡=${balanced}, 不平衡=${unbalanced}`);
		console.log(`  ✓ 数据质量抽样完成 (平衡=${balanced}, 不平衡=${unbalanced})`);
		console.log(`  报告: ${reportPath}`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		results.push(`数据质量: 失败 - ${msg.slice(0, 60)}`);
		console.error(`  ✗ 数据质量抽样失败: ${msg.slice(0, 100)}`);
	}

	store.close();

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log("\n========================================");
	console.log("全量同步完成");
	console.log(`总耗时: ${elapsed} 秒`);
	console.log("----------------------------------------");
	for (const r of results) {
		console.log(`  ${r}`);
	}
	console.log("========================================");
}

main().catch((e) => {
	console.error("[SyncAll] 致命错误:", e);
	process.exit(1);
});
