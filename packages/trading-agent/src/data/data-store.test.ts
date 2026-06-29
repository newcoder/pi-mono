import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataStore } from "./index.js";
import type { KlineRow } from "./types.js";

describe("DataStore batch loaders", () => {
	function makeStore() {
		const dir = mkdtempSync(join(tmpdir(), "ta-datastore-"));
		const dbPath = join(dir, "test.db");
		const store = createDataStore(dbPath);
		return { store, dir };
	}

	function makeKline(code: string, market: number, date: string, close: number): KlineRow {
		return {
			code,
			market,
			period: "daily",
			adjust: "bfq",
			date,
			open: close,
			high: close,
			low: close,
			close,
			volume: 1,
			turnover: null,
			change_pct: null,
			change_amount: null,
			amplitude: null,
			pre_close: null,
		};
	}

	it("should load klines for multiple codes in a single call", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			await store.saveKlines([
				makeKline("600519", 1, "2024-01-01", 100),
				makeKline("600519", 1, "2024-01-02", 101),
				makeKline("000001", 0, "2024-01-01", 10),
				makeKline("000001", 0, "2024-01-02", 11),
				makeKline("000002", 0, "2024-01-01", 20),
			]);

			const groups = await store.getKlinesForCodes(
				[
					{ code: "600519", market: 1 },
					{ code: "000001", market: 0 },
					{ code: "000002", market: 0 },
					{ code: "999999", market: 1 }, // missing
				],
				"daily",
				"bfq",
				"2024-01-01",
				"2024-01-02",
			);

			expect(groups.size).toBe(3);
			expect(groups.get("600519_1")?.map((k) => k.close)).toEqual([100, 101]);
			expect(groups.get("000001_0")?.map((k) => k.close)).toEqual([10, 11]);
			expect(groups.get("000002_0")?.map((k) => k.close)).toEqual([20]);
			expect(groups.has("999999_1")).toBe(false);
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});

	it("should load adjustment factors for multiple codes in a single call", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			await store.saveAdjustFactors([
				{ code: "600519", market: 1, date: "2024-01-01", qfq_factor: 1.0, hfq_factor: 1.0 },
				{ code: "600519", market: 1, date: "2024-01-02", qfq_factor: 1.1, hfq_factor: 1.1 },
				{ code: "000001", market: 0, date: "2024-01-01", qfq_factor: 0.9, hfq_factor: 0.9 },
			]);

			const groups = await store.getAdjustFactorsForCodes(
				[
					{ code: "600519", market: 1 },
					{ code: "000001", market: 0 },
					{ code: "999999", market: 1 },
				],
				"2024-01-01",
				"2024-01-02",
			);

			expect(groups.size).toBe(2);
			expect(groups.get("600519_1")?.map((f) => f.qfq_factor)).toEqual([1.0, 1.1]);
			expect(groups.get("000001_0")?.map((f) => f.qfq_factor)).toEqual([0.9]);
			expect(groups.has("999999_1")).toBe(false);
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});
});
