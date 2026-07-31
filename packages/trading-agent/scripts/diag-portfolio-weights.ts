import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { backtestStrategyTool } from "../src/tools/backtest.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	setDataStore(store);
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataSync(sync);

	const res = await backtestStrategyTool.execute("bt-diag-macd-linear", {
		pool_id: 53,
		strategy: "macd_cross",
		full_position: true,
		full_position_mode: "linear",
		position_sizing_method: "atr",
		initialCapital: 100000000,
		max_positions: 10,
		start: "20230701",
		end: "20260630",
		rank_by: "ma_alignment",
	});

	const trades = ((res.details as any)?.trades as any[]) ?? [];
	const equityCurve = ((res.details as any)?.equityCurve as any[]) ?? [];
	const metrics = (res.details as any)?.metrics;
	console.log("total return:", metrics?.totalReturn?.toFixed(2), "%");
	console.log("total trades:", trades.length, "sell trades:", trades.filter((t) => t.direction === "sell").length);

	// Print trades for first few rebalance days
	const dates = [...new Set(trades.map((t) => t.date))].sort().slice(0, 5);
	for (const date of dates) {
		const dayTrades = trades.filter((t) => t.date === date);
		console.log(`\n${date} trades:`);
		for (const t of dayTrades) {
			console.log(`  ${t.direction} ${t.code} ${t.shares} @ ${t.price.toFixed(2)} memo=${t.memo}`);
		}
	}

	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
