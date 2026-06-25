import { runBacktest, runPoolBacktest } from "../backtest/engine.js";
import type { BacktestMetrics, PoolBacktestConfig } from "../backtest/types.js";
import type { DataStore } from "../data/index.js";
import type { BacktestValidationResult, TradingIdea } from "./types.js";

const BACKTEST_DEFAULTS = {
	period: "daily",
	adjust: "bfq",
	initialCapital: 100_000,
	positionSize: 1.0,
	slippage: 0.001,
	commission: 0.0003,
	minLot: 100,
};

const MAX_POOL_STOCKS = 50;
const MAX_SAMPLED_STOCKS = 20;
const MIN_UNIVERSE_SIZE = 5;
const BACKTEST_TIMEOUT_MS = 30_000;

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

/**
 * Compute a 0-100 confidence score purely from backtest metrics.
 * No heuristic adjustments — entirely data-driven.
 *
 * Formula:
 *   base = 40
 *   + sharpeScore  = clamp(Sharpe * 10, -10, 25)
 *   + winRateScore = clamp((winRate - 50) * 0.5, -15, 15)
 *   + pfScore      = clamp((profitFactor - 1) * 8, -10, 15)
 *   + ddPenalty    = clamp(-maxDrawdown * 0.33, -20, 0)
 *   + tradeAdj     = totalTrades < 5 ? -15 : min(5, totalTrades * 0.1)
 */
export function metricsToConfidence(metrics: BacktestMetrics): number {
	const sharpeScore = Math.max(-10, Math.min(25, metrics.sharpeRatio * 10));
	const winRateScore = Math.max(-15, Math.min(15, (metrics.winRate - 50) * 0.5));
	const pfScore = Math.max(-10, Math.min(15, (metrics.profitFactor - 1) * 8));
	const ddPenalty = Math.max(-20, Math.min(0, -metrics.maxDrawdown * 0.33));
	const tradeAdj = metrics.totalTrades < 5 ? -15 : Math.min(5, metrics.totalTrades * 0.1);

	return Math.max(0, Math.min(100, 40 + sharpeScore + winRateScore + pfScore + ddPenalty + tradeAdj));
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
	const constraints = idea.constraints;
	const industryFilter = idea.suggestedStrategy.industryFilter;
	const sizeFilter = idea.suggestedStrategy.sizeFilter;

	// Industry-filtered universe
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
		// Get stocks for those top industries
		const industryCodes = rows.map((r) => r.code);
		const placeholders = industryCodes.map(() => "?").join(",");
		const stockRows = await store.query<{ code: string; market: number }>(
			`SELECT si.code, si.market
			 FROM stock_industries si
			 WHERE si.standard = ? AND si.industry_code IN (${placeholders})
			 GROUP BY si.code, si.market
			 LIMIT ?`,
			[industryFilter.standard, ...industryCodes, maxStocks],
		);
		return stockRows;
	}

	// Size-filtered universe
	if (sizeFilter) {
		const direction = sizeFilter.direction === "small" ? "ASC" : "DESC";
		const stockRows = await store.query<{ code: string; market: number }>(
			`SELECT code, CAST(CASE WHEN code LIKE '6%' OR code LIKE '9%' THEN 1 ELSE 0 END AS INTEGER) as market
			 FROM quotes
			 WHERE snapshot_date = ? AND total_cap IS NOT NULL
			 ORDER BY total_cap ${direction}
			 LIMIT ?`,
			[latestDate, maxStocks],
		);
		return stockRows;
	}

	// Constraint-based universe
	if (constraints) {
		let sql = `SELECT DISTINCT q.code, CAST(CASE WHEN q.code LIKE '6%' OR q.code LIKE '9%' THEN 1 ELSE 0 END AS INTEGER) as market
			FROM quotes q WHERE q.snapshot_date = ? AND q.total_cap IS NOT NULL`;
		const params: unknown[] = [latestDate];

		if (constraints.industryScope) {
			sql += ` AND EXISTS (SELECT 1 FROM stock_industries si WHERE si.code = q.code AND si.standard = ?)`;
			params.push(constraints.industryScope);
		}
		if (constraints.sizeScope === "large") {
			sql += ` ORDER BY q.total_cap DESC`;
		} else if (constraints.sizeScope === "small") {
			sql += ` ORDER BY q.total_cap ASC`;
		}
		sql += ` LIMIT ?`;
		params.push(maxStocks);

		return store.query<{ code: string; market: number }>(sql, params);
	}

	// Fundamental: PE/PB range
	if (idea.category === "fundamental") {
		return store.query<{ code: string; market: number }>(
			`SELECT code, CAST(CASE WHEN code LIKE '6%' OR code LIKE '9%' THEN 1 ELSE 0 END AS INTEGER) as market
			 FROM quotes
			 WHERE snapshot_date = ? AND pe > 0 AND pe < 30 AND pb > 0 AND pb < 2
			 ORDER BY RANDOM()
			 LIMIT ?`,
			[latestDate, maxStocks],
		);
	}

	// Default: stocks with recent klines
	const startDate = tradingDaysAgo(latestDate, 60);
	return store.query<{ code: string; market: number }>(
		`SELECT DISTINCT k.code, k.market
		 FROM klines k
		 WHERE k.period = 'daily' AND k.adjust = 'bfq' AND k.date >= ? AND k.date <= ?
		 ORDER BY RANDOM()
		 LIMIT ?`,
		[startDate, latestDate, maxStocks],
	);
}

