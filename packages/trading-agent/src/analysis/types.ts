import type { PoolIndustryFilterConfig, PoolSizeFilterConfig, StrategyType } from "../backtest/types.js";

export interface MarketRegime {
	/** Primary market regime label */
	regime: string;
	/** Active sub-regime flags */
	subRegimes: string[];
	/** Latest trading date observed in the data */
	latestDate: string;
	/** Top momentum industries (period_days=20) */
	topIndustries: Array<{ code: string; name: string; momentumReturn: number; rank: number }>;
	/** Weakest momentum industries */
	weakIndustries: Array<{ code: string; name: string; momentumReturn: number; rank: number }>;
	/** Snapshot of factor IC: latest value, rolling average, direction, and significance stats */
	factorIcSnapshot: Record<
		string,
		{
			latest: number;
			avg20d: number;
			direction: "positive" | "negative" | "neutral";
			/** Information Ratio = mean IC / std IC over the lookback window */
			ir: number;
			/** Percentage of periods in the window with IC > 0 */
			hitRate: number;
			/** t-statistic of the mean IC */
			tStat: number;
		}
	>;
	/** Market sentiment index (0-100) if available */
	sentimentIndex: number | null;
	/** Volatility proxy: average industry amplitude on latest date */
	volatilityProxy: number | null;
}

export interface TradingIdea {
	/** Short unique id */
	id: string;
	/** One-sentence trading thesis */
	hypothesis: string;
	/** Why this idea makes sense now */
	rationale: string;
	/** Source category */
	category: "market_style" | "technical" | "fundamental" | "event" | "classic" | "multifactor";
	/** Expected holding horizon */
	timeframe: "intraday" | "short_term" | "medium_term";
	/** Quantifiable entry condition */
	entryCriteria: string;
	/** Quantifiable exit condition */
	exitCriteria: string;
	/** Human-readable universe filter */
	universeFilter: string;
	/** Strategy + params that can be passed to backtest_strategy */
	suggestedStrategy: {
		strategy: StrategyType;
		params?: Record<string, number>;
		industryFilter?: PoolIndustryFilterConfig;
		sizeFilter?: PoolSizeFilterConfig;
	};
	/** Confidence score 0-100 */
	confidence: number;
	/** Lightweight feasibility check result */
	feasibility: { pass: boolean; reason: string };
	/** Key risks */
	risks: string[];
	/** Conditions that would invalidate the idea */
	invalidationConditions: string[];
	/** Snapshot of data used to form the idea */
	dataSnapshot: {
		lookbackDays: number;
		latestDate: string;
		topIndustries: string[];
		factorIcDirection: Record<string, number>;
		sentimentIndex: number | null;
		sectorRotationHot: string[];
		sampleSize: number;
	};
	/** Phase 2: Backtest validation result (populated after pipeline runs) */
	backtestValidation?: BacktestValidationResult;
	/** Phase 2: Robustness check result */
	robustness?: RobustnessResult;
	/** Phase 2: Precise constraints for time range and universe scope */
	constraints?: IdeaConstraints;
}

export interface IdeaConstraints {
	/** Start date for backtest validation (YYYY-MM-DD) */
	startDate: string;
	/** End date for backtest validation (YYYY-MM-DD) */
	endDate: string;
	/** Maximum number of stocks in the universe */
	maxStocks: number;
	/** Minimum number of stocks required */
	minStocks: number;
	/** Industry standard for filtering ("sw_l1", "sw_l2", etc.) */
	industryScope?: string;
	/** Size scope: "large", "small", or undefined for all */
	sizeScope?: "large" | "small";
}

export interface BacktestValidationResult {
	/** Whether the backtest ran without errors */
	success: boolean;
	/** Human-readable explanation */
	reason: string;
	/** Aggregate backtest metrics from validation */
	metrics: {
		totalReturn: number;
		sharpeRatio: number;
		winRate: number;
		profitFactor: number;
		maxDrawdown: number;
		totalTrades: number;
	} | null;
	/** Confidence score 0-100 derived exclusively from backtest metrics */
	validatedConfidence: number;
	/** Wall-clock time for the validation in milliseconds */
	elapsedMs: number;
}

export interface RobustnessResult {
	/** Whether robustness checks ran without errors */
	success: boolean;
	/** Overall robustness score 0-100 */
	score: number;
	/** Parameter sensitivity: coefficient of variation of Sharpe across perturbed params (0-1, lower is better) */
	parameterCv: number | null;
	/** Time window consistency: fraction of sub-windows with positive return (0-1) */
	timeConsistency: number | null;
	/** Stock pool stability: coefficient of variation of Sharpe across resampled pools (0-1) */
	poolCv: number | null;
	/** Human-readable breakdown */
	reason: string;
}
