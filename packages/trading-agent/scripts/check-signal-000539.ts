#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { createDataStore } from "../src/data/index.js";
import { generateSignals } from "../src/backtest/strategies.js";
import type { StrategyType } from "../src/backtest/types.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(homedir(), ".trading-agent", "data");

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const klines = await store.getKlines({
		code: "000539",
		market: 0,
		period: "daily",
		adjust: "bfq",
		start: "20230601",
		end: "20260626",
	});
	console.log("klines count:", klines.length);
	console.log("last 10 days:");
	for (const k of klines.slice(-10)) {
		console.log(
			`${k.date} o=${k.open} h=${k.high} l=${k.low} c=${k.close} vol=${k.volume} chg=${k.change_pct}`,
		);
	}

	const strategies: StrategyType[] = [
		"ma_cross",
		"macd_cross",
		"rsi_reversal",
		"bollinger_breakout",
		"supertrend",
		"hammer",
		"bullish_engulf",
		"morning_star",
		"three_soldiers",
		"tech_composite",
		"breakout",
		"volume_contraction",
	];
	console.log("\nsignals on 2026-06-26:");
	for (const s of strategies) {
		const signals = generateSignals(klines, s, {});
		const sig = signals.find((x) => x.date === "2026-06-26" && x.type === "buy");
		if (sig) {
			console.log(`${s}: BUY @ ${sig.price.toFixed(2)} — ${sig.reason}`);
		} else {
			const lastBuy = signals.filter((x) => x.type === "buy").pop();
			console.log(`${s}: no buy on 2026-06-26 (last buy: ${lastBuy?.date ?? "none"})`);
		}
	}
	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
