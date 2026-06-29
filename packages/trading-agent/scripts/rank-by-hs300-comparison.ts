#!/usr/bin/env node
import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig } from "../src/backtest/types.js";
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

const RANK_BY_OPTIONS: Array<PoolBacktestConfig["rankBy"]> = [
	"momentum",
	"value",
	"turnover",
	"technical",
	"low_volatility",
	"signal_recency",
	"ma_alignment",
	"weekly_ma_alignment",
	"random",
];

async function main() {
	const poolId = Number(process.argv[2] || 85);
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
	const items = await store.getStockPoolItems(pool.id);
	console.log(`Pool: ${pool.name} (${items.length} stocks)`);

	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));

	const baseConfig: PoolBacktestConfig = {
		start: "20200102",
		buyStrategies: [{ strategy: "always_buy" }],
		sellStrategies: [],
		period: "daily",
		adjust: "qfq",
		initialCapital: 10_000_000,
		fullPosition: true,
		fullPositionMode: "equal_weight",
		maxPositionWeight: 0.1,
		maxPositions: 30,
		slippage: 0.001,
		commission: 0.0003,
		minLot: 100,
		minTradeAmount: 0,
		rebalanceFrequency: 5,
		rebalanceThreshold: 0.05,
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
		const result = await runPoolBacktest(stocks, config);
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

	console.log("\n=== HS300 ranking comparison: always_buy + time_exit(5d), 30 positions, 10M ===");
	console.table(rows);

	await store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