async function poolValidateIdea(
	store: DataStore,
	idea: TradingIdea,
	lookbackDays: number,
): Promise<BacktestValidationResult> {
	const t0 = performance.now();
	const latestDate = idea.dataSnapshot.latestDate;
	const startDate = tradingDaysAgo(latestDate, lookbackDays);

	const stocks = await resolveUniverse(store, idea, latestDate, MAX_POOL_STOCKS);
	if (stocks.length < MIN_UNIVERSE_SIZE) {
		return {
			success: false,
			reason: `可回测股票池不足（需要 ≥${MIN_UNIVERSE_SIZE}，实际 ${stocks.length}）`,
			metrics: null,
			validatedConfidence: 0,
			elapsedMs: Math.round(performance.now() - t0),
		};
	}

	const config: PoolBacktestConfig = {
		strategy: idea.suggestedStrategy.strategy,
		start: toDateParam(startDate),
		end: toDateParam(latestDate),
		period: BACKTEST_DEFAULTS.period,
		adjust: BACKTEST_DEFAULTS.adjust,
		initialCapital: BACKTEST_DEFAULTS.initialCapital,
		positionSize: BACKTEST_DEFAULTS.positionSize,
		slippage: BACKTEST_DEFAULTS.slippage,
		commission: BACKTEST_DEFAULTS.commission,
		minLot: BACKTEST_DEFAULTS.minLot,
		strategyParams: idea.suggestedStrategy.params,
		industryFilter: idea.suggestedStrategy.industryFilter,
		sizeFilter: idea.suggestedStrategy.sizeFilter,
	};

	try {
		const result = await withTimeout(runPoolBacktest(stocks, config), BACKTEST_TIMEOUT_MS);
		const confidence = metricsToConfidence(result.metrics);

		return {
			success: true,
			reason: `Pool backtest: ${stocks.length} stocks, ${result.trades.length} trades`,
			metrics: {
				totalReturn: result.metrics.totalReturn,
				sharpeRatio: result.metrics.sharpeRatio,
				winRate: result.metrics.winRate,
				profitFactor: result.metrics.profitFactor,
				maxDrawdown: result.metrics.maxDrawdown,
				totalTrades: result.metrics.totalTrades,
			},
			validatedConfidence: confidence,
			elapsedMs: Math.round(performance.now() - t0),
		};
	} catch (err) {
		return {
			success: false,
			reason: `Pool回测失败: ${err instanceof Error ? err.message : String(err)}`,
			metrics: null,
			validatedConfidence: 0,
			elapsedMs: Math.round(performance.now() - t0),
		};
	}
}

