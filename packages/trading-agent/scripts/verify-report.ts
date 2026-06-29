#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig } from "../src/backtest/types.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(homedir(), ".trading-agent", "data");

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(join(dataDir, "market.db"));
	setDataStore(store);
	setDataSync(sync);

	const pool = await store.getStockPoolById(80);
	if (!pool) throw new Error("pool not found");
	const items = await store.getStockPoolItems(pool.id);
	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));

	const config: PoolBacktestConfig = {
		strategy: "morning_star",
		start: "20230626",
		end: "20260626",
		period: "daily",
		adjust: "bfq",
		initialCapital: 100_000_000,
		positionSize: 1.0,
		fullPosition: true,
		fullPositionMode: "equal_weight",
		rebalanceThreshold: 0,
		maxPositionWeight: 0.1,
		minTradeAmount: 0,
		slippage: 0.001,
		commission: 0.0003,
		minLot: 100,
		rankBy: "weekly_ma_alignment",
		maxPositions: 20,
	};
	const result = await runPoolBacktest(stocks, config);
	console.log("total trades:", result.trades.length);
	console.log("last 5 trades:");
	for (const t of result.trades.slice(-5)) {
		console.log(t.date, t.code, t.direction, t.memo, t.price.toFixed(2));
	}
	const zz539 = result.trades.filter((t) => t.date === "2026-06-26" && t.code === "000539");
	console.log("000539 trades on 2026-06-26:", zz539.length);
	for (const t of zz539) console.log(t);
	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
