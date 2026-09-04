import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig } from "../src/backtest/types.js";
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

const STRATEGIES_TO_TEST: Array<{ label: string; buyStrategies: PoolBacktestConfig["buyStrategies"]; note?: string }> = [
	{ label: "ma_cross", buyStrategies: [{ strategy: "ma_cross" }] },
	{ label: "macd_cross", buyStrategies: [{ strategy: "macd_cross" }] },
	{ label: "rsi_reversal", buyStrategies: [{ strategy: "rsi_reversal" }] },
	{ label: "bollinger_breakout", buyStrategies: [{ strategy: "bollinger_breakout" }] },
	{ label: "supertrend", buyStrategies: [{ strategy: "supertrend" }] },
	{ label: "tech_composite", buyStrategies: [{ strategy: "tech_composite" }] },
	{ label: "breakout", buyStrategies: [{ strategy: "breakout" }] },
	{ label: "volume_contraction", buyStrategies: [{ strategy: "volume_contraction" }] },
	{ label: "hammer", buyStrategies: [{ strategy: "hammer" }] },
	{ label: "bullish_engulf", buyStrategies: [{ strategy: "bullish_engulf" }] },
	{ label: "morning_star", buyStrategies: [{ strategy: "morning_star" }] },
	{ label: "three_soldiers", buyStrategies: [{ strategy: "three_soldiers" }] },
	{ label: "shooting_star", buyStrategies: [{ strategy: "shooting_star" }], note: "sell-only" },
	{ label: "bearish_engulf", buyStrategies: [{ strategy: "bearish_engulf" }], note: "sell-only" },
	{ label: "evening_star", buyStrategies: [{ strategy: "evening_star" }], note: "sell-only" },
	{ label: "three_crows", buyStrategies: [{ strategy: "three_crows" }], note: "sell-only" },
	{ label: "rsi_overbought_sell", buyStrategies: [{ strategy: "rsi_overbought_sell" }], note: "sell-only" },
];

async function main() {
	const poolId = 85;
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
	if (items.length === 0) {
		console.error(`Pool ${poolId} is empty`);
		process.exit(1);
	}
	console.log(`Pool: ${pool.name} (${items.length} stocks)`);

	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));

	const baseConfig: PoolBacktestConfig = {
		start: "20230627",
		buyStrategies: [],
		sellStrategies: [],
		period: "daily",
		adjust: "qfq",
		initialCapital: 100_000_000,
		fullPosition: true,
		fullPositionMode: "equal_weight",
		maxPositionWeight: 0.05,
		maxPositions: 20,
		rankBy: "ma_alignment",
		slippage: 0.001,
		commission: 0.0003,
		minLot: 100,
		minTradeAmount: 0,
	};

	const rows: Array<{
		label: string;
		totalReturn: string;
		annualizedReturn: string;
		maxDrawdown: string;
		winRate: string;
		profitFactor: string;
		avgHoldingDays: string;
		trades: number;
		elapsed: string;
		note?: string;
	}> = [];

	for (const option of STRATEGIES_TO_TEST) {
		const config: PoolBacktestConfig = {
			...baseConfig,
			buyStrategies: option.buyStrategies,
		};
		const t0 = Date.now();
		const result = await runPoolBacktest(stocks, config);
		const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
		const sellTrades = result.trades.filter((t) => t.direction === "sell");
		rows.push({
			label: option.label,
			totalReturn: result.metrics.totalReturn.toFixed(2),
			annualizedReturn: result.metrics.annualizedReturn.toFixed(2),
			maxDrawdown: result.metrics.maxDrawdown.toFixed(2),
			winRate: result.metrics.winRate.toFixed(2),
			profitFactor: result.metrics.profitFactor.toFixed(2),
			avgHoldingDays: result.metrics.avgHoldingDays.toFixed(1),
			trades: sellTrades.length,
			elapsed,
			note: option.note,
		});
	}

	rows.sort((a, b) => Number.parseFloat(b.totalReturn) - Number.parseFloat(a.totalReturn));

	console.log(`\n=== Strategy Comparison on ${pool.name} (rank_by=${baseConfig.rankBy}) ===`);
	console.table(rows);

	await store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
