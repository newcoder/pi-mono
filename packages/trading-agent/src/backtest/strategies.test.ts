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
});
