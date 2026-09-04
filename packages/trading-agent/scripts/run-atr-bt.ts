import fs from "node:fs";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { backtestStrategyTool } from "../src/tools/backtest.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
const TEST_CASES = [
	{ strategy: "bullish_engulf", rankBy: "weekly_ma_alignment" },
	{ strategy: "bullish_engulf", rankBy: "ma_alignment" },
	{ strategy: "three_soldiers", rankBy: "weekly_ma_alignment" },
	{ strategy: "supertrend", rankBy: "weekly_ma_alignment" },
	{ strategy: "volume_contraction", rankBy: "weekly_ma_alignment" },
	{ strategy: "morning_star", rankBy: "ma_alignment" },
	{ strategy: "morning_star", rankBy: "weekly_ma_alignment" },
] as const;
const SIZING_METHODS = ["fixed", "atr"] as const;
const MODE = "equal_weight";
const START = "20230701";
const END = "20260630";

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	setDataStore(store);
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataSync(sync);

	const results: any[] = [];
	for (const sizing of SIZING_METHODS) {
		for (const tc of TEST_CASES) {
			const t0 = Date.now();
			console.log(`Running ${MODE} + ${sizing} + ${tc.rankBy} + ${tc.strategy} ...`);
			try {
				const res = await backtestStrategyTool.execute(`bt-${MODE}-${sizing}-${tc.rankBy}-${tc.strategy}`, {
					pool_id: 110,
					strategy: tc.strategy as any,
					full_position: true,
					full_position_mode: MODE as any,
					position_sizing_method: sizing as any,
					initialCapital: 100000000,
					max_positions: 10,
					start: START,
					end: END,
					rank_by: tc.rankBy as any,
				});
				const metrics = (res.details as any)?.metrics;
				results.push({
					mode: MODE,
					sizing,
					rankBy: tc.rankBy,
					strategy: tc.strategy,
					elapsedMs: Date.now() - t0,
					totalReturn: metrics?.totalReturn,
					annualizedReturn: metrics?.annualizedReturn,
					maxDrawdown: metrics?.maxDrawdown,
					winRate: metrics?.winRate,
					trades: metrics?.totalTrades,
					reportUrl: (res.details as any)?.reportUrl,
					error: (res.details as any)?.error,
				});
				console.log(`  -> totalReturn: ${metrics?.totalReturn?.toFixed(2)}%, MDD: ${metrics?.maxDrawdown?.toFixed(2)}%, trades: ${metrics?.totalTrades}`);
			} catch (e) {
				results.push({ mode: MODE, sizing, rankBy: tc.rankBy, strategy: tc.strategy, elapsedMs: Date.now() - t0, error: (e as Error).message });
				console.error(`  -> error:`, (e as Error).message);
			}
			fs.writeFileSync("backtest_atr_sw2.json", JSON.stringify(results, null, 2));
		}
	}

	console.log("\nAll done. Results saved to backtest_atr_sw2.json");
	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
