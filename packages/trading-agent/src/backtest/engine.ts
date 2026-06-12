import { getDataStore } from "../data/index.js";
import type { KlineRow } from "../data/types.js";
import { computeMetrics } from "./metrics.js";
import { generateSignals } from "./strategies.js";
import type {
	BacktestConfig,
	BacktestResult,
	EquityPoint,
	PoolBacktestConfig,
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

	const { trades, equityCurve } = simulateTrades(
		klines,
		signals,
		initialCapital,
		positionSize,
		slippage,
		commission,
		maxHoldingDays,
	);

	// 4. Compute metrics
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
): { trades: Trade[]; equityCurve: EquityPoint[] } {
	const trades: Trade[] = [];
	const equityCurve: EquityPoint[] = [];
	let capital = initialCapital;
	let entryIndex = -1;
	let entryPrice = 0;
	let shares = 0;
	let signalIdx = 0;

	for (let i = 0; i < klines.length; i++) {
		// Execute signals whose trading day is today (signal at index i-1 executes at index i)
		while (signalIdx < signals.length) {
			const signal = signals[signalIdx];
			const execIdx = signal.index + 1;
			if (execIdx > i) break;
			if (execIdx < i) {
				signalIdx++;
				continue;
			}

			if (signal.type === "buy" && entryIndex < 0) {
				const execKline = klines[execIdx];
				if (!execKline || execKline.open == null) {
					signalIdx++;
					continue;
				}

				entryPrice = execKline.open * (1 + slippage);
				const tradeCapital = capital * positionSize;
				const newShares = Math.floor(tradeCapital / entryPrice);
				if (newShares <= 0) {
					signalIdx++;
					continue;
				}

				const cost = newShares * entryPrice * (1 + commission);
				capital -= cost;
				shares = newShares;
				entryIndex = execIdx;
			} else if (signal.type === "sell" && entryIndex >= 0) {
				const execKline = klines[execIdx];
				if (!execKline || execKline.open == null) {
					signalIdx++;
					continue;
				}

				const exitPrice = execKline.open * (1 - slippage);
				const proceeds = shares * exitPrice * (1 - commission);
				const pnl = proceeds - shares * entryPrice;
				const pnlPct = entryPrice > 0 ? (pnl / (shares * entryPrice)) * 100 : 0;
				const daysHeld = execIdx - entryIndex;

				trades.push({
					entryIndex,
					entryDate: klines[entryIndex].date,
					entryPrice,
					exitIndex: execIdx,
					exitDate: execKline.date,
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
			signalIdx++;
		}

		// Mark position to market at today's close
		const close = klines[i].close ?? 0;
		equityCurve.push({ date: klines[i].date, equity: capital + shares * close });
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
				// Update final equity point to reflect force-close cash
				if (equityCurve.length > 0) {
					equityCurve[equityCurve.length - 1].equity = capital;
				}
			}
		}
	}

	return { trades, equityCurve };
}

// ─── Pool Backtest ────────────────────────────────────────────────

export async function runPoolBacktest(
	stocks: Array<{ code: string; market: number; name?: string }>,
	config: PoolBacktestConfig,
): Promise<PoolBacktestResult> {
	const t0 = performance.now();

	const store = getDataStore();
	if (!store) throw new Error("DataStore not initialized.");

	const initialCapital = config.initialCapital ?? 100_000;
	const slippage = config.slippage ?? 0.001;
	const commission = config.commission ?? 0.0003;
	const minLot = config.minLot ?? 100;
	const maxHoldingDays = config.maxHoldingDays ?? Infinity;
	const fullPosition = config.fullPosition ?? false;
	const fullPositionMode = config.fullPositionMode ?? "add_to_holdings";
	const rebalanceThreshold = config.rebalanceThreshold ?? 0;
	const minTradeAmount = config.minTradeAmount ?? 0;

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
		// 5.1 Increment holding days
		for (const pos of positions.values()) pos.daysHeld++;

		// 5.2 Sell phase (sorted by code for determinism)
		const sortedHoldings = [...positions.keys()].sort();
		for (const code of sortedHoldings) {
			const pos = positions.get(code)!;
			const stock = stockData.find((s) => s.code === code);
			if (!stock) continue;

			const exec = stock.execMap.get(date);
			if (exec?.type === "sell") {
				const sellPrice = exec.price * (1 - slippage);
				const sellAmount = pos.shares * sellPrice;
				if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
					continue;
				}
				const proceeds = sellAmount * (1 - commission);
				const pnl = proceeds - pos.shares * pos.entryPrice;
				trades.push({
					code,
					market: stock.market,
					direction: "sell",
					date,
					price: sellPrice,
					shares: pos.shares,
					amount: sellAmount,
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

		// 5.2b Force-sell stale positions (held longer than maxHoldingDays)
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

		// 5.3 Buy phase (sorted by code for determinism)
		const sortedCandidates = stockData
			.filter((s) => !positions.has(s.code))
			.map((s) => s.code)
			.sort();

		if (!fullPosition || fullPositionMode !== "equal_weight") {
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
					const amount = shares * buyPrice;
					if (!isTradeAmountValid(amount, minTradeAmount)) {
						continue;
					}
					const cost = amount * (1 + commission);
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
							amount,
							memo: "策略买入",
						});
					}
				}
			}
		}

		// 5.3b Full-position rebalance
		if (fullPosition) {
			if (fullPositionMode === "add_to_holdings") {
				// Distribute remaining cash equally across held positions
				if (positions.size > 0 && cash > 0) {
					const heldCodes = [...positions.keys()].sort();
					let remaining = heldCodes.length;
					for (const code of heldCodes) {
						const pos = positions.get(code)!;
						const stock = stockData.find((s) => s.code === code);
						if (!stock) {
							remaining--;
							continue;
						}

						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						const buyPrice = (kline?.open ?? pos.lastClose) * (1 + slippage);
						const cashPerStock = cash / remaining;
						const rawShares = Math.floor(cashPerStock / buyPrice);
						const shares = Math.floor(rawShares / minLot) * minLot;

						if (shares >= minLot) {
							const amount = shares * buyPrice;
							if (!isTradeAmountValid(amount, minTradeAmount)) {
								remaining--;
								continue;
							}
							const cost = amount * (1 + commission);
							if (cost <= cash) {
								cash -= cost;
								const totalCost = pos.entryPrice * pos.shares + amount;
								pos.shares += shares;
								pos.entryPrice = totalCost / pos.shares;
								trades.push({
									code,
									market: stock.market,
									direction: "buy",
									date,
									price: buyPrice,
									shares,
									amount,
									memo: "满仓加仓",
								});
							}
						}
						remaining--;
					}
				}
			} else if (fullPositionMode === "equal_weight") {
				// Target equal-weight rebalancing among holdings + today's buy candidates
				const targetCodes = new Set<string>([...positions.keys()]);
				for (const code of sortedCandidates) {
					const stock = stockData.find((s) => s.code === code);
					if (!stock) continue;
					if (stock.execMap.get(date)?.type === "buy") targetCodes.add(code);
				}

				if (targetCodes.size > 0) {
					// Total portfolio value at today's open (use ask-side price for consistency)
					let totalValue = cash;
					for (const code of targetCodes) {
						const pos = positions.get(code);
						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						const price = (kline?.open ?? pos?.lastClose ?? 0) * (1 + slippage);
						if (pos && price > 0) totalValue += pos.shares * price;
					}

					const targetValue = totalValue / targetCodes.size;

					// Sell overweight positions first (partial sells allowed)
					for (const code of [...targetCodes].sort()) {
						const pos = positions.get(code);
						if (!pos) continue;

						const stock = stockData.find((s) => s.code === code);
						if (!stock) continue;

						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						const sellPrice = (kline?.open ?? pos.lastClose) * (1 - slippage);
						const currentValue = pos.shares * sellPrice;
						if (currentValue <= targetValue) continue;

						const excessValue = currentValue - targetValue;
						if (excessValue <= targetValue * rebalanceThreshold) continue;

						const rawShares = Math.floor(excessValue / sellPrice);
						const shares = Math.floor(rawShares / minLot) * minLot;

						if (shares >= minLot && shares < pos.shares) {
							const sellAmount = shares * sellPrice;
							if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
								continue;
							}
							const proceeds = sellAmount * (1 - commission);
							const pnl = proceeds - shares * pos.entryPrice;
							trades.push({
								code,
								market: stock.market,
								direction: "sell",
								date,
								price: sellPrice,
								shares,
								amount: sellAmount,
								pnl,
								pnlPct: pos.entryPrice > 0 ? (pnl / (shares * pos.entryPrice)) * 100 : 0,
								daysHeld: pos.daysHeld,
								result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
								memo: "等权再平衡减仓",
							});
							cash += proceeds;
							pos.shares -= shares;
							if (pos.shares <= 0) positions.delete(code);
						}
					}

					// Buy underweight positions
					for (const code of [...targetCodes].sort()) {
						const pos = positions.get(code);
						const stock = stockData.find((s) => s.code === code);
						if (!stock) continue;

						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						const buyPrice = (kline?.open ?? pos?.lastClose ?? 0) * (1 + slippage);
						if (buyPrice <= 0) continue;

						const currentValue = pos ? pos.shares * buyPrice : 0;
						const deficitValue = targetValue - currentValue;
						if (deficitValue <= targetValue * rebalanceThreshold) continue;

						const rawShares = Math.floor(deficitValue / buyPrice);
						const shares = Math.floor(rawShares / minLot) * minLot;

						if (shares >= minLot) {
							const amount = shares * buyPrice;
							if (!isTradeAmountValid(amount, minTradeAmount)) {
								continue;
							}
							const cost = amount * (1 + commission);
							if (cost <= cash) {
								cash -= cost;
								if (pos) {
									const totalCost = pos.entryPrice * pos.shares + amount;
									pos.shares += shares;
									pos.entryPrice = totalCost / pos.shares;
								} else {
									positions.set(code, {
										shares,
										entryPrice: buyPrice,
										entryDate: date,
										daysHeld: 0,
										lastClose: buyPrice,
									});
								}
								trades.push({
									code,
									market: stock.market,
									direction: "buy",
									date,
									price: buyPrice,
									shares,
									amount,
									memo: "等权再平衡买入",
								});
							}
						}
					}
				}
			}
		}

		// 5.4 Compute equity at market close after all trades
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

function isTradeAmountValid(amount: number, minAmount: number): boolean {
	return minAmount <= 0 || amount >= minAmount;
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
