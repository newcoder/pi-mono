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

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(join(dataDir, "market.db"));
	setDataStore(store);
	setDataSync(sync);

	const pool = await store.getStockPoolById(POOL_ID);
	if (!pool) throw new Error(`Pool ${POOL_ID} not found`);
	const items = await store.getStockPoolItems(pool.id);
	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));

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
		minTradeAmount: 0,
		slippage: 0.001,
		commission: 0.0003,
		minLot: 100,
		rankBy: "momentum",
	};

	const result = await runPoolBacktest(stocks, config);

	const positionsByDate = new Map<string, Map<string, number>>();
	for (const trade of result.trades) {
		if (!positionsByDate.has(trade.date)) {
			positionsByDate.set(trade.date, new Map<string, number>());
		}
	}

	// Reconstruct daily positions by replaying trades in order
	const dailyPositions = new Map<string, number>();
	const dateHoldings = new Map<string, Map<string, number>>();
	const currentHoldings = new Map<string, number>();
	for (const trade of result.trades) {
		const key = `${trade.code}_${trade.market}`;
		const current = currentHoldings.get(key) ?? 0;
		const next = trade.direction === "buy" ? current + trade.shares : current - trade.shares;
		if (next <= 0) currentHoldings.delete(key);
		else currentHoldings.set(key, next);
		dateHoldings.set(trade.date, new Map(currentHoldings));
	}

	// For each equity curve date, use last known holdings
	let last: Map<string, number> = new Map();
	let total = 0;
	let maxH = 0;
	for (const point of result.equityCurve) {
		const h = dateHoldings.get(point.date);
		if (h) last = h;
		const count = last.size;
		total += count;
		if (count > maxH) maxH = count;
	}
	const avg = total / result.equityCurve.length;
	console.log(`dates: ${result.equityCurve.length}`);
	console.log(`avg holdings: ${avg.toFixed(2)}`);
	console.log(`max holdings: ${maxH}`);
	console.log(`final holdings: ${last.size}`);

	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
