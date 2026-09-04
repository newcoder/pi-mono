import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataStore } from "./index.js";

describe("dynamic pool storage", () => {
	function makeStore() {
		const dir = mkdtempSync(join(tmpdir(), "ta-dynpool-"));
		const dbPath = join(dir, "test.db");
		const store = createDataStore(dbPath);
		return { store, dir, dbPath };
	}

	it("should create a dynamic pool and persist items by date", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			const poolId = await store.createStockPool("dyn-test", "desc", true);

			await store.setDynamicPoolItems(poolId, "2024-01-01", [
				{ code: "000001", market: 0, name: "平安银行", weight: 0.5 },
				{ code: "600519", market: 1, name: "贵州茅台" },
			]);
			await store.setDynamicPoolItems(poolId, "2024-01-02", [
				{ code: "000001", market: 0 },
				{ code: "000002", market: 0 },
			]);

			const day1 = await store.getDynamicPoolItems(poolId, "2024-01-01");
			expect(day1).toHaveLength(2);
			expect(day1.map((i) => i.code).sort()).toEqual(["000001", "600519"]);
			expect(day1.find((i) => i.code === "000001")?.weight).toBe(0.5);

			const day2 = await store.getDynamicPoolItems(poolId, "2024-01-02");
			expect(day2.map((i) => i.code).sort()).toEqual(["000001", "000002"]);

			const dates = await store.getDynamicPoolDates(poolId);
			expect(dates).toEqual(["2024-01-01", "2024-01-02"]);

			const range = await store.getDynamicPoolItemsInRange(poolId, "2024-01-01", "2024-01-02");
			expect(range.size).toBe(2);
			expect(
				range
					.get("2024-01-02")
					?.map((i) => i.code)
					.sort(),
			).toEqual(["000001", "000002"]);

			await store.clearDynamicPoolDate(poolId, "2024-01-01");
			expect(await store.getDynamicPoolItems(poolId, "2024-01-01")).toHaveLength(0);
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});

	it("should carry forward items when getting range with gaps", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			const poolId = await store.createStockPool("dyn-gap", undefined, true);
			await store.setDynamicPoolItems(poolId, "2024-01-01", [{ code: "600519", market: 1 }]);
			await store.setDynamicPoolItems(poolId, "2024-01-05", [{ code: "000001", market: 0 }]);

			const range = await store.getDynamicPoolItemsInRange(poolId, "2024-01-01", "2024-01-05");
			expect(range.get("2024-01-01")?.map((i) => i.code)).toEqual(["600519"]);
			expect(range.get("2024-01-05")?.map((i) => i.code)).toEqual(["000001"]);
			expect(range.has("2024-01-03")).toBe(false);
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});

	it("should delete dynamic items when pool is deleted", async () => {
		const { store, dir } = makeStore();
		try {
			await store.init();
			const poolId = await store.createStockPool("dyn-delete", undefined, true);
			await store.setDynamicPoolItems(poolId, "2024-01-01", [{ code: "600519", market: 1 }]);
			await store.deleteStockPool(poolId);
			expect(await store.getDynamicPoolItems(poolId, "2024-01-01")).toHaveLength(0);
		} finally {
			await store.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	});
});
