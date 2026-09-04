import fs from "node:fs";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { backtestStrategyTool } from "../src/tools/backtest.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;

const POOLS = [
	{ id: 53, name: "自选53" },
	{ id: 81, name: "中证500" },
	{ id: 82, name: "中证1000" },
	{ id: 85, name: "沪深300" },
	{ id: 110, name: "sw2龙头股池" },
] as const;

const RANK_BYS = ["ma_alignment", "weekly_ma_alignment", "value"] as const;

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
	for (const pool of POOLS) {
		for (const rankBy of RANK_BYS) {
			const t0 = Date.now();
			console.log(`Running ${pool.name} + volume_contraction + ${rankBy} ...`);
			try {
				const res = await backtestStrategyTool.execute(`bt-vc-${pool.id}-${rankBy}`, {
					pool_id: pool.id,
					strategy: "volume_contraction",
					full_position: true,
					full_position_mode: "equal_weight",
					position_sizing_method: "atr",
					initialCapital: 100000000,
					max_positions: 10,
					start: START,
					end: END,
					rank_by: rankBy as any,
				});
				const metrics = (res.details as any)?.metrics;
				results.push({
					pool: pool.name,
					poolId: pool.id,
					rankBy,
					elapsedMs: Date.now() - t0,
					totalReturn: metrics?.totalReturn,
					annualizedReturn: metrics?.annualizedReturn,
					maxDrawdown: metrics?.maxDrawdown,
					winRate: metrics?.winRate,
					trades: metrics?.totalTrades,
					avgHoldingDays: metrics?.avgHoldingDays,
					reportUrl: (res.details as any)?.reportUrl,
					error: (res.details as any)?.error,
				});
				console.log(
					`  -> ${metrics?.totalReturn?.toFixed(2)}% / MDD ${metrics?.maxDrawdown?.toFixed(2)}% / trades ${metrics?.totalTrades}`,
				);
			} catch (e) {
				results.push({
					pool: pool.name,
					poolId: pool.id,
					rankBy,
					elapsedMs: Date.now() - t0,
					error: (e as Error).message,
				});
				console.error(`  -> error:`, (e as Error).message);
			}
			fs.writeFileSync("backtest_volume_contraction_rankby.json", JSON.stringify(results, null, 2));
		}
	}

	console.log("\nAll done. Results saved to backtest_volume_contraction_rankby.json");
	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
