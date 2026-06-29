import { describe, expect, it } from "vitest";
import { cacheKey, IndicatorCache } from "./indicator-cache.js";

describe("IndicatorCache", () => {
	it("should cache and reuse computed values", () => {
		const cache = new IndicatorCache();
		let calls = 0;
		const key = cacheKey("A", 1, "daily", "ma", { period: 10 });

		const v1 = cache.getOrCompute(key, () => {
			calls++;
			return 42;
		});
		const v2 = cache.getOrCompute(key, () => {
			calls++;
			return 99;
		});

		expect(v1).toBe(42);
		expect(v2).toBe(42);
		expect(calls).toBe(1);
	});

	it("should recompute when params change", () => {
		const cache = new IndicatorCache();
		let calls = 0;
		const key1 = cacheKey("A", 1, "daily", "ma", { period: 10 });
		const key2 = cacheKey("A", 1, "daily", "ma", { period: 20 });

		const v1 = cache.getOrCompute(key1, () => {
			calls++;
			return 10;
		});
		const v2 = cache.getOrCompute(key2, () => {
			calls++;
			return 20;
		});

		expect(v1).toBe(10);
		expect(v2).toBe(20);
		expect(calls).toBe(2);
	});

	it("should evict oldest entries when capacity is exceeded", () => {
		const cache = new IndicatorCache(2);
		const k1 = cacheKey("A", 1, "daily", "ma", { period: 1 });
		const k2 = cacheKey("B", 1, "daily", "ma", { period: 1 });
		const k3 = cacheKey("C", 1, "daily", "ma", { period: 1 });

		cache.getOrCompute(k1, () => 1);
		cache.getOrCompute(k2, () => 2);
		// Access k1 so k2 becomes oldest
		cache.getOrCompute(k1, () => 100);
		cache.getOrCompute(k3, () => 3);

		expect(cache.size).toBe(2);
		expect(cache.getOrCompute(k1, () => 100)).toBe(1);
		expect(cache.getOrCompute(k3, () => 300)).toBe(3);
		// k2 should have been evicted
		expect(cache.getOrCompute(k2, () => 200)).toBe(200);
	});
});
