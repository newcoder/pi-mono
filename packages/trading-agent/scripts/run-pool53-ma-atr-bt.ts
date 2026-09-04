import fs from "node:fs";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { backtestStrategyTool } from "../src/tools/backtest.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
const STRATEGIES = [
	"ma_cross", "macd_cross", "rsi_reversal", "bollinger_breakout", "supertrend",
	"hammer", "bullish_engulf", "morning_star", "three_soldiers", "tech_composite",
	"breakout", "volume_contraction", "shooting_star", "bearish_engulf", "evening_star",
	"three_crows", "rsi_overbought_sell", "time_exit", "always_buy",
	"kd_daily", "kd_weekly"
] as const;
const MODES = ["equal_weight", "linear"] as const;
const RANK_BY = "ma_alignment";
const SIZING = "atr";
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
		for (const strategy of STRATEGIES) {
			const t0 = Date.now();
			console.log(`Running pool53 ${mode} ${RANK_BY} ${SIZING} ${strategy} ...`);
			try {
				const res = await backtestStrategyTool.execute(`bt-pool53-${mode}-${RANK_BY}-${SIZING}-${strategy}`, {
					pool_id: 53,
					strategy: strategy as any,
					full_position: true,
					full_position_mode: mode as any,
					position_sizing_method: SIZING as any,
					initialCapital: 100000000,
					max_positions: 10,
					start: START,
					end: END,
					rank_by: RANK_BY as any,
				});
				const metrics = (res.details as any)?.metrics;
				results.push({
					mode,
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
				console.log(`  -> ${metrics?.totalReturn?.toFixed(2)}% / MDD ${metrics?.maxDrawdown?.toFixed(2)}%`);
			} catch (e) {
				results.push({ mode, strategy, elapsedMs: Date.now() - t0, error: (e as Error).message });
				console.error(`  -> error:`, (e as Error).message);
			}
			fs.writeFileSync("backtest_pool53_ma_atr.json", JSON.stringify(results, null, 2));
		}
	}

	console.log("\nAll done. Results saved to backtest_pool53_ma_atr.json");
	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
