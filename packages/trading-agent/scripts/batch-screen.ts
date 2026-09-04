#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig, SignalSource, StrategyType } from "../src/backtest/types.js";
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

const STRATEGIES: Array<{ label: StrategyType; note?: string }> = [
	{ label: "ma_cross" },
	{ label: "macd_cross" },
	{ label: "rsi_reversal" },
	{ label: "bollinger_breakout" },
	{ label: "supertrend" },
	{ label: "tech_composite" },
	{ label: "breakout" },
	{ label: "volume_contraction" },
	{ label: "hammer" },
	{ label: "bullish_engulf" },
	{ label: "morning_star" },
	{ label: "three_soldiers" },
	{ label: "shooting_star", note: "sell-only" },
	{ label: "bearish_engulf", note: "sell-only" },
	{ label: "evening_star", note: "sell-only" },
	{ label: "three_crows", note: "sell-only" },
	{ label: "rsi_overbought_sell", note: "sell-only" },
];

const RANK_BY: PoolBacktestConfig["rankBy"][] = [
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
	const poolId = Number.parseInt(process.argv[2], 10);
	const outputPath = process.argv[3];
	if (Number.isNaN(poolId) || !outputPath) {
		console.error("Usage: npx tsx scripts/batch-screen.ts <pool_id> <output.csv>");
		process.exit(1);
	}

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
	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));
	console.log(`[${pool.name}] ${stocks.length} stocks -> ${outputPath}`);

	await mkdir(dirname(outputPath), { recursive: true });
	const out = createWriteStream(outputPath, { encoding: "utf-8" });
	out.write("pool,pool_size,strategy,rank_by,total_return,annualized_return,max_drawdown,win_rate,profit_factor,avg_holding_days,trades,elapsed_sec\n");

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
		slippage: 0.001,
		commission: 0.0003,
		minLot: 100,
		minTradeAmount: 0,
	};

	let completed = 0;
	const total = STRATEGIES.length * RANK_BY.length;

	for (const strategy of STRATEGIES) {
		const buyStrategies: SignalSource[] = [{ strategy: strategy.label }];
		for (const rankBy of RANK_BY) {
			const config: PoolBacktestConfig = { ...baseConfig, buyStrategies, rankBy, randomRuns: rankBy === "random" ? 3 : undefined };
			const t0 = Date.now();
			let result;
			try {
				result = await runPoolBacktest(stocks, config);
			} catch (e) {
				console.error(`[${pool.name}] ${strategy.label}/${rankBy} failed:`, (e as Error).message);
				completed++;
				continue;
			}
			const elapsed = (Date.now() - t0) / 1000;
			const sellTrades = result.trades.filter((t) => t.direction === "sell");
			const row = [
				pool.name,
				stocks.length,
				strategy.label,
				rankBy,
				result.metrics.totalReturn.toFixed(2),
				result.metrics.annualizedReturn.toFixed(2),
				result.metrics.maxDrawdown.toFixed(2),
				result.metrics.winRate.toFixed(2),
				result.metrics.profitFactor.toFixed(2),
				result.metrics.avgHoldingDays.toFixed(1),
				sellTrades.length,
				elapsed.toFixed(1),
			].join(",");
			out.write(`${row}\n`);
			completed++;
			console.log(`[${pool.name}] ${completed}/${total} ${strategy.label}/${rankBy} -> ${result.metrics.totalReturn.toFixed(2)}% (${elapsed.toFixed(1)}s)`);
		}
	}

	out.end();
	await new Promise<void>((resolve) => out.on("finish", resolve));
	await store.close();
	console.log(`[${pool.name}] done -> ${outputPath}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
