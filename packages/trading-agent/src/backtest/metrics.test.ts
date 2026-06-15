import { describe, expect, it } from "vitest";
import { computeMetrics } from "./metrics.js";

function makeCurve(days: number, finalEquity: number): { date: string; equity: number }[] {
	const initial = 100_000;
	const curve: { date: string; equity: number }[] = [{ date: "2024-01-01", equity: initial }];
	for (let i = 1; i < days; i++) {
		const equity = initial + ((finalEquity - initial) * i) / (days - 1);
		curve.push({ date: `2024-01-${String(i + 1).padStart(2, "0")}`, equity });
	}
	return curve;
}

describe("computeMetrics", () => {
	it("should not produce NaN annualized return when totalReturn is below -100%", () => {
		const initialCapital = 100_000;
		const equityCurve = [
			{ date: "2024-01-01", equity: initialCapital },
			{ date: "2024-01-02", equity: -50_000 },
		];
		const metrics = computeMetrics([], equityCurve, initialCapital);

		expect(Number.isNaN(metrics.annualizedReturn)).toBe(false);
		expect(metrics.annualizedReturn).toBe(-100);
	});

	it("should compute CAGR normally over one trading year", () => {
		const initialCapital = 100_000;
		const finalEquity = 121_000;
		const equityCurve = makeCurve(252, finalEquity);
		const metrics = computeMetrics([], equityCurve, initialCapital);

		expect(metrics.totalReturn).toBeCloseTo(21, 5);
		expect(metrics.annualizedReturn).toBeCloseTo(21, 5);
	});
});
