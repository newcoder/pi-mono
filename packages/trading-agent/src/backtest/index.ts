export { runBacktest } from "./engine.js";
export { computeMetrics } from "./metrics.js";
export { formatBacktestResult, formatTradeList } from "./report.js";
export type {
	BacktestConfig,
	BacktestMetrics,
	BacktestResult,
	EquityPoint,
	Signal,
	StrategyType,
	Trade,
} from "./types.js";
