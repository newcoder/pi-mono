/**
 * Backtest a market theme as a dynamic pool.
 * Usage: npx tsx scripts/backtest-theme.ts --theme "半导体" --strategy always_buy --max-positions 20
 */
import { createDataStore, setDataStore } from "../src/data/index.js";
import { runPoolBacktest } from "../src/backtest/engine.js";
import { formatPoolBacktestResult, formatPoolTradeList } from "../src/backtest/report.js";
import type { PoolBacktestConfig, StrategyType } from "../src/backtest/types.js";

const args = process.argv.slice(2);
function arg(key: string) { const i = args.indexOf(`--${key}`); return i >= 0 ? args[i + 1] : undefined; }
function flag(key: string) { return args.includes(`--${key}`); }

const theme = arg("theme") ?? "半导体";
const strategy = (arg("strategy") ?? "always_buy") as StrategyType;
const maxPositions = Number(arg("max-positions") ?? "20");
const start = arg("start") ?? "20240101";
const end = arg("end") ?? "20260705";
const initialCapital = Number(arg("capital") ?? "100000");
const fullPosition = flag("no-full-position") ? false : true;
const rebalanceFrequency = Number(arg("rebalance-freq") ?? "1");

const fmtStart = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`;
const fmtEnd = `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`;

const dataDir = (process.env.USERPROFILE ?? process.env.HOME ?? ".") + "/.trading-agent/data";
const store = createDataStore(dataDir);
await store.init();
setDataStore(store);

console.log(`Loading theme "${theme}" ${fmtStart} ~ ${fmtEnd}...`);
const dynamicItems = await store.getThemePoolItemsInRange(theme, fmtStart, fmtEnd);
console.log(`  ${dynamicItems.size} snapshot dates loaded`);

if (dynamicItems.size === 0) {
	console.error(`No data for theme "${theme}". Available: 人形机器人/半导体/新能源/消费电子/AI基础设施/黄金/有色金属`);
	store.close();
	process.exit(1);
}

const config: PoolBacktestConfig = {
	strategy,
	start,
	end,
	period: "daily",
	adjust: "bfq",
	initialCapital,
	positionSize: 1.0,
	fullPosition,
	fullPositionMode: "equal_weight",
	maxPositionWeight: 0.1,
	rebalanceFrequency,
	slippage: 0.001,
	commission: 0.0003,
	maxPositions,
	skipNoVolume: true,
};

console.log(`Running backtest: ${theme} / ${strategy} / positions≤${maxPositions}...`);
const t0 = Date.now();
const result = await runPoolBacktest([], config, dynamicItems);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(formatPoolBacktestResult(result));
console.log(`\nElapsed: ${elapsed}s`);
console.log(`\nTrade list (first 20):`);
console.log(formatPoolTradeList(result.trades.slice(0, 20)));

store.close();
