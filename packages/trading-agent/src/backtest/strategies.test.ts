import { describe, expect, it } from "vitest";
import type { KlineRow } from "../data/types.js";
import { generateSignals } from "./strategies.js";

function makeKlines(closes: (number | null)[]): KlineRow[] {
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

function makeKlinesWithVolume(data: Array<{ close: number; volume: number; high: number; low: number }>): KlineRow[] {
	return data.map((d, i) => ({
		code: "600519",
		market: 1,
		period: "daily",
		adjust: "bfq",
		date: `2024-01-${String(i + 1).padStart(2, "0")}`,
		open: d.close,
		high: d.high,
		low: d.low,
		close: d.close,
		volume: d.volume,
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

describe("generateSignals", () => {
	describe("rsi_reversal", () => {
		it("should buy when RSI recovers above oversold and sell when RSI falls below overbought", () => {
			// With period=1: RSI=0 on a down day, RSI=100 on an up day.
			const klines = makeKlines([40, 20, 35, 80, 60]);
			const signals = generateSignals(klines, "rsi_reversal", { period: 1, oversold: 30, overbought: 70 });

			const buys = signals.filter((s) => s.type === "buy");
			const sells = signals.filter((s) => s.type === "sell");

			expect(buys).toHaveLength(1);
			expect(buys[0].index).toBe(2); // RSI 0 -> 100 crosses above 30
			expect(sells).toHaveLength(1);
			expect(sells[0].index).toBe(4); // RSI 100 -> 0 crosses below 70
		});

		it("should not buy when RSI drops deeper into oversold", () => {
			const klines = makeKlines([40, 35, 20]);
			const signals = generateSignals(klines, "rsi_reversal", { period: 1, oversold: 30, overbought: 70 });

			expect(signals.some((s) => s.type === "buy")).toBe(false);
		});
	});

	describe("shooting_star", () => {
		it("should generate a sell signal for a shooting star after an uptrend", () => {
			// prior bullish, then gap-up shooting star (small body near low, long upper shadow)
			const klines = makeKlinesOHLC([
				{ open: 100, high: 102, low: 99, close: 101 },
				{ open: 101.5, high: 108, low: 101.5, close: 103 },
			]);
			const signals = generateSignals(klines, "shooting_star", { minBodyRatio: 0.01 });
			expect(signals.filter((s) => s.type === "sell")).toHaveLength(1);
			expect(signals[0].reason).toContain("ShootingStar");
		});

		it("should not generate a sell signal without a prior uptrend", () => {
			const klines = makeKlinesOHLC([
				{ open: 100, high: 101, low: 96, close: 97 },
				{ open: 97, high: 103, low: 96.5, close: 97.5 },
			]);
			const signals = generateSignals(klines, "shooting_star", { minBodyRatio: 0.01 });
			expect(signals.some((s) => s.type === "sell")).toBe(false);
		});
	});

	describe("bearish_engulf", () => {
		it("should sell when a bearish candle engulfs the prior bullish candle", () => {
			const klines = makeKlinesOHLC([
				{ open: 100, high: 102, low: 99, close: 101 },
				{ open: 102, high: 103, low: 98, close: 99 },
			]);
			const signals = generateSignals(klines, "bearish_engulf");
			expect(signals.filter((s) => s.type === "sell")).toHaveLength(1);
			expect(signals[0].reason).toContain("BearishEngulf");
		});
	});

	describe("evening_star", () => {
		it("should sell on a three-candle evening star reversal", () => {
			const klines = makeKlinesOHLC([
				{ open: 99, high: 101, low: 98, close: 101 }, // bullish
				{ open: 102, high: 103, low: 101.5, close: 102.5 }, // small star gap up
				{ open: 102, high: 102, low: 97, close: 98 }, // bearish close below midpoint
			]);
			const signals = generateSignals(klines, "evening_star", { minBodyRatio: 0.01 });
			expect(signals.filter((s) => s.type === "sell")).toHaveLength(1);
			expect(signals[0].reason).toContain("EveningStar");
		});
	});

	describe("three_crows", () => {
		it("should sell on three consecutive lower bearish candles", () => {
			const klines = makeKlinesOHLC([
				{ open: 102, high: 103, low: 100, close: 101 },
				{ open: 101, high: 102, low: 99, close: 100 },
				{ open: 100, high: 101, low: 98, close: 99 },
				{ open: 99, high: 100, low: 97, close: 98 },
			]);
			const signals = generateSignals(klines, "three_crows");
			expect(signals.filter((s) => s.type === "sell")).toHaveLength(1);
			expect(signals[0].reason).toContain("ThreeCrows");
		});
	});

	describe("rsi_overbought_sell", () => {
		it("should sell when RSI crosses below the overbought level", () => {
			// period=1: up day -> RSI=100, next down day -> RSI=0
			const klines = makeKlines([80, 90, 85]);
			const signals = generateSignals(klines, "rsi_overbought_sell", { period: 1, overbought: 70 });
			expect(signals.filter((s) => s.type === "sell")).toHaveLength(1);
			expect(signals[0].index).toBe(2);
		});
	});

	describe("volume_contraction", () => {
		it("should buy after price drops on shrinking volume and declining volatility", () => {
			// 20 days prior: volatile, high volume, price around 100
			const prior = Array.from({ length: 20 }, (_, i) => ({
				close: 100 + (i % 2 === 0 ? 2 : -2),
				volume: 1_000_000,
				high: 104,
				low: 96,
			}));
			// 5 days contraction: price drifts down, volume collapses, range shrinks
			const contraction = [
				{ close: 99, volume: 400_000, high: 101, low: 97 },
				{ close: 98, volume: 350_000, high: 100, low: 97 },
				{ close: 96, volume: 300_000, high: 98, low: 96 },
				{ close: 95, volume: 280_000, high: 97, low: 95 },
				{ close: 93, volume: 250_000, high: 95, low: 93 },
			];
			const klines = makeKlinesWithVolume([...prior, ...contraction]);
			const signals = generateSignals(klines, "volume_contraction", {
				lookbackDays: 20,
				contractionDays: 5,
				priceDropPct: 5,
				volumeRatioMax: 0.7,
				volatilityRatioMax: 0.6,
			});

			const buys = signals.filter((s) => s.type === "buy");
			expect(buys).toHaveLength(1);
			expect(buys[0].index).toBe(klines.length - 1);
			expect(buys[0].reason).toContain("VolumeContraction");
		});

		it("should not buy when volume does not contract", () => {
			const prior = Array.from({ length: 20 }, () => ({
				close: 100,
				volume: 1_000_000,
				high: 104,
				low: 96,
			}));
			const contraction = Array.from({ length: 5 }, (_, i) => ({
				close: 93 - i,
				volume: 1_000_000, // volume stays high
				high: 95,
				low: 92,
			}));
			const klines = makeKlinesWithVolume([...prior, ...contraction]);
			const signals = generateSignals(klines, "volume_contraction", {
				lookbackDays: 20,
				contractionDays: 5,
				priceDropPct: 5,
				volumeRatioMax: 0.7,
				volatilityRatioMax: 0.6,
			});

			expect(signals.some((s) => s.type === "buy")).toBe(false);
		});
	});
});
