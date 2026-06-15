import { describe, expect, it } from "vitest";
import type { KlineRow } from "../data/types.js";
import { simulateTrades } from "./engine.js";

function makeKlines(prices: number[], options: { nullCloseAt?: number[] } = {}): KlineRow[] {
	return prices.map((price, i) => ({
		code: "600519",
		market: 1,
		period: "daily",
		adjust: "bfq",
		date: `2024-01-${String(i + 1).padStart(2, "0")}`,
		open: price,
		high: price,
		low: price,
		close: options.nullCloseAt?.includes(i) ? null : price,
		volume: null,
		turnover: null,
		change_pct: null,
		change_amount: null,
		amplitude: null,
		pre_close: i > 0 ? prices[i - 1] : null,
	}));
}

function makeSignal(index: number, type: "buy" | "sell", price: number) {
	return { index, date: `2024-01-${String(index + 1).padStart(2, "0")}`, type, price, reason: "test" };
}

describe("simulateTrades", () => {
	it("should enforce minLot when buying shares", () => {
		const klines = makeKlines([100, 100, 100]);
		const signals = [makeSignal(0, "buy", 100)];
		const { trades } = simulateTrades(klines, signals, 100_000, 1.0, 0, 0, 100);

		expect(trades).toHaveLength(1);
		expect(trades[0].shares % 100).toBe(0);
		expect(trades[0].shares).toBeGreaterThan(0);
	});

	it("should skip buy if rounded shares are below minLot", () => {
		const klines = makeKlines([5000, 5000, 5000]);
		const signals = [makeSignal(0, "buy", 5000)];
		// 100000 capital, positionSize=0.5, minLot=100, price=5000 -> raw 10 shares, but after rounding to 100 lot becomes 0
		const { trades } = simulateTrades(klines, signals, 100_000, 0.5, 0, 0, 100);

		expect(trades).toHaveLength(0);
	});

	it("should force-close open positions at end of simulation", () => {
		const klines = makeKlines([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
		const signals = [makeSignal(0, "buy", 100)];
		const { trades, equityCurve } = simulateTrades(klines, signals, 100_000, 1.0, 0, 0, 100);

		expect(trades).toHaveLength(1);
		expect(trades[0].daysHeld).toBe(8); // bought at execIdx=1, closed at last index 9
		expect(equityCurve[equityCurve.length - 1].equity).toBe(100_000);
	});

	it("should include buy-side commission in trade PnL", () => {
		const klines = makeKlines([100, 100, 110]);
		const signals = [makeSignal(0, "buy", 100), makeSignal(1, "sell", 110)];
		const { trades } = simulateTrades(klines, signals, 100_000, 0.5, 0, 0.01, 100);

		expect(trades).toHaveLength(1);
		const trade = trades[0];
		// 500 shares @ 100, commission 1%: cost basis = 500 * 100 * 1.01 = 50500
		// sell proceeds = 500 * 110 * 0.99 = 54450
		// pnl = 54450 - 50500 = 3950
		expect(trade.pnl).toBeCloseTo(3950, 2);
		expect(trade.pnlPct).toBeCloseTo((3950 / 50500) * 100, 2);
	});

	it("should use last known close instead of 0 for null close days", () => {
		const klines = makeKlines([100, 100, 100], { nullCloseAt: [1] });
		const signals = [makeSignal(0, "buy", 100)];
		const { equityCurve } = simulateTrades(klines, signals, 100_000, 1.0, 0, 0, 100);

		// Day 0: buy 1000 shares @ 100, equity = 0 cash + 1000*100 = 100000
		// Day 1: close is null, should fall back to lastClose=100, equity = 100000
		// Day 2: close=100, equity = 100000
		expect(equityCurve[1].equity).toBe(100_000);
	});
});
