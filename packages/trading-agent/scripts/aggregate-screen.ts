#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Row {
	pool: string;
	poolSize: number;
	strategy: string;
	rankBy: string;
	totalReturn: number;
	annualizedReturn: number;
	maxDrawdown: number;
	winRate: number;
	profitFactor: number;
	avgHoldingDays: number;
	trades: number;
	elapsedSec: number;
}

const files = [
	"tmp/screen-hs300.csv",
	"tmp/screen-zz500.csv",
	"tmp/screen-zz1000.csv",
	"tmp/screen-zz2000.csv",
];

const rows: Row[] = [];
for (const f of files) {
	const text = readFileSync(f, "utf-8").trim();
	const lines = text.split("\n").slice(1);
	for (const line of lines) {
		const [pool, poolSize, strategy, rankBy, totalReturn, annualizedReturn, maxDrawdown, winRate, profitFactor, avgHoldingDays, trades, elapsedSec] = line.split(",");
		rows.push({
			pool,
			poolSize: Number.parseInt(poolSize, 10),
			strategy,
			rankBy,
			totalReturn: Number.parseFloat(totalReturn),
			annualizedReturn: Number.parseFloat(annualizedReturn),
			maxDrawdown: Number.parseFloat(maxDrawdown),
			winRate: Number.parseFloat(winRate),
			profitFactor: Number.parseFloat(profitFactor),
			avgHoldingDays: Number.parseFloat(avgHoldingDays),
			trades: Number.parseInt(trades, 10),
			elapsedSec: Number.parseFloat(elapsedSec),
		});
	}
}

function printTable(title: string, data: Row[], cols: Array<keyof Row>) {
	console.log(`\n=== ${title} ===`);
	console.table(data.map((r) => Object.fromEntries(cols.map((c) => [c, typeof r[c] === "number" ? Number((r[c] as number).toFixed(2)) : r[c]]))));
}

// Top 20 overall by total return
const topTotal = [...rows].sort((a, b) => b.totalReturn - a.totalReturn).slice(0, 20);
printTable("Top 20 overall by total return", topTotal, ["pool", "strategy", "rankBy", "totalReturn", "annualizedReturn", "maxDrawdown", "winRate", "profitFactor", "avgHoldingDays"]);

// Top per pool
const pools = Array.from(new Set(rows.map((r) => r.pool)));
for (const pool of pools) {
	const top = rows.filter((r) => r.pool === pool).sort((a, b) => b.totalReturn - a.totalReturn).slice(0, 5);
	printTable(`Top 5 in ${pool}`, top, ["strategy", "rankBy", "totalReturn", "annualizedReturn", "maxDrawdown", "winRate", "profitFactor", "avgHoldingDays"]);
}

// Best rank_by per strategy (highest average total return across pools)
const strategies = Array.from(new Set(rows.map((r) => r.strategy))).sort();
console.log("\n=== Best rank_by per strategy (by average total return across pools) ===");
const strategyRankSummary: Array<{ strategy: string; rankBy: string; avgReturn: number; bestPool: string; bestReturn: number }> = [];
for (const strategy of strategies) {
	const byRank: Record<string, { returns: number[]; best: Row | null }> = {};
	for (const r of rows.filter((r) => r.strategy === strategy)) {
		if (!byRank[r.rankBy]) byRank[r.rankBy] = { returns: [], best: null };
		byRank[r.rankBy].returns.push(r.totalReturn);
		if (!byRank[r.rankBy].best || r.totalReturn > byRank[r.rankBy].best!.totalReturn) {
			byRank[r.rankBy].best = r;
		}
	}
	const bestRank = Object.entries(byRank).sort((a, b) => {
		const avgA = a[1].returns.reduce((s, v) => s + v, 0) / a[1].returns.length;
		const avgB = b[1].returns.reduce((s, v) => s + v, 0) / b[1].returns.length;
		return avgB - avgA;
	})[0];
	if (bestRank && bestRank[1].best) {
		strategyRankSummary.push({
			strategy,
			rankBy: bestRank[0],
			avgReturn: bestRank[1].returns.reduce((s, v) => s + v, 0) / bestRank[1].returns.length,
			bestPool: bestRank[1].best.pool,
			bestReturn: bestRank[1].best.totalReturn,
		});
	}
}
console.table(strategyRankSummary.sort((a, b) => b.avgReturn - a.avgReturn));

// Risk-adjusted top 20 (totalReturn / maxDrawdown, require totalReturn > 0)
const riskAdjusted = rows
	.filter((r) => r.totalReturn > 0 && r.maxDrawdown > 0)
	.map((r) => ({ ...r, calmar: r.totalReturn / r.maxDrawdown }))
	.sort((a, b) => b.calmar - a.calmar)
	.slice(0, 20);
printTable("Top 20 risk-adjusted (totalReturn / maxDrawdown)", riskAdjusted, ["pool", "strategy", "rankBy", "totalReturn", "maxDrawdown", "calmar"]);
