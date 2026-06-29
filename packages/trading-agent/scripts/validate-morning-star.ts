#!/usr/bin/env node
/**
 * 快速验证 morning_star 信号的有效性 — 计算截面 Rank IC
 *
 * 对每个交易日，计算"是否出现晨星信号"与"未来 N 日收益"的截面秩相关系数，
 * 然后汇总均值、标准差、t 统计量，快速判断信号预测能力。
 *
 * 用法:
 *   npx tsx scripts/validate-morning-star.ts
 */

import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";
import { generateSignals } from "../src/backtest/strategies.js";
import type { KlineRow } from "../src/data/types.js";

// ─── Config ─────────────────────────────────────────────────────

const FORWARD_PERIODS = [1, 3, 5, 10, 20]; // forward return horizons (trading days)
const POOLS = [
	{ name: "自选53", lookup: 53 },
	{ name: "沪深300", lookup: "沪深300" },
	{ name: "中证500", lookup: "中证500" },
	{ name: "中证1000", lookup: "中证1000" },
];

const THREE_YEARS_AGO = (() => {
	const d = new Date();
	d.setFullYear(d.getFullYear() - 3);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

const TODAY = new Date().toISOString().slice(0, 10);

// ─── Helpers ────────────────────────────────────────────────────

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

/** Spearman rank correlation between two arrays (same length) */
function spearmanRankIC(a: number[], b: number[]): number {
	const n = a.length;
	if (n < 5) return Number.NaN;

	// Rank a
	const rankA = rankArray(a);
	const rankB = rankArray(b);

	// Pearson on ranks
	const meanRa = rankA.reduce((s, v) => s + v, 0) / n;
	const meanRb = rankB.reduce((s, v) => s + v, 0) / n;

	let num = 0;
	let denA = 0;
	let denB = 0;
	for (let i = 0; i < n; i++) {
		const da = rankA[i] - meanRa;
		const db = rankB[i] - meanRb;
		num += da * db;
		denA += da * da;
		denB += db * db;
	}
	const den = Math.sqrt(denA * denB);
	return den === 0 ? 0 : num / den;
}

/** Assign ranks (1..N, average for ties) to an array */
function rankArray(arr: number[]): number[] {
	const indexed = arr.map((v, i) => ({ v, i }));
	indexed.sort((a, b) => a.v - b.v);
	const ranks = new Array<number>(arr.length);
	for (let i = 0; i < indexed.length; ) {
		let j = i;
		while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
		const avgRank = (i + j - 1) / 2 + 1; // average rank for ties
		for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
		i = j;
	}
	return ranks;
}

/** Forward return: (close[dateIdx + forward] / close[dateIdx] - 1) * 100 */
function forwardReturn(klines: KlineRow[], dateIdx: number, forward: number): number | null {
	const todayClose = klines[dateIdx]?.close;
	const futureIdx = dateIdx + forward;
	if (futureIdx >= klines.length) return null;
	const futureClose = klines[futureIdx]?.close;
	if (todayClose == null || futureClose == null || todayClose <= 0) return null;
	return ((futureClose / todayClose) - 1) * 100;
}

// ─── Main ───────────────────────────────────────────────────────

interface IcStats {
	mean: number;
	std: number;
	tStat: number;
	positiveRatio: number;
	count: number;
}

async function computeMorningStarIC(
	poolName: string,
	stocks: Array<{ code: string; market: number; name?: string }>,
	store: ReturnType<typeof createDataStore>,
): Promise<Record<string, IcStats>> {
	console.log(`\n${poolName}: 加载 ${stocks.length} 只股票的 K 线...`);

	// 1. Load all klines and compute forward returns
	type StockData = { code: string; klines: KlineRow[]; signals: Set<number> };
	const stockDataList: StockData[] = [];

	const klineGroups = await store.getKlinesForCodes(stocks, "daily", "bfq", THREE_YEARS_AGO, TODAY);

	for (const stock of stocks) {
		const key = `${stock.code}_${stock.market}`;
		const klines = klineGroups.get(key) ?? [];
		if (klines.length < 30) continue;

		// Generate morning_star signals
		const rawSignals = generateSignals(klines, "morning_star", {});
		const signalIndices = new Set(rawSignals.map((s) => s.index));

		stockDataList.push({ code: stock.code, klines, signals: signalIndices });
	}

	console.log(`  有效股票: ${stockDataList.length}, 信号总数: ${stockDataList.reduce((s, d) => s + d.signals.size, 0)}`);

	// 2. Build unified calendar
	const allDates = [...new Set(stockDataList.flatMap((s) => s.klines.map((k) => k.date)))].sort();
	console.log(`  交易日范围: ${allDates[0]} ~ ${allDates[allDates.length - 1]} (${allDates.length} 天)`);

	// 3. For each forward period, compute daily cross-sectional IC
	const results: Record<string, IcStats> = {};

	for (const forward of FORWARD_PERIODS) {
		const dailyICs: number[] = [];

		for (let dateIdx = 0; dateIdx < allDates.length - forward; dateIdx++) {
			const date = allDates[dateIdx];
			const signalValues: number[] = [];
			const forwardReturns: number[] = [];

			for (const sd of stockDataList) {
				const kIdx = sd.klines.findIndex((k) => k.date === date);
				if (kIdx < 0) continue;

				const fwdRet = forwardReturn(sd.klines, kIdx, forward);
				if (fwdRet == null) continue;

				signalValues.push(sd.signals.has(kIdx) ? 1 : 0);
				forwardReturns.push(fwdRet);
			}

			if (signalValues.length < 10) continue; // need minimum cross-section
			// Skip days where all signals are 0 (no variation)
			if (new Set(signalValues).size < 2) continue;

			const ic = spearmanRankIC(signalValues, forwardReturns);
			if (!Number.isNaN(ic)) dailyICs.push(ic);
		}

		const n = dailyICs.length;
		if (n === 0) {
			results[`forward${forward}d`] = { mean: 0, std: 0, tStat: 0, positiveRatio: 0, count: 0 };
			continue;
		}

		const mean = dailyICs.reduce((s, v) => s + v, 0) / n;
		const variance = dailyICs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
		const std = Math.sqrt(variance);
		const tStat = std > 0 ? mean / (std / Math.sqrt(n)) : 0;
		const positiveRatio = (dailyICs.filter((v) => v > 0).length / n) * 100;

		results[`forward${forward}d`] = { mean, std, tStat, positiveRatio, count: n };
	}

	return results;
}

// ─── Run ────────────────────────────────────────────────────────

async function main() {
	console.log("═".repeat(60));
	console.log("  morning_star 信号有效性验证 — 截面 Rank IC");
	console.log("═".repeat(60));

	const dataDir = getDataDir();
	console.log(`数据目录: ${dataDir}`);
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataStore(store);

	const allResults: Record<string, Record<string, IcStats>> = {};

	for (const poolDef of POOLS) {
		let pool;
		if (typeof poolDef.lookup === "number") {
			pool = await store.getStockPoolById(poolDef.lookup);
		} else {
			pool = await store.getStockPoolByName(poolDef.lookup);
		}
		if (!pool) {
			console.log(`${poolDef.name}: 池未找到，跳过`);
			continue;
		}
		const items = await store.getStockPoolItems(pool.id);
		const stocks = items.map((item) => ({
			code: item.code,
			market: item.market,
			name: item.name ?? undefined,
		}));

		allResults[poolDef.name] = await computeMorningStarIC(poolDef.name, stocks, store);
	}

	// ─── Summary table ───────────────────────────────────────────

	console.log(`\n${"═".repeat(90)}`);
	console.log("  汇总: morning_star 截面 Rank IC");
	console.log(`${"═".repeat(90)}`);

	// Header
	const header =
		`${"股池".padEnd(10)} ${"周期".padEnd(12)} ${"IC均值".padStart(8)} ${"IC标准差".padStart(8)} ${"t值".padStart(8)} ${"IC>0占比".padStart(10)} ${"观测数".padStart(8)}`;
	console.log(header);
	console.log("─".repeat(90));

	for (const poolName of Object.keys(allResults)) {
		for (const forward of FORWARD_PERIODS) {
			const key = `forward${forward}d`;
			const s = allResults[poolName][key];
			if (!s || s.count === 0) continue;
			const line =
				`${poolName.padEnd(10)} ${`${forward}日`.padEnd(12)} ` +
				`${(s.mean * 100).toFixed(2).padStart(7)}% ${(s.std * 100).toFixed(2).padStart(7)}% ` +
				`${s.tStat.toFixed(2).padStart(8)} ${`${s.positiveRatio.toFixed(0)}%`.padStart(10)} ` +
				`${String(s.count).padStart(8)}`;
			console.log(line);
		}
		console.log("─".repeat(90));
	}

	// Assessment
	console.log("\n快速解读:");
	console.log("  |IC| < 0.02   → 信号无效");
	console.log("  |IC| 0.02-0.05 → 弱预测力");
	console.log("  |IC| 0.05-0.10 → 中等预测力");
	console.log("  |IC| > 0.10   → 强预测力");
	console.log("  IC>0占比 > 55% → 方向稳定");
	console.log("  t值 > 2       → 统计显著 (p<0.05)");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
