#!/usr/bin/env node
import { join } from "node:path";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(process.env.HOME || process.env.USERPROFILE || ".", ".trading-agent", "data");

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(join(dataDir, "market.db"));
	setDataStore(store);
	setDataSync(sync);

	const poolId = Number(process.argv[2]);
	if (Number.isNaN(poolId)) {
		console.error("Usage: npx tsx scripts/sync-pool-klines.ts <pool_id>");
		process.exit(1);
	}

	const pool = await store.getStockPoolById(poolId);
	if (!pool) throw new Error(`Pool ${poolId} not found`);
	const items = await store.getStockPoolItems(pool.id);
	console.log(`Syncing klines for pool "${pool.name}" (${items.length} stocks)...`);

	await sync.syncWatchlist(items.map((item) => ({ code: item.code, market: item.market })));

	console.log("Done");
	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
