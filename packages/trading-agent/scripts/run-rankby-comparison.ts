#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig, StrategyType } from "../src/backtest/types.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(homedir(), ".trading-agent", "data");
const POOL_ID = 53;
const STRATEGY: StrategyType = "supertrend";
const START = "20230626";
const END = "20260626";
const INITIAL_CAPITAL = 100_000_000;
const MAX_POSITION_WEIGHT = 0.1;

const RANK_OPTIONS: Array<
	| { key: string; rankBy: PoolBacktestConfig["rankBy"]; lookback?: number }
> = [
	{ key: "momentum", rankBy: "momentum" },
	{ key: "value", rankBy: "value" },
	{ key: "turnover", rankBy: "turnover" },
	{ key: "technical", rankBy: "technical" },
	{ key: "low_vol_5", rankBy: "low_volatility", lookback: 5 },
	{ key: "low_vol_10", rankBy: "low_volatility", lookback: 10 },
	{ key: "signal_recency", rankBy: "signal_recency" },
	{ key: "ma_alignment", rankBy: "ma_alignment" },
	{ key: "random", rankBy: "random" },
];

const MAX_POSITIONS_OPTIONS: Array<number | undefined> = [30, 50];

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(join(dataDir, "market.db"));
	setDataStore(store);
	setDataSync(sync);

	const pool = await store.getStockPoolById(POOL_ID);
	if (!pool) {
		console.error(`Pool ${POOL_ID} not found`);
		process.exit(1);
	}
	const items = await store.getStockPoolItems(pool.id);
	console.log(`Pool "${pool.name}" has ${items.length} stocks`);

	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));

	for (const maxPositions of MAX_POSITIONS_OPTIONS) {
		console.log(`\n\n========== max_positions=${maxPositions ?? "unlimited"} ==========`);
		const results: Array<{ key: string; metrics: any; finalEquity: number; tradeCount: number }> = [];

		for (const opt of RANK_OPTIONS) {
			const config: PoolBacktestConfig = {
				strategy: STRATEGY,
				start: START,
				end: END,
				period: "daily",
				adjust: "bfq",
				initialCapital: INITIAL_CAPITAL,
				positionSize: 1.0,
				fullPosition: true,
				fullPositionMode: "equal_weight",
				rebalanceThreshold: 0,
				maxPositionWeight: MAX_POSITION_WEIGHT,
				minTradeAmount: 0,
				slippage: 0.001,
				commission: 0.0003,
				minLot: 100,
				rankBy: opt.rankBy,
				maxPositions,
				randomRuns: opt.rankBy === "random" ? 10 : undefined,
				volatilityLookbackDays: opt.lookback,
			};

			const result = await runPoolBacktest(stocks, config);
			const finalEquity = result.equityCurve[result.equityCurve.length - 1]?.equity ?? INITIAL_CAPITAL;
			const sellTrades = result.trades.filter((t) => t.direction === "sell").length;
			results.push({ key: opt.key, metrics: result.metrics, finalEquity, tradeCount: sellTrades });
			console.log(
				`  ${opt.key.padEnd(16)} totalReturn=${result.metrics.totalReturn.toFixed(2)}%  annualized=${result.metrics.annualizedReturn.toFixed(2)}%  sharpe=${result.metrics.sharpeRatio.toFixed(3)}  maxDD=${result.metrics.maxDrawdown.toFixed(2)}%  trades=${sellTrades}  final=${finalEquity.toLocaleString()}`,
			);
		}

		console.log("\n  rank_by           totalReturn  annualized  sharpe   maxDD    trades  finalEquity");
		for (const r of results) {
			console.log(
				`  ${r.key.padEnd(17)} ${r.metrics.totalReturn.toFixed(2).padStart(10)}% ${r.metrics.annualizedReturn.toFixed(2).padStart(10)}% ${r.metrics.sharpeRatio.toFixed(3).padStart(7)} ${r.metrics.maxDrawdown.toFixed(2).padStart(7)}% ${String(r.tradeCount).padStart(7)} ${r.finalEquity.toLocaleString().padStart(15)}`,
			);
		}
	}

	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
