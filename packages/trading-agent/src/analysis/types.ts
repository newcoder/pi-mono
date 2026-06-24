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
	category: "market_style" | "technical" | "fundamental" | "event" | "classic";
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
}
