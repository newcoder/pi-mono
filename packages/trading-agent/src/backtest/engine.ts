import { getDataStore } from "../data/index.js";
import type { KlineRow } from "../data/types.js";
import { computeMetrics } from "./metrics.js";
import { generateSignals } from "./strategies.js";
import type {
	BacktestConfig,
	BacktestResult,
	EquityPoint,
	PoolBacktestResult,
	PoolTrade,
	Signal,
	Trade,
} from "./types.js";

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

// ─── Pool Backtest ────────────────────────────────────────────────

export async function runPoolBacktest(
	stocks: Array<{ code: string; market: number; name?: string }>,
	config: Omit<BacktestConfig, "code" | "market">,
): Promise<PoolBacktestResult> {
	const t0 = performance.now();

	const store = getDataStore();
	if (!store) throw new Error("DataStore not initialized.");

	const initialCapital = config.initialCapital ?? 100_000;
	const slippage = config.slippage ?? 0.001;
	const commission = config.commission ?? 0.0003;
	const minLot = config.minLot ?? 100;
	const maxHoldingDays = config.maxHoldingDays ?? Infinity;

	const today = new Date().toISOString().slice(0, 10);
	const defaultEnd = config.end
		? `${config.end.slice(0, 4)}-${config.end.slice(4, 6)}-${config.end.slice(6, 8)}`
		: today;
	const defaultStart = config.start
		? `${config.start.slice(0, 4)}-${config.start.slice(4, 6)}-${config.start.slice(6, 8)}`
		: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	// 1. Load klines and generate signals for each stock
	const stockData: Array<{
		code: string;
		market: number;
		name?: string;
		klines: KlineRow[];
		signals: Signal[];
		execMap: Map<string, { type: "buy" | "sell"; price: number }>;
	}> = [];

	for (const stock of stocks) {
		const klines = await store.getKlines({
			code: stock.code,
			market: stock.market,
			period: config.period ?? "daily",
			adjust: "bfq",
			start: defaultStart,
			end: defaultEnd,
		});

		if (klines.length === 0) continue;

		// Apply adjustment factors
		const adjust = config.adjust ?? "bfq";
		let adjustedKlines = klines;
		if (adjust !== "bfq") {
			const factors = await store.getAdjustFactors(stock.code, stock.market, defaultStart, defaultEnd);
			if (factors.length > 0) {
				const factorMap = new Map<string, number>();
				let currentFactor: number | null = null;
				for (const f of factors) {
					const fac = adjust === "qfq" ? f.qfq_factor : f.hfq_factor;
					if (fac != null) currentFactor = fac;
					if (currentFactor != null) factorMap.set(f.date, currentFactor);
				}
				adjustedKlines = klines.map((k) => {
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
		}

		const signals = generateSignals(adjustedKlines, config.strategy, config.strategyParams);

		// Pre-compute execution events: signal at index i executes at index i+1 open
		const execMap = new Map<string, { type: "buy" | "sell"; price: number }>();
		for (const signal of signals) {
			const execIdx = signal.index + 1;
			if (execIdx < adjustedKlines.length) {
				const execKline = adjustedKlines[execIdx];
				if (execKline.open != null) {
					execMap.set(execKline.date, { type: signal.type, price: execKline.open });
				}
			}
		}

		stockData.push({
			code: stock.code,
			market: stock.market,
			name: stock.name,
			klines: adjustedKlines,
			signals,
			execMap,
		});
	}

	if (stockData.length === 0) {
		throw new Error("No kline data available for any stock in the pool.");
	}

	// 2. Build unified trading calendar
	const allDates = [...new Set(stockData.flatMap((s) => s.klines.map((k) => k.date)))].sort();

	// 3. Build kline lookup maps
	const klineMaps = stockData.map((s) => {
		const map = new Map<string, KlineRow>();
		for (const k of s.klines) map.set(k.date, k);
		return { code: s.code, map };
	});

	// 4. Simulation state
	let cash = initialCapital;
	const positions = new Map<
		string,
		{ shares: number; entryPrice: number; entryDate: string; daysHeld: number; lastClose: number }
	>();
	const trades: PoolTrade[] = [];
	const equityCurve: EquityPoint[] = [];

	// 5. Day-by-day simulation
	for (const date of allDates) {
		// 5.1 Compute equity at market close
		let marketValue = 0;
		for (const [code, pos] of positions) {
			const klineMap = klineMaps.find((m) => m.code === code)?.map;
			const kline = klineMap?.get(date);
			if (kline?.close != null) {
				marketValue += pos.shares * kline.close;
				pos.lastClose = kline.close;
			} else {
				marketValue += pos.shares * pos.lastClose;
			}
		}
		equityCurve.push({ date, equity: cash + marketValue });

		// 5.2 Increment holding days
		for (const pos of positions.values()) pos.daysHeld++;

		// 5.3 Sell phase (sorted by code for determinism)
		const sortedHoldings = [...positions.keys()].sort();
		for (const code of sortedHoldings) {
			const pos = positions.get(code)!;
			const stock = stockData.find((s) => s.code === code);
			if (!stock) continue;

			const exec = stock.execMap.get(date);
			if (exec?.type === "sell") {
				const sellPrice = exec.price * (1 - slippage);
				const proceeds = pos.shares * sellPrice * (1 - commission);
				const pnl = proceeds - pos.shares * pos.entryPrice;
				trades.push({
					code,
					market: stock.market,
					direction: "sell",
					date,
					price: sellPrice,
					shares: pos.shares,
					amount: pos.shares * sellPrice,
					pnl,
					pnlPct: pos.entryPrice > 0 ? (pnl / (pos.shares * pos.entryPrice)) * 100 : 0,
					daysHeld: pos.daysHeld,
					result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
					memo: "策略卖出",
				});
				cash += proceeds;
				positions.delete(code);
			}
		}

		// 5.3b Force-sell stale positions (held longer than maxHoldingDays)
		if (maxHoldingDays !== Infinity) {
			const staleCodes = [...positions.entries()]
				.filter(([, pos]) => pos.daysHeld > maxHoldingDays)
				.map(([code]) => code)
				.sort();
			for (const code of staleCodes) {
				const pos = positions.get(code)!;
				const stock = stockData.find((s) => s.code === code);
				if (!stock) continue;

				const klineMap = klineMaps.find((m) => m.code === code)?.map;
				const kline = klineMap?.get(date);
				const sellPrice = (kline?.close ?? pos.lastClose) * (1 - slippage);
				const proceeds = pos.shares * sellPrice * (1 - commission);
				const pnl = proceeds - pos.shares * pos.entryPrice;

				trades.push({
					code,
					market: stock.market,
					direction: "sell",
					date,
					price: sellPrice,
					shares: pos.shares,
					amount: pos.shares * sellPrice,
					pnl,
					pnlPct: pos.entryPrice > 0 ? (pnl / (pos.shares * pos.entryPrice)) * 100 : 0,
					daysHeld: pos.daysHeld,
					result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
					memo: `强制平仓（持仓${pos.daysHeld}天，超过${maxHoldingDays}天上限）`,
				});
				cash += proceeds;
				positions.delete(code);
			}
		}

		// 5.4 Buy phase (sorted by code for determinism)
		const sortedCandidates = stockData
			.filter((s) => !positions.has(s.code))
			.map((s) => s.code)
			.sort();
		for (const code of sortedCandidates) {
			const stock = stockData.find((s) => s.code === code);
			if (!stock) continue;

			const exec = stock.execMap.get(date);
			if (exec?.type !== "buy") continue;

			const buyPrice = exec.price * (1 + slippage);
			const maxBuyAmount = computeMaxBuyAmount(initialCapital, cash, positions.size, stockData.length);
			const rawShares = Math.floor(maxBuyAmount / buyPrice);
			const shares = Math.floor(rawShares / minLot) * minLot;

			if (shares >= minLot) {
				const cost = shares * buyPrice * (1 + commission);
				if (cost <= cash) {
					cash -= cost;
					positions.set(code, {
						shares,
						entryPrice: buyPrice,
						entryDate: date,
						daysHeld: 0,
						lastClose: buyPrice,
					});
					trades.push({
						code,
						market: stock.market,
						direction: "buy",
						date,
						price: buyPrice,
						shares,
						amount: shares * buyPrice,
						memo: "策略买入",
					});
				}
			}
		}
	}

	// 6. Compute metrics (adapt PoolTrade sells to Trade shape)
	const sellTrades: Trade[] = trades
		.filter((t) => t.direction === "sell")
		.map((t) => ({
			entryIndex: 0,
			entryDate: t.date,
			entryPrice: t.price,
			exitIndex: 0,
			exitDate: t.date,
			exitPrice: t.price,
			shares: t.shares,
			pnl: t.pnl ?? 0,
			pnlPct: t.pnlPct ?? 0,
			daysHeld: t.daysHeld ?? 0,
			result: t.result ?? "breakeven",
		}));

	const metrics = computeMetrics(sellTrades, equityCurve, initialCapital);

	return {
		stocks,
		strategy: config.strategy,
		startDate: allDates[0] ?? "",
		endDate: allDates[allDates.length - 1] ?? "",
		initialCapital,
		trades,
		equityCurve,
		metrics,
		elapsedMs: Math.round(performance.now() - t0),
	};
}

function computeMaxBuyAmount(initialCapital: number, cash: number, positionCount: number, poolSize: number): number {
	// Target: equal allocation across all stocks based on initial capital.
	// As positions accumulate, cash drops, so available cash per remaining slot
	// becomes the limiting factor. This prevents cash exhaustion while still
	// allowing large buys when cash is plentiful.
	const targetAllocation = initialCapital / poolSize;
	const remainingSlots = Math.max(1, poolSize - positionCount);
	const cashPerSlot = cash / remainingSlots;
	return Math.min(targetAllocation, cashPerSlot, cash);
}
