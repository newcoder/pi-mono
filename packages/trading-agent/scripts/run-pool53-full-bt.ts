import fs from "node:fs";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { backtestStrategyTool } from "../src/tools/backtest.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
const STRATEGIES = [
	"ma_cross", "macd_cross", "rsi_reversal", "bollinger_breakout", "supertrend",
	"hammer", "bullish_engulf", "morning_star", "three_soldiers", "tech_composite",
	"breakout", "volume_contraction", "shooting_star", "bearish_engulf", "evening_star",
	"three_crows", "rsi_overbought_sell", "time_exit", "always_buy"
] as const;
const MODES = ["equal_weight", "linear"] as const;
const RANK_BYS = ["ma_alignment", "weekly_ma_alignment", "low_volatility"] as const;
const SIZING_METHODS = ["fixed", "atr"] as const;
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
	let count = 0;
	const total = STRATEGIES.length * MODES.length * RANK_BYS.length * SIZING_METHODS.length;
	for (const sizing of SIZING_METHODS) {
		for (const mode of MODES) {
			for (const rankBy of RANK_BYS) {
				for (const strategy of STRATEGIES) {
					count++;
					const t0 = Date.now();
					console.log(`[${count}/${total}] pool53 ${mode} ${sizing} ${rankBy} ${strategy}`);
					try {
						const res = await backtestStrategyTool.execute(`bt-pool53-${mode}-${sizing}-${rankBy}-${strategy}`, {
							pool_id: 53,
							strategy: strategy as any,
							full_position: true,
							full_position_mode: mode as any,
							position_sizing_method: sizing as any,
							initialCapital: 100000000,
							max_positions: 10,
							start: START,
							end: END,
							rank_by: rankBy as any,
						});
						const metrics = (res.details as any)?.metrics;
						results.push({
							mode,
							sizing,
							rankBy,
							strategy,
							elapsedMs: Date.now() - t0,
							totalReturn: metrics?.totalReturn,
							annualizedReturn: metrics?.annualizedReturn,
							maxDrawdown: metrics?.maxDrawdown,
							winRate: metrics?.winRate,
							trades: metrics?.totalTrades,
							reportUrl: (res.details as any)?.reportUrl,
							error: (res.details as any)?.error,
						});
						console.log(`  -> ${metrics?.totalReturn?.toFixed(2)}% / MDD ${metrics?.maxDrawdown?.toFixed(2)}% / ${metrics?.totalTrades} trades`);
					} catch (e) {
						results.push({ mode, sizing, rankBy, strategy, elapsedMs: Date.now() - t0, error: (e as Error).message });
						console.error(`  -> error:`, (e as Error).message);
					}
					fs.writeFileSync("backtest_pool53_full.json", JSON.stringify(results, null, 2));
				}
			}
		}
	}

	console.log("\nAll done. Results saved to backtest_pool53_full.json");
	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
