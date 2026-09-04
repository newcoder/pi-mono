#!/usr/bin/env node
/**
 * Comprehensive local data sync script.
 * Syncs: indices, quotes, klines, sectors, macro, stock list.
 * Usage: node scripts/sync-all-data.mjs
 */
import { spawn } from "node:child_process";
import { createDataStore, DataSyncService } from "../dist/data/index.js";

function getDataDir() {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

function runPython(scriptPath, args, timeoutMs = 120000) {
	return new Promise((resolve, reject) => {
		const proc = spawn("python", [scriptPath, ...args], { timeout: timeoutMs });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => { stdout += d.toString(); });
		proc.stderr.on("data", (d) => { stderr += d.toString(); });
		proc.on("close", (code) => {
			if (code !== 0) reject(new Error(`Exit ${code}: ${stderr}`));
			else {
				try { resolve(JSON.parse(stdout)); } catch { resolve(stdout); }
			}
		});
	});
}

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_DATA_SCRIPTS = join(__dirname, "../skills/local-data/scripts/");

async function main() {
	const dataDir = getDataDir();
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);

	const results = [];
	const startTotal = Date.now();

	// 1. Stock list
	console.log("[SyncAll] === Syncing stock list ===");
	try {
		const count = await sync.syncStockList("all");
		results.push(`Stock list: ${count} stocks`);
		console.log(`[SyncAll] Stock list: ${count}`);
	} catch (e) {
		results.push(`Stock list: failed - ${e instanceof Error ? e.message : String(e)}`);
	}

	// 2. Sectors
	console.log("[SyncAll] === Syncing sectors ===");
	try {
		const sectors = await sync.syncSectors();
		results.push(`Sectors: ${sectors.length} sectors`);
		console.log(`[SyncAll] Sectors: ${sectors.length}`);
	} catch (e) {
		results.push(`Sectors: failed - ${e instanceof Error ? e.message : String(e)}`);
	}

	// 3. Macro
	console.log("[SyncAll] === Syncing macro data ===");
	try {
		const macro = await sync.syncMacro();
		results.push(`Macro: ${macro.snapshot_date}`);
		console.log(`[SyncAll] Macro: ${macro.snapshot_date}`);
	} catch (e) {
		results.push(`Macro: failed - ${e instanceof Error ? e.message : String(e)}`);
	}

	// 4. K-lines (daily incremental)
	console.log("[SyncAll] === Syncing daily klines ===");
	try {
		const klines = await sync.syncAllKlines("daily", "bfq", 500);
		results.push(`Klines (daily): ${klines} rows`);
		console.log(`[SyncAll] Klines (daily): ${klines}`);
	} catch (e) {
		results.push(`Klines: failed - ${e instanceof Error ? e.message : String(e)}`);
	}

	// 5. Fundamentals (skip if recently synced)
	console.log("[SyncAll] === Syncing fundamentals ===");
	try {
		const funds = await sync.syncAllFundamentals(100, 12, false);
		results.push(`Fundamentals: ${funds} rows`);
		console.log(`[SyncAll] Fundamentals: ${funds}`);
	} catch (e) {
		results.push(`Fundamentals: failed - ${e instanceof Error ? e.message : String(e)}`);
	}

	// 6. Market news (macro)
	console.log("[SyncAll] === Syncing market news ===");
	try {
		const mktNews = await runPython(`${LOCAL_DATA_SCRIPTS}market_news_sync.py`, ["--sources", "cls", "--limit", "100"], 120000);
		results.push(`Market news: ${mktNews.saved ?? "?"} saved`);
		console.log(`[SyncAll] Market news: ${JSON.stringify(mktNews)}`);
	} catch (e) {
		results.push(`Market news: failed - ${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`);
	}

	// 7. Stock news (batch for watchlist / limited scope — skip full market to avoid timeout)
	console.log("[SyncAll] === Syncing stock news (batch mode) ===");
	try {
		const stockNews = await runPython(`${LOCAL_DATA_SCRIPTS}news_sync.py`, ["--batch", "--sources", "eastmoney", "--limit", "5"], 600000);
		results.push(`Stock news: ${stockNews.total_saved ?? "?"} saved`);
		console.log(`[SyncAll] Stock news: ${JSON.stringify(stockNews)}`);
	} catch (e) {
		results.push(`Stock news: failed - ${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`);
	}

	// 8. Data quality random sampling
	console.log("[SyncAll] === Running data quality sampling ===");
	try {
		const samplerPath = `${LOCAL_DATA_SCRIPTS}data_quality_sampler.py`;
		const qualityReport = await runPython(
			samplerPath,
			["--stocks", "5", "--dates", "3", "--output", `${process.env.HOME || process.env.USERPROFILE}/.trading-agent/logs/data_quality_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.json`],
			120000,
		);
		results.push(`Data quality: sampled ${qualityReport.sampled_stocks?.length ?? '?'} stocks`);
		console.log(`[SyncAll] Data quality sampling completed`);
	} catch (e) {
		results.push(`Data quality: failed - ${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`);
	}

	const elapsed = ((Date.now() - startTotal) / 1000 / 60).toFixed(1);
	console.log(`\n[SyncAll] Done in ${elapsed} minutes.`);
	console.log("Results:");
	for (const r of results) {
		console.log(`  - ${r}`);
	}

	store.close();
}

main().catch((e) => {
	console.error("[SyncAll] Failed:", e);
	process.exit(1);
});
