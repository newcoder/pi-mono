#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
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
		maxPositionWeight: 0.1,
		minTradeAmount: 0,
		slippage: 0.001,
		commission: 0.0003,
		minLot: 100,
		rankBy: "ma_alignment",
		maxPositions: 15,
	};

	const result = await runPoolBacktest(stocks, config);

	// Reconstruct final positions
	const positions = new Map<string, { code: string; market: number; shares: number; entryPrice?: number }>();
	for (const t of result.trades) {
		const key = `${t.code}_${t.market}`;
		const current = positions.get(key);
		const shares = (current?.shares ?? 0) + (t.direction === "buy" ? t.shares : -t.shares);
		if (shares <= 0) {
			positions.delete(key);
		} else {
			positions.set(key, { code: t.code, market: t.market, shares, entryPrice: t.price });
		}
	}

	// Fetch last-day close for valuation
	const holdings: Array<{
		code: string;
		market: number;
		name: string | null;
		shares: number;
		price: number;
		value: number;
		weight: number;
	}> = [];
	let totalValue = result.equityCurve[result.equityCurve.length - 1]?.equity ?? INITIAL_CAPITAL;
	for (const pos of positions.values()) {
		const latestDate = await store.getLatestKlineDate(pos.code, pos.market, "daily", "bfq");
		const klines = latestDate
			? await store.getKlines({
					code: pos.code,
					market: pos.market,
					period: "daily",
					adjust: "bfq",
					start: latestDate,
					end: latestDate,
				})
			: [];
		const close = klines[0]?.close ?? pos.entryPrice ?? 0;
		const stock = await store.getStock(pos.code);
		const value = pos.shares * close;
		holdings.push({
			code: pos.code,
			market: pos.market,
			name: stock?.name ?? null,
			shares: pos.shares,
			price: close,
			value,
			weight: totalValue > 0 ? value / totalValue : 0,
		});
	}

	holdings.sort((a, b) => b.value - a.value);

	const reportsDir = join(dataDir, "..", "reports");
	await mkdir(reportsDir, { recursive: true });
	const outputPath = join(reportsDir, `final-holdings-${result.endDate}-ma-alignment-15.csv`);
	const stream = createWriteStream(outputPath, { encoding: "utf-8" });
	stream.write("code,market,name,shares,price,value,weight_pct\n");
	const investedValue = holdings.reduce((sum, h) => sum + h.value, 0);
	const cashValue = totalValue - investedValue;
	if (cashValue > 0.01) {
		stream.write(
			`CASH,0,"现金",0,1,${cashValue.toFixed(2)},${((cashValue / totalValue) * 100).toFixed(2)}\n`,
		);
	}
	for (const h of holdings) {
		stream.write(
			`${h.code},${h.market},"${h.name ?? ""}",${h.shares},${h.price.toFixed(4)},${h.value.toFixed(2)},${(h.weight * 100).toFixed(2)}\n`,
		);
	}
	stream.end();
	await new Promise<void>((resolve, reject) => {
		stream.on("finish", resolve);
		stream.on("error", reject);
	});

	console.log(`Final holdings: ${holdings.length} stocks`);
	console.log(`Total equity: ${totalValue.toLocaleString()}`);
	console.log(`CSV written to: ${outputPath}`);
	for (const h of holdings) {
		console.log(`${h.code} ${h.name ?? ""}  ${h.shares}股  价格${h.price.toFixed(2)}  市值${h.value.toLocaleString()}  权重${(h.weight * 100).toFixed(2)}%`);
	}

	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
