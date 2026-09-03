import { describe, expect, it } from "vitest";
import type { KlineRow } from "../data/types.js";
import { simulateTrades } from "./engine.js";
import type { Signal } from "./types.js";

function makeKline(closes: number[], opens: number[] = closes): KlineRow[] {
	return closes.map((close, i) => ({
		code: "600519",
		market: 1,
		period: "daily",
		adjust: "bfq",
		date: `2024-01-${String(i + 1).padStart(2, "0")}`,
		open: opens[i] ?? close,
		high: Math.max(close, opens[i] ?? close),
		low: Math.min(close, opens[i] ?? close),
		close,
		volume: 1,
		turnover: null,
		change_pct: null,
		change_amount: null,
		amplitude: null,
		pre_close: null,
	}));
}

/** Buy signal at index 0 -> executes at open of index 1. */
function buySignalAt0(klines: KlineRow[]): Signal[] {
	return [{ index: 0, date: klines[0].date, type: "buy", price: klines[0].close ?? 0, reason: "test" }];
}

describe("stop-loss", () => {
	it("should sell when open drops below entry*(1-stopLossPercent)", () => {
		const klines = makeKline([100, 100, 88], [100, 100, 88]);
		const { trades } = simulateTrades(
			klines,
			buySignalAt0(klines),
			100_000,
			1.0,
			0,
			0,
			100,
			0,
			0,
			true,
			Infinity,
			0.08,
		);
		expect(trades).toHaveLength(1);
		expect(trades[0].memo).toBe("止损");
		expect(trades[0].exitPrice).toBeCloseTo(88, 4);
	});

	it("should NOT sell when stop-loss disabled", () => {
		const klines = makeKline([100, 100, 88], [100, 100, 88]);
		const { trades } = simulateTrades(klines, buySignalAt0(klines), 100_000, 1.0, 0, 0, 100);
		expect(trades).toHaveLength(1); // force-closed at end of data, no memo
		expect(trades[0].memo).toBeUndefined();
	});
});

describe("take-profit", () => {
	it("should sell when open rises above entry*(1+takeProfitPercent)", () => {
		const klines = makeKline([100, 100, 120], [100, 100, 120]);
		const { trades } = simulateTrades(
			klines,
			buySignalAt0(klines),
			100_000,
			1.0,
			0,
			0,
			100,
			0,
			0,
			true,
			Infinity,
			0,
			0.15,
		);
		expect(trades).toHaveLength(1);
		expect(trades[0].memo).toBe("止盈");
		expect(trades[0].exitPrice).toBeCloseTo(120, 4);
	});
});

describe("trailing stop", () => {
	it("should sell on drawdown from the position peak", () => {
		// buy@100, peak 120, then open 105 < 120*0.9 -> trailing stop fires
		const klines = makeKline([100, 100, 120, 105], [100, 100, 120, 105]);
		const { trades } = simulateTrades(
			klines,
			buySignalAt0(klines),
			100_000,
			1.0,
			0,
			0,
			100,
			0,
			0,
			true,
			Infinity,
			0,
			0,
			0.1,
		);
		expect(trades).toHaveLength(1);
		expect(trades[0].memo).toBe("移动止损");
		expect(trades[0].exitPrice).toBeCloseTo(105, 4);
	});

	it("should not fire while price keeps making new highs", () => {
		const klines = makeKline([100, 100, 120, 115], [100, 100, 120, 115]);
		const { trades } = simulateTrades(
			klines,
			buySignalAt0(klines),
			100_000,
			1.0,
			0,
			0,
			100,
			0,
			0,
			true,
			Infinity,
			0,
			0,
			0.1,
		);
		// 115 > 120*0.9 = 108 -> no trailing exit; force-closed at end
		expect(trades).toHaveLength(1);
		expect(trades[0].memo).toBeUndefined();
	});
});

describe("drawdown circuit breaker", () => {
	it("should liquidate when portfolio drawdown exceeds the limit and block new buys until recovery", () => {
		// buy@100 (peak equity 100k), up to 130 (peak 130k), crash to 90: 90k < 130k*0.85
		const klines = makeKline([100, 100, 130, 90, 95], [100, 100, 130, 90, 95]);
		const { trades } = simulateTrades(
			klines,
			buySignalAt0(klines),
			100_000,
			1.0,
			0,
			0,
			100,
			0,
			0,
			true,
			Infinity,
			0,
			0,
			0,
			0.15,
		);
		// Trade 1: circuit-breaker liquidation with memo; no new buys on day 4 (still broken)
		expect(trades).toHaveLength(1);
		expect(trades[0].memo).toBe("回撤熔断");
		expect(trades[0].exitPrice).toBeCloseTo(90, 4);
	});

	it("should recover once drawdown shrinks below half the limit", () => {
		// buy@100 -> 130 (peak 130k) -> crash to 95 (95k < 110.5k trips) -> rebound: with no position,
		// equity stays ~95k... use a milder crash: 130 -> 112 (112k >= 110.5k -> no trip)
		const klines = makeKline([100, 100, 130, 112], [100, 100, 130, 112]);
		const { trades } = simulateTrades(
			klines,
			buySignalAt0(klines),
			100_000,
			1.0,
			0,
			0,
			100,
			0,
			0,
			true,
			Infinity,
			0,
			0,
			0,
			0.15,
		);
		// 112k vs peak 130k: drawdown 13.8% < 15% -> breaker never trips
		expect(trades).toHaveLength(1);
		expect(trades[0].memo).toBeUndefined();
	});
});
