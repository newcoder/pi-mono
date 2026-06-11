import type { KlineRow } from "../data/types.js";

export type StrategyType = "ma_cross" | "macd_cross" | "rsi_reversal" | "bollinger_breakout";

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
