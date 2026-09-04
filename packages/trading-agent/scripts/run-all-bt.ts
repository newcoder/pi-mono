import fs from "node:fs";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { backtestStrategyTool } from "../src/tools/backtest.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
const RANK_BY = ["momentum", "value", "turnover", "technical", "low_volatility", "signal_recency", "ma_alignment", "weekly_ma_alignment", "random"];
const MODES = ["equal_weight", "linear"] as const;
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
	for (const mode of MODES) {
		for (const rank of RANK_BY) {
			const t0 = Date.now();
			console.log(`Running ${mode} + ${rank} ...`);
			try {
				const res = await backtestStrategyTool.execute(`bt-${mode}-${rank}`, {
					pool_id: 110,
					strategy: "always_buy",
					rank_by: rank as any,
					full_position: true,
					full_position_mode: mode as any,
					initialCapital: 100000000,
					max_positions: 30,
					start: START,
					end: END,
					benchmark_index: "sh000905",
				});
				const metrics = (res.details as any)?.metrics;
				results.push({
					mode,
					rank_by: rank,
					elapsedMs: Date.now() - t0,
					totalReturn: metrics?.totalReturn,
					annualizedReturn: metrics?.annualizedReturn,
					maxDrawdown: metrics?.maxDrawdown,
					winRate: metrics?.winRate,
					trades: metrics?.totalTrades,
					reportUrl: (res.details as any)?.reportUrl,
					error: (res.details as any)?.error,
				});
				console.log(`  -> totalReturn: ${metrics?.totalReturn?.toFixed(2)}%, annualized: ${metrics?.annualizedReturn?.toFixed(2)}%, MDD: ${metrics?.maxDrawdown?.toFixed(2)}%`);
			} catch (e) {
				results.push({ mode, rank_by: rank, elapsedMs: Date.now() - t0, error: (e as Error).message });
				console.error(`  -> error:`, (e as Error).message);
			}
		}
	}

	fs.writeFileSync("backtest_results_sw2.json", JSON.stringify(results, null, 2));
	console.log("\nAll done. Results saved to backtest_results_sw2.json");
	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
