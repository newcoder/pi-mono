#!/usr/bin/env node
/**
 * Backfill fundamentals data from a target year.
 * Reads stock list from local SQLite (no JoinQuant needed).
 * Usage: node scripts/backfill-fundamentals.mjs [--since-year 2019] [--batch-size 100]
 */
import { createDataStore, DataSyncService } from "../dist/data/index.js";

function getDataDir() {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

const args = process.argv.slice(2);
const sinceYear = Number(args.find((_, i) => args[i - 1] === "--since-year") || 2019);
const batchSize = Number(args.find((_, i) => args[i - 1] === "--batch-size") || 100);

async function main() {
	const dataDir = getDataDir();
	const store = createDataStore(dataDir);
	await store.init();

	// Read stock list from local DB instead of JoinQuant
	const stocks = await store.query("SELECT code, market, name FROM stocks ORDER BY code");
	console.log(`[Backfill] Loaded ${stocks.length} stocks from local DB`);

	const sync = new DataSyncService(store);

	const currentYear = new Date().getFullYear();
	const yearsNeeded = currentYear - sinceYear + 1;
	const historyLimit = Math.min(yearsNeeded * 4 + 4, 60);
	const targetDate = `${sinceYear}-01-01`;

	console.log(`[Backfill] Target: since ${sinceYear}, limit=${historyLimit}, stocks=${stocks.length}`);

	let totalSynced = 0;
	let skipped = 0;
	let processed = 0;
	const startTime = Date.now();

	for (let i = 0; i < stocks.length; i += batchSize) {
		const batchNum = Math.floor(i / batchSize) + 1;
		const totalBatches = Math.ceil(stocks.length / batchSize);
		const batch = stocks.slice(i, i + batchSize);

		console.log(`[Backfill] Batch ${batchNum}/${totalBatches} (${batch.length} stocks)...`);

		for (const stock of batch) {
			try {
				const rows = await store.query(
					"SELECT MIN(report_date) as earliest FROM fundamentals WHERE code = ? AND market = ?",
					[stock.code, stock.market],
				);
				const earliest = rows[0]?.earliest;

				if (earliest && earliest <= targetDate) {
					skipped++;
					continue;
				}

				const synced = await sync.syncFundamentals(stock.code, stock.market, historyLimit);
				totalSynced += synced.length;
				processed++;
			} catch (e) {
				console.warn(`[Backfill] Failed for ${stock.code}:`, e instanceof Error ? e.message : String(e));
			}
		}

		if (i + batchSize < stocks.length) {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
	console.log(`[Backfill] Done. Processed ${processed}, skipped ${skipped}, total ${totalSynced} rows in ${elapsed} minutes.`);

	// Recalculate indicators
	if (totalSynced > 0) {
		console.log("[Backfill] Recalculating fundamental indicators...");
		try {
			const { runJsonScript } = await import("../dist/tools/_utils.js");
			const result = await runJsonScript("calc_fundamental_indicators.py", ["--all"], 600_000);
			console.log(`[Backfill] Indicators recalculated: ${result.rows_inserted ?? "?"} rows`);
		} catch (e) {
			console.warn("[Backfill] Indicator recalculation failed:", e);
		}
	}

	store.close();
}

main().catch((e) => {
	console.error("[Backfill] Failed:", e);
	process.exit(1);
});
