#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { createDataStore } from "../src/data/index.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(homedir(), ".trading-agent", "data");

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const poolId = Number(process.argv[2]);
	const pool = await store.getStockPoolById(poolId);
	if (!pool) throw new Error(`Pool ${poolId} not found`);
	const items = await store.getStockPoolItems(pool.id);
	console.log(`Pool "${pool.name}" has ${items.length} items`);
	let withData = 0;
	let totalKlines = 0;
	for (const item of items) {
		const rows = await store.getKlines({ code: item.code, market: item.market, period: "daily", adjust: "bfq", limit: 1 });
		if (rows.length > 0) withData++;
		totalKlines += rows.length;
	}
	console.log(`Items with at least 1 kline: ${withData}/${items.length}`);
	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
