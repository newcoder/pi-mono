import { getDataStore } from "../data/index.js";
import type { KlineRow } from "../data/types.js";
import { computeMetrics } from "./metrics.js";
import { generateSignals } from "./strategies.js";
import type { BacktestConfig, BacktestResult, EquityPoint, Signal, Trade } from "./types.js";

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
	const t0 = performance.now();

	// 1. Load klines
	const klines = await loadKlines(config);
	if (klines.length === 0) {
		throw new Error("No kline data available for the specified stock and date range.");
	}

	// 2. Generate signals
	const signals = generateSignals(klines, config.strategy, config.strategyParams);

	// 3. Simulate trades
	const initialCapital = config.initialCapital ?? 100_000;
	const slippage = config.slippage ?? 0.001;
	const commission = config.commission ?? 0.0003;
	const maxHoldingDays = config.maxHoldingDays ?? Infinity;
	const positionSize = config.positionSize ?? 1.0;

	const trades = simulateTrades(klines, signals, initialCapital, positionSize, slippage, commission, maxHoldingDays);

	// 4. Build equity curve
	const equityCurve = buildEquityCurve(klines, trades, initialCapital);

	// 5. Compute metrics
	const metrics = computeMetrics(trades, equityCurve, initialCapital);

	return {
		config,
		klines,
		signals,
		trades,
		equityCurve,
		metrics,
		elapsedMs: Math.round(performance.now() - t0),
	};
}

async function loadKlines(config: BacktestConfig): Promise<KlineRow[]> {
	const store = getDataStore();
	if (!store) {
		throw new Error("DataStore not initialized.");
	}

	const today = new Date().toISOString().slice(0, 10);
	const defaultEnd = config.end
		? `${config.end.slice(0, 4)}-${config.end.slice(4, 6)}-${config.end.slice(6, 8)}`
		: today;
	const defaultStart = config.start
		? `${config.start.slice(0, 4)}-${config.start.slice(4, 6)}-${config.start.slice(6, 8)}`
		: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	// Always load bfq (unadjusted) klines from DB; apply factors on-the-fly
	const klines = await store.getKlines({
		code: config.code,
		market: config.market,
		period: config.period ?? "daily",
		adjust: "bfq",
		start: defaultStart,
		end: defaultEnd,
	});

	const adjust = config.adjust ?? "bfq";
	if (adjust === "bfq" || klines.length === 0) {
		return klines;
	}

	// Load adjustment factors for the requested date range
	const factors = await store.getAdjustFactors(config.code, config.market, defaultStart, defaultEnd);
	if (factors.length === 0) {
		console.warn(`[backtest] No adjustment factors found for ${config.code}, falling back to bfq`);
		return klines;
	}

	// Build a date -> factor lookup with forward-fill for missing dates
	const factorMap = new Map<string, number>();
	let currentFactor: number | null = null;
	for (const f of factors) {
		const fac = adjust === "qfq" ? f.qfq_factor : f.hfq_factor;
		if (fac != null) {
			currentFactor = fac;
		}
		if (currentFactor != null) {
			factorMap.set(f.date, currentFactor);
		}
	}

	// Apply factors to each kline row
	return klines.map((k) => {
		const fac = factorMap.get(k.date);
		if (fac == null) return k;
		return {
			...k,
			open: k.open != null ? round(k.open * fac) : null,
			high: k.high != null ? round(k.high * fac) : null,
			low: k.low != null ? round(k.low * fac) : null,
			close: k.close != null ? round(k.close * fac) : null,
			pre_close: k.pre_close != null ? round(k.pre_close * fac) : null,
		};
	});
}

function round(v: number, digits = 4): number {
	const mult = 10 ** digits;
	return Math.round(v * mult) / mult;
}

function simulateTrades(
	klines: KlineRow[],
	signals: Signal[],
	initialCapital: number,
	positionSize: number,
	slippage: number,
	commission: number,
	maxHoldingDays: number,
): Trade[] {
	const trades: Trade[] = [];
	let capital = initialCapital;
	let entryIndex = -1;
	let entryPrice = 0;
	let shares = 0;

	for (const signal of signals) {
		if (signal.type === "buy" && entryIndex < 0) {
			// Enter position at next-day open (avoid look-ahead bias)
			const nextDay = klines[signal.index + 1];
			if (!nextDay || nextDay.open == null) continue;

			entryPrice = nextDay.open * (1 + slippage);
			const tradeCapital = capital * positionSize;
			shares = Math.floor(tradeCapital / entryPrice);
			if (shares <= 0) continue;

			const cost = shares * entryPrice * (1 + commission);
			capital -= cost;
			entryIndex = signal.index + 1;
		} else if (signal.type === "sell" && entryIndex >= 0) {
			const nextDay = klines[signal.index + 1];
			if (!nextDay || nextDay.open == null) continue;

			const exitPrice = nextDay.open * (1 - slippage);
			const proceeds = shares * exitPrice * (1 - commission);
			const pnl = proceeds - shares * entryPrice;
			const pnlPct = entryPrice > 0 ? (pnl / (shares * entryPrice)) * 100 : 0;
			const daysHeld = signal.index + 1 - entryIndex;

			trades.push({
				entryIndex,
				entryDate: klines[entryIndex].date,
				entryPrice,
				exitIndex: signal.index + 1,
				exitDate: nextDay.date,
				exitPrice,
				shares,
				pnl,
				pnlPct,
				daysHeld,
				result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
			});

			capital += proceeds;
			entryIndex = -1;
			shares = 0;
		}
	}

	// Force-close any open position at the end
	if (entryIndex >= 0 && shares > 0) {
		const lastDay = klines[klines.length - 1];
		if (lastDay && lastDay.close != null) {
			const exitPrice = lastDay.close * (1 - slippage);
			const proceeds = shares * exitPrice * (1 - commission);
			const pnl = proceeds - shares * entryPrice;
			const pnlPct = entryPrice > 0 ? (pnl / (shares * entryPrice)) * 100 : 0;
			const daysHeld = klines.length - 1 - entryIndex;

			// Skip if held too long and not explicitly signaled
			if (daysHeld <= maxHoldingDays) {
				trades.push({
					entryIndex,
					entryDate: klines[entryIndex].date,
					entryPrice,
					exitIndex: klines.length - 1,
					exitDate: lastDay.date,
					exitPrice,
					shares,
					pnl,
					pnlPct,
					daysHeld,
					result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
				});
				capital += proceeds;
			}
		}
	}

	return trades;
}

function buildEquityCurve(klines: KlineRow[], trades: Trade[], initialCapital: number): EquityPoint[] {
	const equity: EquityPoint[] = [];
	let currentCapital = initialCapital;
	let tradeIdx = 0;

	for (let i = 0; i < klines.length; i++) {
		// Apply any trades that close on this day
		while (tradeIdx < trades.length && trades[tradeIdx].exitIndex <= i) {
			currentCapital += trades[tradeIdx].pnl;
			tradeIdx++;
		}
		equity.push({ date: klines[i].date, equity: currentCapital });
	}

	return equity;
}
