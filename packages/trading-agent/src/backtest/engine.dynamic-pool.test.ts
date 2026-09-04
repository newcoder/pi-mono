import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataStore, setDataStore } from "../data/index.js";
import type { KlineRow } from "../data/types.js";
import { runDynamicPoolBacktest } from "./engine.js";

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

describe("runDynamicPoolBacktest", () => {
	function makeStore() {
		const dir = mkdtempSync(join(tmpdir(), "ta-dynbt-"));
		const dbPath = join(dir, "test.db");
		const store = createDataStore(dbPath);
		return { store, dir };
	}

	it("should trade only stocks in the daily pool and force-sell when a stock leaves", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			setDataStore(store);

			await store.saveKlines(
				makeKlinesOHLC("A", 0, [
					{ open: 102, high: 102, low: 99, close: 100 }, // bearish
					{ open: 99, high: 104, low: 99, close: 103 }, // bullish engulf
					{ open: 103, high: 105, low: 103, close: 105 },
					{ open: 105, high: 106, low: 105, close: 106 },
				]),
			);
			await store.saveKlines(
				makeKlinesOHLC("B", 0, [
					{ open: 52, high: 52, low: 49, close: 50 },
					{ open: 49, high: 54, low: 49, close: 53 },
					{ open: 53, high: 55, low: 53, close: 55 },
					{ open: 55, high: 56, low: 55, close: 56 },
				]),
			);

			const poolId = await store.createStockPool("dyn-bt", undefined, true);
			await store.setDynamicPoolItems(poolId, "2024-01-01", [{ code: "A", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-02", [{ code: "A", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-03", [{ code: "A", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-04", [{ code: "B", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-05", [{ code: "B", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-06", [{ code: "B", market: 0 }]);

			const result = await runDynamicPoolBacktest(poolId, {
				strategy: "bullish_engulf",
				start: "20240101",
				end: "20240106",
				period: "daily",
				adjust: "bfq",
				initialCapital: 1_000_000,
				fullPosition: false,
				maxPositions: 1,
				slippage: 0,
				commission: 0,
				minLot: 100,
			});

			const buys = result.trades.filter((t) => t.direction === "buy");
			const sells = result.trades.filter((t) => t.direction === "sell");

			expect(buys.length).toBe(1);
			expect(buys[0].code).toBe("A");
			expect(buys[0].date).toBe("2024-01-03");

			expect(sells.length).toBe(1);
			expect(sells[0].code).toBe("A");
			expect(sells[0].date).toBe("2024-01-04");
			expect(sells[0].memo).toContain("调出动态池");
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});

	it("should buy a new stock when it enters the pool", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			setDataStore(store);

			await store.saveKlines(
				makeKlinesOHLC("B", 0, [
					{ open: 52, high: 52, low: 49, close: 50 },
					{ open: 51, high: 51, low: 49, close: 50 }, // bearish
					{ open: 49, high: 54, low: 49, close: 53 }, // bullish engulf
					{ open: 53, high: 55, low: 53, close: 55 },
				]),
			);

			const poolId = await store.createStockPool("dyn-bt2", undefined, true);
			await store.setDynamicPoolItems(poolId, "2024-01-03", [{ code: "B", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-04", [{ code: "B", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-05", [{ code: "B", market: 0 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-06", [{ code: "B", market: 0 }]);

			const result = await runDynamicPoolBacktest(poolId, {
				strategy: "bullish_engulf",
				start: "20240101",
				end: "20240106",
				period: "daily",
				adjust: "bfq",
				initialCapital: 1_000_000,
				fullPosition: false,
				maxPositions: 1,
				slippage: 0,
				commission: 0,
				minLot: 100,
			});

			const buys = result.trades.filter((t) => t.direction === "buy");
			expect(buys.length).toBe(1);
			expect(buys[0].code).toBe("B");
			expect(buys[0].date).toBe("2024-01-04");
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});
});
