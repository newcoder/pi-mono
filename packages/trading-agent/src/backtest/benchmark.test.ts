import { describe, expect, it } from "vitest";
import type { KlineRow } from "../data/types.js";
import { computeCurveStats, computeEqualWeightBenchmark } from "./benchmark.js";
import { simulateTrades } from "./engine.js";
import type { Signal } from "./types.js";

function makeKline(
	code: string,
	date: string,
	close: number,
	changePct: number | null,
	preClose: number | null,
): KlineRow {
	return {
		code,
		market: 1,
		period: "daily",
		adjust: "bfq",
		date,
		open: close,
		high: close,
		low: close,
		close,
		volume: 1,
		turnover: null,
		change_pct: changePct,
		change_amount: null,
		amplitude: null,
		pre_close: preClose,
	};
}

function makeKlineMap(rows: KlineRow[]): Array<{ code: string; map: Map<string, KlineRow> }> {
	return [
		{
			code: rows[0].code,
			map: new Map(rows.map((k) => [k.date, k])),
		},
	];
}

const DATES = ["2024-01-01", "2024-01-02", "2024-01-03"];

describe("computeEqualWeightBenchmark", () => {
	it("should compound the equal-weight average daily return", () => {
		const stockA = DATES.map((d, i) =>
			makeKline("A", d, [10, 11, 12.1][i]!, i === 0 ? 0 : 10, i === 0 ? null : [10, 11][i - 1]!),
		);
		const stockB = DATES.map((d, i) =>
			makeKline("B", d, [20, 18, 19.8][i]!, i === 0 ? 0 : -10, i === 0 ? null : [20, 18][i - 1]!),
		);
		const maps = [
			{ code: "A", map: new Map(stockA.map((k) => [k.date, k])) },
			{ code: "B", map: new Map(stockB.map((k) => [k.date, k])) },
		];

		const bench = computeEqualWeightBenchmark(maps, DATES, 100_000);
		// Day 2: (+10% + -10%) / 2 = 0%; Day 3: same. Equity stays 100_000.
		expect(bench.equityCurve).toHaveLength(3);
		expect(bench.equityCurve[0].equity).toBeCloseTo(100_000, 4);
		expect(bench.equityCurve[2].equity).toBeCloseTo(100_000, 4);
		expect(bench.totalReturn).toBeCloseTo(0, 4);
		expect(bench.maxDrawdown).toBe(0);
	});

	it("should fall back to close/pre_close when change_pct is null", () => {
		const rows = [
			makeKline("A", DATES[0]!, 10, null, null),
			makeKline("A", DATES[1]!, 11, null, 10),
			makeKline("A", DATES[2]!, 11, null, 11),
		];
		const bench = computeEqualWeightBenchmark(makeKlineMap(rows), DATES, 100_000);
		// Day 2: 11/10 - 1 = +10%; Day 3: 0%. Final equity = 110_000.
		expect(bench.equityCurve[2].equity).toBeCloseTo(110_000, 4);
		expect(bench.totalReturn).toBeCloseTo(10, 4);
	});

	it("should skip suspended stocks (no kline that day)", () => {
		const rows = [
			makeKline("A", DATES[0]!, 10, 0, null),
			makeKline("A", DATES[1]!, 10, 0, 10),
			makeKline("A", DATES[2]!, 10, 0, 10),
		];
		const bench = computeEqualWeightBenchmark(makeKlineMap(rows), DATES, 100_000);
		expect(bench.equityCurve[2].equity).toBeCloseTo(100_000, 4);
	});
});

describe("computeCurveStats", () => {
	it("should compute total return and max drawdown", () => {
		const curve = [
			{ date: "2024-01-01", equity: 100_000 },
			{ date: "2024-01-02", equity: 120_000 },
			{ date: "2024-01-03", equity: 90_000 },
		];
		const stats = computeCurveStats(curve, 100_000);
		expect(stats.totalReturn).toBeCloseTo(-10, 4);
		expect(stats.maxDrawdown).toBeCloseTo(25, 4); // 120k -> 90k
	});
});

describe("simulateTrades buy & hold benchmark", () => {
	it("should compound initialCapital by the stock's daily returns", () => {
		const closes = [100, 110, 121];
		const klines = closes.map((close, i) =>
			makeKline("600519", `2024-01-${String(i + 1).padStart(2, "0")}`, close, null, i === 0 ? null : closes[i - 1]!),
		);
		const signals: Signal[] = [];
		const { buyHoldCurve } = simulateTrades(klines, signals, 100_000, 1.0, 0, 0, 100);
		expect(buyHoldCurve).toHaveLength(3);
		expect(buyHoldCurve[0].equity).toBeCloseTo(100_000, 4);
		expect(buyHoldCurve[2].equity).toBeCloseTo(121_000, 4);
	});
});
