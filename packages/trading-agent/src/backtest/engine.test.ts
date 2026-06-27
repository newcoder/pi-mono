import { describe, expect, it } from "vitest";
import type { KlineRow } from "../data/types.js";
import { generateAllSignals } from "./engine.js";
import type { BacktestConfig } from "./types.js";

function makeKlines(closes: number[]): KlineRow[] {
	return closes.map((close, i) => ({
		code: "600519",
		market: 1,
		period: "daily",
		adjust: "bfq",
		date: `2024-01-${String(i + 1).padStart(2, "0")}`,
		open: close,
		high: close,
		low: close,
		close,
		volume: null,
		turnover: null,
		change_pct: null,
		change_amount: null,
		amplitude: null,
		pre_close: null,
	}));
}

function makeKlinesOHLC(data: Array<{ open: number; high: number; low: number; close: number }>): KlineRow[] {
	return data.map((d, i) => ({
		code: "600519",
		market: 1,
		period: "daily",
		adjust: "bfq",
		date: `2024-01-${String(i + 1).padStart(2, "0")}`,
		open: d.open,
		high: d.high,
		low: d.low,
		close: d.close,
		volume: null,
		turnover: null,
		change_pct: null,
		change_amount: null,
		amplitude: null,
		pre_close: null,
	}));
}

describe("generateAllSignals", () => {
	it("should merge buy signals from multiple buy-only strategies", () => {
		// hammer needs prior bearish candle with long lower shadow
		const hammerKlines = makeKlinesOHLC([
			{ open: 100, high: 100, low: 92, close: 96 }, // prior bearish
			{ open: 96, high: 97, low: 90, close: 97 }, // hammer: small body, long lower shadow
		]);
		const config: Pick<BacktestConfig, "buyStrategies" | "sellStrategies"> = {
			buyStrategies: [
				{ strategy: "hammer", params: { minBodyRatio: 0.005 } },
				{ strategy: "breakout", params: { minChange: 2, volRatio: 1 } },
			],
		};
		const signals = generateAllSignals(hammerKlines, config);
		const buys = signals.filter((s) => s.type === "buy");
		expect(buys.length).toBeGreaterThanOrEqual(1);
		expect(buys.some((s) => s.reason.includes("Hammer"))).toBe(true);
		expect(signals.some((s) => s.type === "sell")).toBe(false);
	});

	it("should merge sell signals from multiple sell-only strategies", () => {
		const klines = makeKlinesOHLC([
			{ open: 100, high: 102, low: 99, close: 101 }, // prior bullish
			{ open: 101.5, high: 109, low: 101.5, close: 104 }, // shooting star: small body, long upper shadow
		]);
		const config: Pick<BacktestConfig, "buyStrategies" | "sellStrategies"> = {
			sellStrategies: [
				{ strategy: "shooting_star", params: { minBodyRatio: 0.005 } },
				{ strategy: "bearish_engulf" },
			],
		};
		const signals = generateAllSignals(klines, config);
		const sells = signals.filter((s) => s.type === "sell");
		expect(sells.length).toBeGreaterThanOrEqual(1);
		expect(sells.some((s) => s.reason.includes("ShootingStar"))).toBe(true);
		expect(signals.some((s) => s.type === "buy")).toBe(false);
	});

	it("should take only buy side from auto two-way indicators in buy list", () => {
		// ma_cross with fast=1 slow=2: dip then rise -> golden cross at index 2
		const klines = makeKlines([100, 99, 101, 102, 103]);
		const config: Pick<BacktestConfig, "buyStrategies"> = {
			buyStrategies: [{ strategy: "ma_cross", params: { fast: 1, slow: 2 } }],
		};
		const signals = generateAllSignals(klines, config);
		expect(signals.every((s) => s.type === "buy")).toBe(true);
		expect(signals.some((s) => s.reason.includes("金叉"))).toBe(true);
	});

	it("should take only sell side from auto two-way indicators in sell list", () => {
		// ma_cross with fast=1 slow=2: close falls -> death cross at index 4
		const klines = makeKlines([100, 101, 102, 101, 100]);
		const config: Pick<BacktestConfig, "sellStrategies"> = {
			sellStrategies: [{ strategy: "ma_cross", params: { fast: 1, slow: 2 } }],
		};
		const signals = generateAllSignals(klines, config);
		expect(signals.every((s) => s.type === "sell")).toBe(true);
		expect(signals.some((s) => s.reason.includes("死叉"))).toBe(true);
	});

	it("should merge legacy strategy with new-style strategy lists", () => {
		const klines = makeKlinesOHLC([
			{ open: 100, high: 100, low: 96, close: 97 }, // bearish
			{ open: 96.5, high: 101, low: 96, close: 100.5 }, // bullish engulf (legacy buy)
			{ open: 101.5, high: 109, low: 101.5, close: 104 }, // shooting star (new-style sell)
		]);
		const config: Pick<BacktestConfig, "strategy" | "buyStrategies" | "sellStrategies"> = {
			strategy: "bullish_engulf",
			sellStrategies: [{ strategy: "shooting_star", params: { minBodyRatio: 0.005 } }],
		};
		const signals = generateAllSignals(klines, config);
		// legacy strategy contributes both buy and sell unless new-style lists override sells
		expect(signals.some((s) => s.type === "buy")).toBe(true);
		expect(signals.some((s) => s.type === "sell")).toBe(true);
	});
});
