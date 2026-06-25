import type { KlineRow } from "../data/types.js";

export type StrategyType = "ma_cross" | "macd_cross" | "rsi_reversal" | "bollinger_breakout" | "supertrend";

export interface BacktestConfig {
	code: string;
	market: number;
	strategy: StrategyType;
	start?: string;
	end?: string;
	period?: string;
	adjust?: string;
	initialCapital?: number;
	positionSize?: number; // percent of capital per trade, 0-1
	slippage?: number; // percent, e.g. 0.001 = 0.1%
	commission?: number; // percent per side, e.g. 0.0003 = 0.03%
	maxHoldingDays?: number;
	minLot?: number; // minimum lot size, e.g. 100 for A-shares
	strategyParams?: Record<string, number>;
}

export interface Signal {
	index: number;
	date: string;
	type: "buy" | "sell";
	price: number; // trigger price (close of signal day)
	reason: string;
}

export interface Trade {
	entryIndex: number;
	entryDate: string;
	entryPrice: number;
	exitIndex: number;
	exitDate: string;
	exitPrice: number;
	shares: number;
	pnl: number; // profit/loss in currency
	pnlPct: number; // profit/loss percent
	daysHeld: number;
	result: "win" | "loss" | "breakeven";
}

export interface EquityPoint {
	date: string;
	equity: number;
}

export interface BacktestMetrics {
	totalReturn: number; // percent
	annualizedReturn: number; // percent
	sharpeRatio: number;
	maxDrawdown: number; // percent
	maxDrawdownDuration: number; // days
	winRate: number; // percent
	profitFactor: number;
	avgWin: number; // currency
	avgLoss: number; // currency
	totalTrades: number;
	winningTrades: number;
	losingTrades: number;
	avgHoldingDays: number;
}

export interface BacktestResult {
	config: BacktestConfig;
	klines: KlineRow[];
	signals: Signal[];
	trades: Trade[];
	equityCurve: EquityPoint[];
	metrics: BacktestMetrics;
	elapsedMs: number;
}

export interface PoolIndustryFilterConfig {
	standard: string;
	periodDays: number;
	topIndustryCount: number;
	icPeriodDays: number;
	icThreshold: number;
}

export interface IndustryMomentumInfo {
	momentum_return: number | null;
	momentum_rank: number | null;
	has_momentum: number | null;
}

export interface PoolSizeFilterConfig {
	forwardDays: number; // size IC 预测窗口，如 5 表示 size_forward5d
	topStockCount: number; // IC 有效时只保留市值排名头部的股票
	icPeriodDays: number; // IC 滚动平均窗口
	icThreshold: number; // IC 阈值：small 方向下滚动 IC <= 阈值时启用过滤；large 方向下 >= 阈值时启用
	direction: "small" | "large"; // small=买入小市值，large=买入大市值
}

export interface PoolBacktestConfig {
	strategy: StrategyType;
	start?: string;
	end?: string;
	period?: string;
	adjust?: string;
	initialCapital?: number;
	positionSize?: number;
	fullPosition?: boolean; // 是否一直满仓
	fullPositionMode?: "add_to_holdings" | "equal_weight"; // 满仓模式：加仓到持仓 / 目标等权再平衡
	rebalanceThreshold?: number; // 等权再平衡触发阈值，如 0.05 = 偏离目标权重 5% 才调仓
	maxPositionWeight?: number; // 单个标的最大权重上限，如 0.1 = 10%。防止目标集合过小时 all-in 单只股票。默认 0.1
	minTradeAmount?: number; // 忽略小于该金额的交易，默认 0
	slippage?: number;
	commission?: number;
	maxHoldingDays?: number;
	minLot?: number;
	strategyParams?: Record<string, number>;
	industryFilter?: PoolIndustryFilterConfig;
	sizeFilter?: PoolSizeFilterConfig;
	rankBy?: "momentum" | "value" | "turnover" | "technical";
	maxPositions?: number;
}

// ─── Pool Backtest Types ──────────────────────────────────────────

export interface PoolTrade {
	code: string;
	market: number;
	direction: "buy" | "sell";
	date: string;
	price: number;
	shares: number;
	amount: number;
	pnl?: number;
	pnlPct?: number;
	daysHeld?: number;
	result?: "win" | "loss" | "breakeven";
	memo?: string;
}

export interface PoolBacktestResult {
	stocks: Array<{ code: string; market: number; name?: string }>;
	strategy: StrategyType;
	startDate: string;
	endDate: string;
	initialCapital: number;
	trades: PoolTrade[];
	equityCurve: EquityPoint[];
	metrics: BacktestMetrics;
	elapsedMs: number;
}