async function sampledValidateIdea(
	store: DataStore,
	idea: TradingIdea,
	lookbackDays: number,
): Promise<BacktestValidationResult> {
	const t0 = performance.now();
	const latestDate = idea.dataSnapshot.latestDate;
	const startDate = tradingDaysAgo(latestDate, lookbackDays);

	const stocks = await resolveUniverse(store, idea, latestDate, MAX_SAMPLED_STOCKS);
	if (stocks.length < MIN_UNIVERSE_SIZE) {
		return {
			success: false,
			reason: `可回测股票数量不足（需要 ≥${MIN_UNIVERSE_SIZE}，实际 ${stocks.length}）`,
			metrics: null,
			validatedConfidence: 0,
			elapsedMs: Math.round(performance.now() - t0),
		};
	}

	// Run single-stock backtests in parallel with concurrency limit
	const results = await runWithConcurrency(
		stocks.map(
			(s) => () =>
				withTimeout(
					runBacktest({
						code: s.code,
						market: s.market,
						strategy: idea.suggestedStrategy.strategy,
						start: toDateParam(startDate),
						end: toDateParam(latestDate),
						period: BACKTEST_DEFAULTS.period,
						adjust: BACKTEST_DEFAULTS.adjust,
						initialCapital: BACKTEST_DEFAULTS.initialCapital,
						positionSize: BACKTEST_DEFAULTS.positionSize,
						slippage: BACKTEST_DEFAULTS.slippage,
						commission: BACKTEST_DEFAULTS.commission,
						minLot: BACKTEST_DEFAULTS.minLot,
						strategyParams: idea.suggestedStrategy.params,
					}),
					BACKTEST_TIMEOUT_MS,
				).catch(() => null),
		),
		5,
	);

	const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null && r.trades.length > 0);
	if (validResults.length < 3) {
		return {
			success: false,
			reason: `有效回测结果不足（需要 ≥3 只有交易记录，实际 ${validResults.length}）`,
			metrics: null,
			validatedConfidence: 0,
			elapsedMs: Math.round(performance.now() - t0),
		};
	}

	// Aggregate via median for robustness
	const aggMetrics: BacktestMetrics = {
		totalReturn: median(validResults.map((r) => r.metrics.totalReturn)),
		annualizedReturn: median(validResults.map((r) => r.metrics.annualizedReturn)),
		sharpeRatio: median(validResults.map((r) => r.metrics.sharpeRatio)),
		maxDrawdown: median(validResults.map((r) => r.metrics.maxDrawdown)),
		maxDrawdownDuration: 0,
		winRate: median(validResults.map((r) => r.metrics.winRate)),
		profitFactor: median(validResults.map((r) => r.metrics.profitFactor)),
		avgWin: 0,
		avgLoss: 0,
		totalTrades: Math.round(median(validResults.map((r) => r.metrics.totalTrades))),
		winningTrades: 0,
		losingTrades: 0,
		avgHoldingDays: Math.round(median(validResults.map((r) => r.metrics.avgHoldingDays))),
	};

	const confidence = metricsToConfidence(aggMetrics);

	return {
		success: true,
		reason: `Sampled backtest: ${stocks.length} stocks → ${validResults.length} valid (median metrics)`,
		metrics: {
			totalReturn: aggMetrics.totalReturn,
			sharpeRatio: aggMetrics.sharpeRatio,
			winRate: aggMetrics.winRate,
			profitFactor: aggMetrics.profitFactor,
			maxDrawdown: aggMetrics.maxDrawdown,
			totalTrades: aggMetrics.totalTrades,
		},
		validatedConfidence: confidence,
		elapsedMs: Math.round(performance.now() - t0),
	};
}

/**
 * Validate a trading idea by running actual backtests against historical data.
 *
 * Dispatch logic:
 * - Has industryFilter or sizeFilter → pool backtest
 * - category === "event" → skip (not backtestable)
 * - Other (classic, technical, fundamental, market_style) → sampled single-stock
 */
export async function validateIdea(
	store: DataStore,
	idea: TradingIdea,
	lookbackDays: number,
): Promise<BacktestValidationResult> {
	const t0 = performance.now();

	// Event-driven ideas cannot be backtested
	if (idea.category === "event") {
		return {
			success: false,
			reason: "事件驱动策略无法回测验证，缺少历史事件模型",
			metrics: null,
			validatedConfidence: Math.min(40, idea.confidence),
			elapsedMs: Math.round(performance.now() - t0),
		};
	}

	const { industryFilter, sizeFilter } = idea.suggestedStrategy;

	// Ideas with industry or size filters → pool backtest
	if (industryFilter || sizeFilter) {
		return poolValidateIdea(store, idea, lookbackDays);
	}

	// All other categories → sampled single-stock backtest
	return sampledValidateIdea(store, idea, lookbackDays);
}

// ─── Helpers ────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Backtest timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let index = 0;

	async function worker(): Promise<void> {
		while (index < tasks.length) {
			const i = index++;
			results[i] = await tasks[i]();
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
	await Promise.all(workers);
	return results;
}
