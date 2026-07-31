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

	const res = await backtestStrategyTool.execute("bt-diag-morning_star", {
		pool_id: 53,
		strategy: "morning_star",
		full_position: true,
		full_position_mode: "equal_weight",
		position_sizing_method: "atr",
		initialCapital: 100000000,
		max_positions: 10,
		start: "20230701",
		end: "20260630",
		rank_by: "ma_alignment",
	});

	const trades = ((res.details as any)?.trades as any[]) ?? [];
	const byDateCode = new Map<string, { buys: number; sells: number }>();
	for (const t of trades) {
		const key = `${t.date}|${t.code}`;
		const entry = byDateCode.get(key) ?? { buys: 0, sells: 0 };
		if (t.direction === "buy") entry.buys++;
		else if (t.direction === "sell") entry.sells++;
		byDateCode.set(key, entry);
	}
	let roundTrips = 0;
	for (const [key, v] of byDateCode) {
		if (v.buys > 0 && v.sells > 0) roundTrips++;
	}
	console.log("total trades:", trades.length);
	console.log("same-day buy+sell occurrences:", roundTrips);
	console.log("sell trades:", trades.filter((t) => t.direction === "sell").length);
	console.log("buy trades:", trades.filter((t) => t.direction === "buy").length);

	// Sample round-trip memos
	const sampleKeys = [...byDateCode.entries()].filter(([, v]) => v.buys > 0 && v.sells > 0).slice(0, 5).map(([k]) => k);
	for (const key of sampleKeys) {
		const [date, code] = key.split("|");
		console.log(`\nSample ${date} ${code}:`);
		for (const t of trades.filter((t) => t.date === date && t.code === code)) {
			console.log(`  ${t.direction} ${t.shares} @ ${t.price} memo=${t.memo}`);
		}
	}

	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
