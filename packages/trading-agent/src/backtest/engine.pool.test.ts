import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataStore, setDataStore } from "../data/index.js";
import type { KlineRow } from "../data/types.js";
import { runPoolBacktest } from "./engine.js";

function makeKlinesOHLC(
	code: string,
	market: number,
	data: Array<{ open: number; high: number; low: number; close: number }>,
	startDate = "2024-01-01",
): KlineRow[] {
	const base = new Date(startDate);
	return data.map((d, i) => {
		const dt = new Date(base);
		dt.setDate(dt.getDate() + i);
		const date = dt.toISOString().slice(0, 10);
		return {
			code,
			market,
			period: "daily",
			adjust: "bfq",
			date,
			open: d.open,
			high: d.high,
			low: d.low,
			close: d.close,
			volume: 1_000_000,
			turnover: 10_000_000,
			change_pct: i === 0 ? 0 : ((d.close - data[i - 1].close) / data[i - 1].close) * 100,
			change_amount: i === 0 ? 0 : d.close - data[i - 1].close,
			amplitude: 0,
			pre_close: i === 0 ? d.close : data[i - 1].close,
		};
	});
}

describe("runPoolBacktest", () => {
	function makeStore() {
		const dir = mkdtempSync(join(tmpdir(), "ta-poolbt-"));
		const dbPath = join(dir, "test.db");
		const store = createDataStore(dbPath);
		return { store, dir };
	}

	it("should produce identical trades when random ranking uses the same seed", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			setDataStore(store);

			const up = Array.from({ length: 10 }, (_, i) => ({
				open: 100 + i,
				high: 101 + i,
				low: 99 + i,
				close: 100 + i,
			}));

			await store.saveKlines(makeKlinesOHLC("A", 0, up));
			await store.saveKlines(makeKlinesOHLC("B", 0, up));
			await store.saveKlines(makeKlinesOHLC("C", 0, up));

			const config = {
				strategy: "always_buy" as const,
				start: "20240101",
				end: "20240110",
				period: "daily" as const,
				adjust: "bfq" as const,
				initialCapital: 1_000_000,
				fullPosition: true,
				fullPositionMode: "equal_weight" as const,
				maxPositions: 2,
				rankBy: "random" as const,
				seed: 42,
				slippage: 0,
				commission: 0,
				minLot: 100,
			};

			const result1 = await runPoolBacktest(
				[
					{ code: "A", market: 0 },
					{ code: "B", market: 0 },
					{ code: "C", market: 0 },
				],
				config,
			);
			const result2 = await runPoolBacktest(
				[
					{ code: "A", market: 0 },
					{ code: "B", market: 0 },
					{ code: "C", market: 0 },
				],
				config,
			);

			const codes1 = result1.trades.filter((t) => t.direction === "buy").map((t) => t.code);
			const codes2 = result2.trades.filter((t) => t.direction === "buy").map((t) => t.code);
			expect(codes1).toEqual(codes2);
			expect(result1.equityCurve.map((p) => p.equity)).toEqual(result2.equityCurve.map((p) => p.equity));
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});

	it("should equal-weight rebalance across target holdings", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			setDataStore(store);

			// A doubles, B flat -> A becomes overweight and should be trimmed
			const aData = Array.from({ length: 10 }, (_, i) => ({
				open: 100 + i * 12,
				high: 101 + i * 12,
				low: 99 + i * 12,
				close: 100 + i * 12,
			}));
			const bData = Array.from({ length: 10 }, (_, i) => ({
				open: 100 + i * 0.1,
				high: 101 + i * 0.1,
				low: 99 + i * 0.1,
				close: 100 + i * 0.1,
			}));

			await store.saveKlines(makeKlinesOHLC("A", 0, aData));
			await store.saveKlines(makeKlinesOHLC("B", 0, bData));

			const result = await runPoolBacktest(
				[
					{ code: "A", market: 0 },
					{ code: "B", market: 0 },
				],
				{
					strategy: "always_buy" as const,
					start: "20240101",
					end: "20240110",
					period: "daily" as const,
					adjust: "bfq" as const,
					initialCapital: 10_000_000,
					fullPosition: true,
					fullPositionMode: "equal_weight" as const,
					maxPositions: 2,
					slippage: 0,
					commission: 0,
					minLot: 100,
				},
			);

			const sells = result.trades.filter((t) => t.direction === "sell");
			const aSells = sells.filter((t) => t.code === "A");
			// A outperforms B, so equal-weight rebalancing should trim A at some point
			expect(aSells.length).toBeGreaterThan(0);
			expect(result.equityCurve[result.equityCurve.length - 1].equity).toBeGreaterThan(10_000_000);
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});
});
