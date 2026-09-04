#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { backtestStrategyTool } from "../src/tools/backtest.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(homedir(), ".trading-agent", "data");

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(join(dataDir, "market.db"));
	setDataStore(store);
	setDataSync(sync);

	const result = await backtestStrategyTool.execute("single-report", {
		pool_id: 53,
		strategy: "supertrend",
		start: "20230626",
		end: "20260626",
		period: "daily",
		adjust: "bfq",
		initialCapital: 100_000_000,
		full_position: true,
		full_position_mode: "equal_weight",
		rebalance_threshold: 0,
		max_position_weight: 0.1,
		min_trade_amount: 0,
		slippage: 0.001,
		commission: 0.0003,
		min_lot: 100,
		rank_by: "ma_alignment",
		max_positions: 15,
	});

	console.log("Status:", result.details?.error ? "ERROR" : "OK");
	if (result.details?.error) console.log("Error:", result.details.error);
	console.log("Metrics:", JSON.stringify(result.details?.metrics, null, 2));
	console.log("Report URL:", result.details?.reportUrl);
	console.log("Trades:", result.details?.trades?.length ?? 0);

	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
