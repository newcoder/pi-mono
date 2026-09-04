#!/usr/bin/env node
/** Quick comparison: equal_weight vs linear for supertrend + ma_alignment */
import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig } from "../src/backtest/types.js";
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

const POOLS = ["自选53", "沪深300", "中证500", "中证1000"];

const THREE_YEARS_AGO = (() => {
	const d = new Date(); d.setFullYear(d.getFullYear() - 3);
	return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
})();
const TODAY = (() => {
	const d = new Date();
	return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
})();

const BASE_CONFIG: Partial<PoolBacktestConfig> = {
	strategy: "supertrend",
	rankBy: "ma_alignment",
	initialCapital: 100_000_000,
	maxPositions: 20,
	maxPositionWeight: 0.1,
	fullPosition: true,
	slippage: 0.001,
	commission: 0.0003,
	taxRate: 0.0005,
	transferFee: 0.00002,
	skipNoVolume: true,
	period: "daily",
	adjust: "qfq",
	start: THREE_YEARS_AGO,
	end: TODAY,
};

async function main() {
	const dataDir = getDataDir();
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataStore(store);

	const results: Array<{ pool: string; mode: string; ret: number; sharpe: number; dd: number; trades: number; elapsed: number }> = [];

	for (const poolName of POOLS) {
		let pool;
		if (poolName === "自选53") pool = await store.getStockPoolById(53);
		else pool = await store.getStockPoolByName(poolName);
		if (!pool) { console.log(`${poolName}: pool not found`); continue; }
		const items = await store.getStockPoolItems(pool.id);
		const stocks = items.map((i: any) => ({ code: i.code, market: i.market, name: i.name ?? undefined }));

		for (const mode of ["equal_weight", "linear"] as const) {
			const config: PoolBacktestConfig = { ...BASE_CONFIG, fullPositionMode: mode };
			const result = await runPoolBacktest(stocks, config);
			results.push({
				pool: poolName,
				mode,
				ret: result.metrics.totalReturn,
				sharpe: result.metrics.sharpeRatio,
				dd: result.metrics.maxDrawdown,
				trades: result.metrics.totalTrades,
				elapsed: result.elapsedMs,
			});
			console.log(`${poolName.padEnd(8)} ${mode.padEnd(13)} 收益=${result.metrics.totalReturn.toFixed(1).padStart(7)}%  夏普=${result.metrics.sharpeRatio.toFixed(2).padStart(6)}  回撤=${result.metrics.maxDrawdown.toFixed(1).padStart(6)}%  交易=${result.metrics.totalTrades}  [${(result.elapsedMs/1000).toFixed(1)}s]`);
		}
	}

	// Comparison table
	console.log(`\n${"=".repeat(100)}`);
	console.log(`${"股池".padEnd(10)} ${"equal_weight".padEnd(30)} ${"linear".padEnd(30)} ${"差值"}`);
	console.log(`${"".padEnd(10)} ${"收益/夏普/回撤".padEnd(30)} ${"收益/夏普/回撤".padEnd(30)}`);
	console.log(`${"-".repeat(100)}`);
	for (const poolName of POOLS) {
		const eq = results.find((r) => r.pool === poolName && r.mode === "equal_weight");
		const li = results.find((r) => r.pool === poolName && r.mode === "linear");
		if (!eq || !li) continue;
		const dRet = li.ret - eq.ret;
		const dSharpe = li.sharpe - eq.sharpe;
		const dDD = li.dd - eq.dd;
		console.log(
			`${poolName.padEnd(10)} ` +
			`${`${eq.ret.toFixed(1)}% / ${eq.sharpe.toFixed(2)} / ${eq.dd.toFixed(1)}%`.padEnd(30)} ` +
			`${`${li.ret.toFixed(1)}% / ${li.sharpe.toFixed(2)} / ${li.dd.toFixed(1)}%`.padEnd(30)} ` +
			`Δ${dRet>0?'+':''}${dRet.toFixed(1)}% / ${dSharpe>0?'+':''}${dSharpe.toFixed(2)} / ${dDD>0?'+':''}${dDD.toFixed(1)}%`
		);
	}
}

main().catch((err) => { console.error(err); process.exit(1); });
