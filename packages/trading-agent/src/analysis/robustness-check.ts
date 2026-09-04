import { runBacktest } from "../backtest/engine.js";
import type { DataStore } from "../data/index.js";
import type { RobustnessResult, TradingIdea } from "./types.js";

const ROBUSTNESS_DEFAULTS = {
	perturbRatio: 0.2, // ±20% parameter perturbation
	subWindowCount: 3, // split period into 3 sub-windows
	resampleRounds: 3, // resample stock pool 3 times
	minSubWindowDays: 15,
	minTradesPerWindow: 3,
};

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function toDateParam(isoDate: string): string {
	return isoDate.replace(/-/g, "");
}

function tradingDaysAgo(dateStr: string, days: number): string {
	const y = Number(dateStr.slice(0, 4));
	const m = Number(dateStr.slice(5, 7)) - 1;
	const d = Number(dateStr.slice(8, 10));
	const date = new Date(y, m, d);
	date.setDate(date.getDate() - days);
	return formatDate(date);
}

function cv(values: number[]): number {
	if (values.length < 2) return 0;
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	if (mean === 0) return 0;
	const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
	return Math.sqrt(variance) / Math.abs(mean);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function resolveUniverse(
	store: DataStore,
	idea: TradingIdea,
	latestDate: string,
	maxStocks: number,
): Promise<Array<{ code: string; market: number }>> {
	const industryFilter = idea.suggestedStrategy.industryFilter;
	const sizeFilter = idea.suggestedStrategy.sizeFilter;

	if (industryFilter) {
		const topCount = Math.min(industryFilter.topIndustryCount, 10);
		const rows = await store.query<{ code: string }>(
			`SELECT ii.code
			 FROM industry_indicators ii
			 JOIN industries i ON ii.code = i.code AND i.standard = ?
			 WHERE ii.period_days = ? AND ii.date = ? AND ii.momentum_rank <= ?
			 ORDER BY ii.momentum_rank ASC`,
			[industryFilter.standard, industryFilter.periodDays, latestDate, topCount],
		);
		if (rows.length === 0) return [];
		const industryCodes = rows.map((r) => r.code);
		const placeholders = industryCodes.map(() => "?").join(",");
		return store.query<{ code: string; market: number }>(
			`SELECT si.code, si.market
			 FROM stock_industries si
			 WHERE si.standard = ? AND si.industry_code IN (${placeholders})
			 GROUP BY si.code, si.market
			 LIMIT ?`,
			[industryFilter.standard, ...industryCodes, maxStocks],
		);
	}

	if (sizeFilter) {
		const direction = sizeFilter.direction === "small" ? "ASC" : "DESC";
		return store.query<{ code: string; market: number }>(
			`SELECT code, CAST(CASE WHEN code LIKE '6%' OR code LIKE '9%' THEN 1 ELSE 0 END AS INTEGER) as market
			 FROM quotes WHERE snapshot_date = ? AND total_cap IS NOT NULL
			 ORDER BY total_cap ${direction} LIMIT ?`,
			[latestDate, maxStocks],
		);
	}

	const startDate = tradingDaysAgo(latestDate, 60);
	return store.query<{ code: string; market: number }>(
		`SELECT DISTINCT k.code, k.market
		 FROM klines k
		 WHERE k.period = 'daily' AND k.adjust = 'bfq' AND k.date >= ? AND k.date <= ?
		 ORDER BY RANDOM() LIMIT ?`,
		[startDate, latestDate, maxStocks],
	);
}

/**
 * Perturb strategy parameters by ±ratio and run single-stock backtests.
 * Returns coefficient of variation of Sharpe across variants (lower = more stable).
 */
async function checkParameterSensitivity(
	store: DataStore,
	idea: TradingIdea,
	lookbackDays: number,
): Promise<number | null> {
	const params = idea.suggestedStrategy.params ?? {};
	const paramKeys = Object.keys(params);

	if (paramKeys.length === 0) {
		return 0; // No params to perturb = perfectly stable (degenerate case)
	}

	const latestDate = idea.dataSnapshot.latestDate;
	const startDate = tradingDaysAgo(latestDate, lookbackDays);
	const stocks = await resolveUniverse(store, idea, latestDate, 10);
	if (stocks.length < 3) return null;

	// Generate parameter variants: base + each param ±20%
	const variantParams: Array<Record<string, number>> = [{ ...params }];
	for (const key of paramKeys) {
		const base = params[key];
		if (typeof base !== "number" || base === 0) continue;
		const delta = Math.max(1, Math.round(base * ROBUSTNESS_DEFAULTS.perturbRatio));
		variantParams.push({ ...params, [key]: base + delta });
		variantParams.push({ ...params, [key]: Math.max(1, base - delta) });
	}

	// Run backtests for each variant across sampled stocks, collect median Sharpe
	const sharpeByVariant: number[] = [];

	for (const vp of variantParams) {
		const results = await Promise.all(
			stocks.map((s) =>
				runBacktest({
					code: s.code,
					market: s.market,
					strategy: idea.suggestedStrategy.strategy,
					start: toDateParam(startDate),
					end: toDateParam(latestDate),
					strategyParams: vp,
				}).catch(() => null),
			),
		);

		const sharpes = results
			.filter((r): r is NonNullable<typeof r> => r !== null && r.trades.length > 0)
			.map((r) => r.metrics.sharpeRatio);

		if (sharpes.length >= 3) {
			sharpeByVariant.push(median(sharpes));
		}
	}

	if (sharpeByVariant.length < 2) return null;
	return cv(sharpeByVariant);
}

/**
 * Split the backtest period into N sub-windows, run backtest on each.
 * Returns fraction of windows with positive return (0-1).
 */
async function checkTimeStability(store: DataStore, idea: TradingIdea, lookbackDays: number): Promise<number | null> {
	const subCount = ROBUSTNESS_DEFAULTS.subWindowCount;
	const subDays = Math.floor(lookbackDays / subCount);
	if (subDays < ROBUSTNESS_DEFAULTS.minSubWindowDays) return null;

	const latestDate = idea.dataSnapshot.latestDate;
	const stocks = await resolveUniverse(store, idea, latestDate, 10);
	if (stocks.length < 3) return null;

	let profitable = 0;
	let total = 0;

	for (let w = 0; w < subCount; w++) {
		const subEnd = tradingDaysAgo(latestDate, w * subDays);
		const subStart = tradingDaysAgo(subEnd, subDays);

		const results = await Promise.all(
			stocks.map((s) =>
				runBacktest({
					code: s.code,
					market: s.market,
					strategy: idea.suggestedStrategy.strategy,
					start: toDateParam(subStart),
					end: toDateParam(subEnd),
					strategyParams: idea.suggestedStrategy.params,
				}).catch(() => null),
			),
		);

		const valid = results.filter(
			(r): r is NonNullable<typeof r> => r !== null && r.trades.length >= ROBUSTNESS_DEFAULTS.minTradesPerWindow,
		);

		if (valid.length >= 3) {
			total++;
			const medReturn = median(valid.map((r) => r.metrics.totalReturn));
			if (medReturn > 0) profitable++;
		}
	}

	if (total < 2) return null;
	return profitable / total;
}

/**
 * Resample the stock pool and check consistency of results.
 * Returns coefficient of variation of Sharpe across resampled pools.
 */
async function checkPoolStability(store: DataStore, idea: TradingIdea, lookbackDays: number): Promise<number | null> {
	const latestDate = idea.dataSnapshot.latestDate;
	const startDate = tradingDaysAgo(latestDate, lookbackDays);
	const allStocks = await resolveUniverse(store, idea, latestDate, 60);
	if (allStocks.length < 15) return null;

	const rounds = ROBUSTNESS_DEFAULTS.resampleRounds;
	const sampleSize = Math.max(10, Math.floor(allStocks.length / 3));
	const sharpes: number[] = [];

	for (let r = 0; r < rounds; r++) {
		// Random shuffle and take sampleSize
		const shuffled = [...allStocks].sort(() => Math.random() - 0.5);
		const sample = shuffled.slice(0, sampleSize);

		const results = await Promise.all(
			sample.map((s) =>
				runBacktest({
					code: s.code,
					market: s.market,
					strategy: idea.suggestedStrategy.strategy,
					start: toDateParam(startDate),
					end: toDateParam(latestDate),
					strategyParams: idea.suggestedStrategy.params,
				}).catch(() => null),
			),
		);

		const validSharpes = results
			.filter((r): r is NonNullable<typeof r> => r !== null && r.trades.length > 0)
			.map((r) => r.metrics.sharpeRatio);

		if (validSharpes.length >= 3) {
			sharpes.push(median(validSharpes));
		}
	}

	if (sharpes.length < 2) return null;
	return cv(sharpes);
}

/**
 * Compute robustness score 0-100 from the three stability metrics.
 *
 *   parameterCv: lower is better. cv=0 → +30, cv=1.0 → +0
 *   timeConsistency: higher is better. consistency=1.0 → +35, 0 → +0
 *   poolCv: lower is better. cv=0 → +35, cv=1.0 → +0
 */
export function robustnessScore(
	parameterCv: number | null,
	timeConsistency: number | null,
	poolCv: number | null,
): number {
	let score = 0;
	let components = 0;

	if (parameterCv != null) {
		score += Math.max(0, 30 * (1 - Math.min(1, parameterCv)));
		components++;
	}

	if (timeConsistency != null) {
		score += Math.max(0, 35 * timeConsistency);
		components++;
	}

	if (poolCv != null) {
		score += Math.max(0, 35 * (1 - Math.min(1, poolCv)));
		components++;
	}

	// If fewer than 2 components could be measured, scale proportionally
	if (components < 2) {
		score = Math.round((score / 100) * 50); // max 50 if only one component
	}

	return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Run robustness checks on a trading idea: parameter sensitivity, time stability,
 * and stock pool stability.
 */
export async function checkRobustness(
	store: DataStore,
	idea: TradingIdea,
	lookbackDays: number,
): Promise<RobustnessResult> {
	const [parameterCv, timeConsistency, poolCv] = await Promise.all([
		checkParameterSensitivity(store, idea, lookbackDays).catch(() => null),
		checkTimeStability(store, idea, lookbackDays).catch(() => null),
		checkPoolStability(store, idea, lookbackDays).catch(() => null),
	]);

	const score = robustnessScore(parameterCv, timeConsistency, poolCv);

	const reasons: string[] = [];
	if (parameterCv != null) {
		reasons.push(
			parameterCv < 0.3
				? `参数稳定性好 (CV=${parameterCv.toFixed(2)})`
				: parameterCv < 0.6
					? `参数稳定性一般 (CV=${parameterCv.toFixed(2)})`
					: `参数稳定性差 (CV=${parameterCv.toFixed(2)})`,
		);
	} else {
		reasons.push("参数稳定性: 数据不足无法评估");
	}

	if (timeConsistency != null) {
		reasons.push(
			timeConsistency >= 0.67
				? `时间稳定性好 (${(timeConsistency * 100).toFixed(0)}%窗口盈利)`
				: `时间稳定性差 (${(timeConsistency * 100).toFixed(0)}%窗口盈利)`,
		);
	} else {
		reasons.push("时间稳定性: 数据不足无法评估");
	}

	if (poolCv != null) {
		reasons.push(
			poolCv < 0.3 ? `股票池稳定性好 (CV=${poolCv.toFixed(2)})` : `股票池稳定性一般 (CV=${poolCv.toFixed(2)})`,
		);
	} else {
		reasons.push("股票池稳定性: 数据不足无法评估");
	}

	return {
		success: parameterCv != null || timeConsistency != null || poolCv != null,
		score,
		parameterCv,
		timeConsistency,
		poolCv,
		reason: reasons.join("; "),
	};
}
