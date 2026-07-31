import type { KlineRow } from "../data/types.js";
import { computeKD, computeMA, computeMACD, computeRSI, computeSupertrend, getCloses } from "../indicators/engine.js";

export interface IndicatorCacheKey {
	code: string;
	market: number;
	period: string;
	indicatorName: string;
	paramsHash: string;
}

export class IndicatorCache {
	private cache = new Map<string, unknown>();
	/** Ordered key store. Re-inserting a key moves it to the most-recent end. */
	private order = new Map<string, true>();

	constructor(private capacity = 50_000) {}

	private makeKey(parts: IndicatorCacheKey): string {
		return `${parts.code}_${parts.market}_${parts.period}_${parts.indicatorName}_${parts.paramsHash}`;
	}

	private touch(key: string): void {
		// Delete and re-set to move key to the most-recent position in O(1).
		if (this.order.has(key)) {
			this.order.delete(key);
		}
		this.order.set(key, true);

		while (this.order.size > this.capacity) {
			const oldest = this.order.keys().next().value;
			if (oldest === undefined) break;
			this.order.delete(oldest);
			this.cache.delete(oldest);
		}
	}

	getOrCompute<T>(parts: IndicatorCacheKey, factory: () => T): T {
		const key = this.makeKey(parts);
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			this.touch(key);
			return cached as T;
		}
		const value = factory();
		this.cache.set(key, value);
		this.touch(key);
		return value;
	}

	clear(): void {
		this.cache.clear();
		this.order.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}

export const indicatorCache = new IndicatorCache();

function stableParamsHash(params: Record<string, unknown>): string {
	const keys = Object.keys(params).sort();
	const entries = keys.map((k) => `${k}:${JSON.stringify(params[k])}`);
	return entries.join("|");
}

export function cacheKey(
	code: string,
	market: number,
	period: string,
	indicatorName: string,
	params: Record<string, unknown>,
): IndicatorCacheKey {
	return {
		code,
		market,
		period,
		indicatorName,
		paramsHash: stableParamsHash(params),
	};
}

export function getKlinePeriod(klines: KlineRow[]): string {
	return klines[0]?.period ?? "daily";
}

export function getStockKey(klines: KlineRow[]): { code: string; market: number } {
	const first = klines[0];
	if (!first) throw new Error("Cannot compute indicator key for empty klines");
	return { code: first.code, market: first.market };
}

export function cachedMA(klines: KlineRow[], period: number) {
	const { code, market } = getStockKey(klines);
	return indicatorCache.getOrCompute(cacheKey(code, market, getKlinePeriod(klines), "ma", { period }), () =>
		computeMA(getCloses(klines), period),
	);
}

export function cachedMACD(klines: KlineRow[], config: { fast: number; slow: number; signal: number }) {
	const { code, market } = getStockKey(klines);
	return indicatorCache.getOrCompute(cacheKey(code, market, getKlinePeriod(klines), "macd", config), () =>
		computeMACD(getCloses(klines), config),
	);
}

export function cachedRSI(klines: KlineRow[], config: { period: number }) {
	const { code, market } = getStockKey(klines);
	return indicatorCache.getOrCompute(cacheKey(code, market, getKlinePeriod(klines), "rsi", config), () =>
		computeRSI(getCloses(klines), config),
	);
}

export function cachedKD(klines: KlineRow[], config: { period: number; smoothK: number; smoothD: number }) {
	const { code, market } = getStockKey(klines);
	return indicatorCache.getOrCompute(cacheKey(code, market, getKlinePeriod(klines), "kd", config), () =>
		computeKD(klines, config),
	);
}

export function cachedSupertrend(klines: KlineRow[], config: { period: number; multiplier: number }) {
	const { code, market } = getStockKey(klines);
	return indicatorCache.getOrCompute(cacheKey(code, market, getKlinePeriod(klines), "supertrend", config), () =>
		computeSupertrend(klines, config),
	);
}
