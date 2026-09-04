#!/usr/bin/env node
import { fetchIndexCurve } from "../src/backtest/benchmark.js";

const symbol = process.argv[2] || "sh000300";
const label = process.argv[3] || symbol;
const raw = fetchIndexCurve(symbol, "2023-06-26", "2026-06-26");
if (raw.length === 0) {
	console.log("no data");
	process.exit(1);
}
const start = raw[0].close;
const end = raw[raw.length - 1].close;
const ret = ((end - start) / start) * 100;
let peak = start;
let maxDD = 0;
for (const p of raw) {
	if (p.close > peak) peak = p.close;
	const dd = ((peak - p.close) / peak) * 100;
	if (dd > maxDD) maxDD = dd;
}
console.log(`${label} start: ${raw[0].date} ${start.toFixed(2)}`);
console.log(`${label} end:   ${raw[raw.length - 1].date} ${end.toFixed(2)}`);
console.log(`${label} total return: ${ret.toFixed(2)}%`);
console.log(`${label} max drawdown: ${maxDD.toFixed(2)}%`);
console.log(`points: ${raw.length}`);
