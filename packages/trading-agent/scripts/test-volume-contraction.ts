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

	const pool = await store.getStockPoolById(53);
	if (!pool) throw new Error("Pool 53 not found");
	const items = await store.getStockPoolItems(pool.id);
	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));

	for (const rankBy of ["ma_alignment", "low_volatility"] as const) {
		const config: PoolBacktestConfig = {
			strategy: "volume_contraction",
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
			rankBy,
			maxPositions: 20,
			volatilityLookbackDays: 5,
		};
		const result = await runPoolBacktest(stocks, config);
		const sellCount = result.trades.filter((t) => t.direction === "sell").length;
		console.log(
			`volume_contraction + ${rankBy}: return ${result.metrics.totalReturn.toFixed(2)}%, sharpe ${result.metrics.sharpeRatio.toFixed(3)}, drawdown ${result.metrics.maxDrawdown.toFixed(2)}%, winRate ${result.metrics.winRate.toFixed(2)}%, trades ${sellCount}, avgHold ${result.metrics.avgHoldingDays.toFixed(2)}`,
		);
	}

	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
