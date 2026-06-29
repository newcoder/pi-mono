#!/usr/bin/env node
import { runDynamicPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig } from "../src/backtest/types.js";
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

const RANK_BY_OPTIONS: Array<PoolBacktestConfig["rankBy"]> = [
	"ma_alignment",
	"weekly_ma_alignment",
	"momentum",
	"technical",
];

async function main() {
	const poolId = Number(process.argv[2] || 94);
	const dataDir = getDataDir();
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataStore(store);

	const pool = await store.getStockPoolById(poolId);
	if (!pool) {
		console.error(`Pool ${poolId} not found`);
		process.exit(1);
	}
	console.log(`Dynamic pool: ${pool.name} (ID: ${poolId})`);

	const baseConfig: PoolBacktestConfig = {
		start: "20230627",
		buyStrategies: [{ strategy: "supertrend" }],
		period: "daily",
		adjust: "qfq",
		initialCapital: 100_000_000,
		fullPosition: true,
		fullPositionMode: "equal_weight",
		maxPositionWeight: 0.05,
		maxPositions: 20,
		slippage: 0.001,
		commission: 0.0003,
		minLot: 100,
		minTradeAmount: 0,
	};

	const rows: Array<{
		rankBy: string;
		totalReturn: string;
		annualizedReturn: string;
		maxDrawdown: string;
		winRate: string;
		profitFactor: string;
		avgHoldingDays: string;
		trades: number;
		elapsed: string;
	}> = [];

	for (const rankBy of RANK_BY_OPTIONS) {
		const config: PoolBacktestConfig = { ...baseConfig, rankBy };
		const t0 = Date.now();
		const result = await runDynamicPoolBacktest(poolId, config);
		const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
		const sellTrades = result.trades.filter((t) => t.direction === "sell");
		rows.push({
			rankBy: rankBy ?? "none",
			totalReturn: result.metrics.totalReturn.toFixed(2),
			annualizedReturn: result.metrics.annualizedReturn.toFixed(2),
			maxDrawdown: result.metrics.maxDrawdown.toFixed(2),
			winRate: result.metrics.winRate.toFixed(2),
			profitFactor: result.metrics.profitFactor.toFixed(2),
			avgHoldingDays: result.metrics.avgHoldingDays.toFixed(1),
			trades: sellTrades.length,
			elapsed,
		});
	}

	rows.sort((a, b) => Number.parseFloat(b.totalReturn) - Number.parseFloat(a.totalReturn));

	console.log(`\n=== Supertrend on ${pool.name} ===`);
	console.table(rows);

	await store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
