import { getDataStore } from "../data/index.js";
import type { KlineRow } from "../data/types.js";
import { computeMetrics } from "./metrics.js";
import { generateSignals } from "./strategies.js";
import type {
	BacktestConfig,
	BacktestResult,
	EquityPoint,
	IndustryMomentumInfo,
	PoolBacktestConfig,
	PoolBacktestResult,
	PoolIndustryFilterConfig,
	PoolSizeFilterConfig,
	PoolTrade,
	Signal,
	StrategyType,
	Trade,
} from "./types.js";

function sortSignals(signals: Signal[]): Signal[] {
	const copy = [...signals];
	copy.sort((a, b) => {
		if (a.index !== b.index) return a.index - b.index;
		// Within the same candle, process buys before sells to avoid same-day churn
		return a.type === "buy" ? -1 : 1;
	});
	return copy;
}

function resolveStrategyLabel(
	config: Pick<BacktestConfig, "strategy" | "buyStrategies" | "sellStrategies">,
): StrategyType {
	return config.strategy ?? config.buyStrategies?.[0]?.strategy ?? config.sellStrategies?.[0]?.strategy ?? "ma_cross";
}

export function generateAllSignals(
	klines: KlineRow[],
	config: Pick<
		BacktestConfig,
		"strategy" | "exitStrategy" | "buyStrategies" | "sellStrategies" | "strategyParams" | "exitStrategyParams"
	>,
): Signal[] {
	const hasNewStyle = (config.buyStrategies?.length ?? 0) > 0 || (config.sellStrategies?.length ?? 0) > 0;

	const buys: Signal[] = [];
	const sells: Signal[] = [];

	if (hasNewStyle) {
		for (const source of config.buyStrategies ?? []) {
			const sigs = generateSignals(klines, source.strategy, source.params);
			buys.push(...sigs.filter((s) => s.type === "buy"));
		}
		for (const source of config.sellStrategies ?? []) {
			const sigs = generateSignals(klines, source.strategy, source.params);
			sells.push(...sigs.filter((s) => s.type === "sell"));
		}
	}

	// Legacy fields always contribute if present
	if (config.strategy) {
		const legacy = generateSignals(klines, config.strategy, config.strategyParams);
		buys.push(...legacy.filter((s) => s.type === "buy"));
		// Legacy strategy's sell signals are included unless new-style sell list is explicitly provided
		if (!hasNewStyle) {
			sells.push(...legacy.filter((s) => s.type === "sell"));
		}
	}
	if (config.exitStrategy) {
		const extra = generateSignals(klines, config.exitStrategy, config.exitStrategyParams);
		sells.push(...extra.filter((s) => s.type === "sell"));
	}

	return sortSignals([...buys, ...sells]);
}

function localDateString(d = new Date()): string {
	return d.toLocaleDateString("sv-SE");
}

/** Check if a kline is at limit-up (cannot buy). Covers all A-share boards (10/20/30%). */
function isLimitUp(kline: KlineRow): boolean {
	const chg = kline.change_pct;
	if (chg == null) return false;
	// Boards: main ±10%, ChiNext/STAR ±20%, Beijing ±30%. 0.5% tolerance for rounding.
	return Math.abs(chg - 10) < 0.5 || Math.abs(chg - 20) < 0.5 || Math.abs(chg - 30) < 0.5;
}

/** Check if a kline is at limit-down (cannot sell). */
function isLimitDown(kline: KlineRow): boolean {
	const chg = kline.change_pct;
	if (chg == null) return false;
	return Math.abs(chg + 10) < 0.5 || Math.abs(chg + 20) < 0.5 || Math.abs(chg + 30) < 0.5;
}

function getISOWeek(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const date = new Date(y, m - 1, d);
	const day = date.getDay() || 7;
	date.setDate(date.getDate() + 4 - day);
	const yearStart = new Date(date.getFullYear(), 0, 1);
	const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${date.getFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function buildWeeklyCloses(klines: KlineRow[]): Array<{ endDate: string; close: number }> {
	const weekMap = new Map<string, { endDate: string; close: number }>();
	for (const k of klines) {
		if (k.close == null) continue;
		const week = getISOWeek(k.date);
		const existing = weekMap.get(week);
		if (!existing || k.date > existing.endDate) {
			weekMap.set(week, { endDate: k.date, close: k.close });
		}
	}
	return [...weekMap.values()].sort((a, b) => a.endDate.localeCompare(b.endDate));
}

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
	const t0 = performance.now();

	// 1. Load klines
	const klines = await loadKlines(config);
	if (klines.length === 0) {
		throw new Error("No kline data available for the specified stock and date range.");
	}

	// 2. Generate signals (legacy strategy / exitStrategy + new buy/sell strategy lists)
	const signals = generateAllSignals(klines, config);

	// 3. Simulate trades
	const initialCapital = config.initialCapital ?? 100_000;
	const slippage = config.slippage ?? 0.001;
	const commission = config.commission ?? 0.0003;
	const positionSize = config.positionSize ?? 1.0;
	const minLot = config.minLot ?? 100;

	const { trades, equityCurve } = simulateTrades(
		klines,
		signals,
		initialCapital,
		positionSize,
		slippage,
		commission,
		minLot,
	);

	// 4. Compute metrics
	const metrics = computeMetrics(trades, equityCurve, initialCapital, config.period);

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

	const today = localDateString();
	const defaultEnd = config.end
		? `${config.end.slice(0, 4)}-${config.end.slice(4, 6)}-${config.end.slice(6, 8)}`
		: today;
	const defaultStart = config.start
		? `${config.start.slice(0, 4)}-${config.start.slice(4, 6)}-${config.start.slice(6, 8)}`
		: localDateString(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));

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

export function simulateTrades(
	klines: KlineRow[],
	signals: Signal[],
	initialCapital: number,
	positionSize: number,
	slippage: number,
	commission: number,
	minLot: number,
): { trades: Trade[]; equityCurve: EquityPoint[] } {
	const trades: Trade[] = [];
	const equityCurve: EquityPoint[] = [];
	let capital = initialCapital;
	let entryIndex = -1;
	let entryPrice = 0;
	let shares = 0;
	let signalIdx = 0;
	let lastClose = 0;

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
				// Skip buy if at limit-up (cannot buy涨停)
				if (isLimitUp(execKline)) {
					signalIdx++;
					continue;
				}

				entryPrice = execKline.open * (1 + slippage);
				const tradeCapital = capital * positionSize;
				const rawShares = Math.floor(tradeCapital / entryPrice);
				const newShares = Math.floor(rawShares / minLot) * minLot;
				if (newShares < minLot) {
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
				// Skip sell if at limit-down (cannot sell跌停)
				if (isLimitDown(execKline)) {
					signalIdx++;
					continue;
				}

				const exitPrice = execKline.open * (1 - slippage);
				const proceeds = shares * exitPrice * (1 - commission);
				const costBasis = shares * entryPrice * (1 + commission);
				const pnl = proceeds - costBasis;
				const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
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
		const closeValue = klines[i].close;
		const close = closeValue ?? lastClose;
		if (closeValue != null) {
			lastClose = closeValue;
		}
		equityCurve.push({ date: klines[i].date, equity: capital + shares * close });
	}

	// Force-close any open position at the end (use open like regular signal exits)
	if (entryIndex >= 0 && shares > 0) {
		const lastDay = klines[klines.length - 1];
		if (lastDay && (lastDay.open != null || lastDay.close != null)) {
			const exitPrice = (lastDay.open ?? lastDay.close!) * (1 - slippage);
			const proceeds = shares * exitPrice * (1 - commission);
			const costBasis = shares * entryPrice * (1 + commission);
			const pnl = proceeds - costBasis;
			const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
			const daysHeld = klines.length - 1 - entryIndex;

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
			shares = 0;
			// Update final equity point to reflect force-close cash
			if (equityCurve.length > 0) {
				equityCurve[equityCurve.length - 1].equity = capital;
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
	const randomRuns = config.randomRuns ?? 1;

	// Multi-run aggregation for random selection
	if (config.rankBy === "random" && randomRuns > 1) {
		const runs: PoolBacktestResult[] = [];
		for (let i = 0; i < randomRuns; i++) {
			runs.push(await runPoolBacktest(stocks, { ...config, randomRuns: 1 }));
		}
		const valid = runs.filter((r) => r.metrics.totalTrades > 0);
		if (valid.length === 0) return runs[0];

		const allTrades = valid.flatMap((r) => r.trades);
		const maxEqLen = Math.max(...valid.map((r) => r.equityCurve.length));
		const aggEquity: EquityPoint[] = [];
		for (let d = 0; d < maxEqLen; d++) {
			const vals = valid.map((r) => r.equityCurve[d]?.equity).filter((e): e is number => e != null);
			if (vals.length >= valid.length / 2) {
				aggEquity.push({
					date: valid[0].equityCurve[Math.min(d, valid[0].equityCurve.length - 1)].date,
					equity: vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)],
				});
			}
		}
		const sellTrades = allTrades.filter((t) => t.direction === "sell" && t.pnl != null);
		const tradeObjs = sellTrades.map((t) => ({
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
			result: (t.result ?? "breakeven") as "win" | "loss" | "breakeven",
		}));
		const aggMetrics = computeMetrics(tradeObjs, aggEquity, initialCapital, config.period);

		return {
			stocks,
			strategy: resolveStrategyLabel(config),
			startDate: valid[0].startDate,
			endDate: valid[0].endDate,
			initialCapital,
			trades: allTrades,
			equityCurve: aggEquity,
			metrics: aggMetrics,
			elapsedMs: Math.round(performance.now() - t0),
		};
	}

	const slippage = config.slippage ?? 0.001;
	const commission = config.commission ?? 0.0003;
	const minLot = config.minLot ?? 100;
	const maxHoldingDays = config.maxHoldingDays ?? Infinity;
	const fullPosition = config.fullPosition ?? true;
	const fullPositionMode = config.fullPositionMode ?? "equal_weight";
	const rebalanceThreshold = config.rebalanceThreshold ?? 0;
	const minTradeAmount = config.minTradeAmount ?? 0;
	const maxPositionWeight = config.maxPositionWeight ?? 0.1; // 单个标的最大权重，默认 10%

	const today = localDateString();
	const defaultEnd = config.end
		? `${config.end.slice(0, 4)}-${config.end.slice(4, 6)}-${config.end.slice(6, 8)}`
		: today;
	const defaultStart = config.start
		? `${config.start.slice(0, 4)}-${config.start.slice(4, 6)}-${config.start.slice(6, 8)}`
		: localDateString(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));

	// 1. Load klines and generate signals for each stock
	const stockData: Array<{
		code: string;
		market: number;
		name?: string;
		klines: KlineRow[];
		signals: Signal[];
		execMap: Map<string, { type: "buy" | "sell"; price: number; signalDate: string }>;
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

		const signals = generateAllSignals(adjustedKlines, config);

		// Pre-compute execution events: signal at index i executes at index i+1 open
		const execMap = new Map<string, { type: "buy" | "sell"; price: number; signalDate: string }>();
		for (const signal of signals) {
			const execIdx = signal.index + 1;
			if (execIdx < adjustedKlines.length) {
				const execKline = adjustedKlines[execIdx];
				const signalKline = adjustedKlines[signal.index];
				if (execKline.open != null && signalKline != null) {
					execMap.set(execKline.date, {
						type: signal.type,
						price: execKline.open,
						signalDate: signalKline.date,
					});
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
	const dateIndex = new Map<string, number>(allDates.map((d, i) => [d, i]));

	// 3. Build kline lookup maps
	const klineMaps = stockData.map((s) => {
		const map = new Map<string, KlineRow>();
		for (const k of s.klines) map.set(k.date, k);
		return { code: s.code, map };
	});

	// 3a. Build weekly close series for weekly MA ranking
	const weeklyCloseSeries = new Map<string, Array<{ endDate: string; close: number }>>();
	for (const s of stockData) {
		weeklyCloseSeries.set(s.code, buildWeeklyCloses(s.klines));
	}

	// 3b. Load optional industry momentum filter data
	type IndustryFilterContext = PoolIndustryFilterConfig & {
		stockIndustry: Map<string, string>;
		industryMomentum: Map<string, IndustryMomentumInfo>;
		rollingIc: Map<string, number>;
	};

	async function buildIndustryFilterContext(
		filter: PoolIndustryFilterConfig | undefined,
	): Promise<IndustryFilterContext | undefined> {
		if (!filter) return undefined;

		const stockIndustry = new Map<string, string>();
		for (const s of stockData) {
			const industries = await store!.getStockIndustries(s.code, s.market);
			const match = industries.find((i) => i.standard === filter.standard);
			if (match) stockIndustry.set(`${s.code}_${s.market}`, match.industry_code);
		}

		const industryMomentum = new Map<string, IndustryMomentumInfo>();
		const uniqueIndustries = [...new Set(stockIndustry.values())];
		for (const indCode of uniqueIndustries) {
			const rows = await store!.getIndustryIndicators(indCode, filter.periodDays, defaultStart, defaultEnd);
			for (const r of rows) {
				industryMomentum.set(`${indCode}_${r.date}`, {
					momentum_return: r.momentum_return ?? null,
					momentum_rank: r.momentum_rank ?? null,
					has_momentum: r.has_momentum ?? null,
				});
			}
		}

		const rollingIc = new Map<string, number>();
		const factorName = `${filter.standard}_eq_weight_momentum_${filter.periodDays}d_forward5d`;
		const icRows = await store!.getFactorIc(factorName, defaultStart, defaultEnd);
		if (icRows.length > 0) {
			const sorted = icRows.sort((a, b) => a.date.localeCompare(b.date));
			const values = sorted.map((r) => r.ic_value ?? 0);
			for (let i = 0; i < sorted.length; i++) {
				const start = Math.max(0, i - filter.icPeriodDays + 1);
				const slice = values.slice(start, i + 1);
				const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
				rollingIc.set(sorted[i].date, avg);
			}
		}

		return { ...filter, stockIndustry, industryMomentum, rollingIc };
	}

	function passesIndustryFilter(
		stock: (typeof stockData)[number],
		exec: { type: "buy" | "sell"; price: number; signalDate: string } | undefined,
		filter: IndustryFilterContext | undefined,
	): boolean {
		if (!filter || !exec) return true;

		const rollingIc = filter.rollingIc.get(exec.signalDate);
		if (rollingIc == null || Number.isNaN(rollingIc) || rollingIc <= filter.icThreshold) return true;

		const industryCode = filter.stockIndustry.get(`${stock.code}_${stock.market}`);
		if (!industryCode) return true;

		const mom = filter.industryMomentum.get(`${industryCode}_${exec.signalDate}`);
		if (!mom || mom.momentum_rank == null) return false;

		return mom.momentum_rank <= filter.topIndustryCount;
	}

	const industryFilter = await buildIndustryFilterContext(config.industryFilter);

	// 3c. Load optional size factor filter data
	type SizeFilterContext = PoolSizeFilterConfig & {
		stockSize: Map<string, number>;
		maxRankByDate: Map<string, number>;
		rollingIc: Map<string, number>;
	};

	async function buildSizeFilterContext(
		filter: PoolSizeFilterConfig | undefined,
	): Promise<SizeFilterContext | undefined> {
		if (!filter) return undefined;

		const stockSize = new Map<string, number>();
		const maxRankByDate = new Map<string, number>();
		for (const s of stockData) {
			const rows = await store!.getStockIndicators(s.code, s.market, "size_mcap", defaultStart, defaultEnd);
			for (const r of rows) {
				if (r.indicator_rank == null) continue;
				const key = `${s.code}_${s.market}_${r.date}`;
				stockSize.set(key, r.indicator_rank);
				const prevMax = maxRankByDate.get(r.date) ?? 0;
				if (r.indicator_rank > prevMax) {
					maxRankByDate.set(r.date, r.indicator_rank);
				}
			}
		}

		const rollingIc = new Map<string, number>();
		const factorName = `size_forward${filter.forwardDays}d`;
		const icRows = await store!.getFactorIc(factorName, defaultStart, defaultEnd);
		if (icRows.length > 0) {
			const sorted = icRows.sort((a, b) => a.date.localeCompare(b.date));
			const values = sorted.map((r) => r.ic_value ?? 0);
			for (let i = 0; i < sorted.length; i++) {
				const start = Math.max(0, i - filter.icPeriodDays + 1);
				const slice = values.slice(start, i + 1);
				const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
				rollingIc.set(sorted[i].date, avg);
			}
		}

		return { ...filter, stockSize, maxRankByDate, rollingIc };
	}

	function passesSizeFilter(
		stock: (typeof stockData)[number],
		exec: { type: "buy" | "sell"; price: number; signalDate: string } | undefined,
		filter: SizeFilterContext | undefined,
	): boolean {
		if (!filter || !exec) return true;

		const rollingIc = filter.rollingIc.get(exec.signalDate);
		if (rollingIc == null || Number.isNaN(rollingIc)) return true;

		// Determine whether size factor is "active" based on direction and threshold
		if (filter.direction === "small") {
			if (rollingIc > filter.icThreshold) return true;
		} else {
			if (rollingIc < filter.icThreshold) return true;
		}

		const rank = filter.stockSize.get(`${stock.code}_${stock.market}_${exec.signalDate}`);
		if (rank == null) return true;

		if (filter.direction === "small") {
			return rank <= filter.topStockCount;
		}

		const maxRank = filter.maxRankByDate.get(exec.signalDate);
		if (maxRank == null) return false;
		return rank >= maxRank - filter.topStockCount + 1;
	}

	const sizeFilter = await buildSizeFilterContext(config.sizeFilter);

	// 3d. Secondary ranking scorer for holdings selection.
	// scoreDate must be a date whose close data is already known at decision time
	// (e.g. the signal date for new candidates, or the previous trading day for
	// existing positions). Do not pass the execution date to avoid lookahead bias.
	function computeRankScore(
		stock: (typeof stockData)[number],
		klineMaps: Array<{ code: string; map: Map<string, KlineRow> }>,
		scoreDate: string,
		rankBy?: PoolBacktestConfig["rankBy"],
		recencyDays?: number,
	): number {
		if (!rankBy) return 0;

		const klineMap = klineMaps.find((m) => m.code === stock.code)?.map;
		const kline = klineMap?.get(scoreDate);
		if (!kline) return 0;

		switch (rankBy) {
			case "momentum":
				// Latest change_pct — higher is better for momentum/trend strategies
				return kline.change_pct ?? 0;
			case "value": {
				// Approximate PE from latest close — lower PE = higher score (inverted)
				// If change_pct and pre_close available: price = pre_close * (1 + change_pct/100)
				const change = kline.change_pct ?? 0;
				const preClose = kline.pre_close ?? kline.close ?? 0;
				const price = preClose > 0 ? preClose * (1 + change / 100) : (kline.close ?? 0);
				// Invert: lower price = higher score (cheap stocks preferred)
				return price > 0 ? 1 / price : 0;
			}
			case "turnover": {
				// Higher turnover = more active = higher score.
				// Turnover is stored as amount in currency (often billions), so use log scale
				// to compress the wide range into a comparable 0-12 range.
				const raw = kline.turnover ?? kline.volume ?? 0;
				return Math.log10(raw + 1);
			}
			case "technical": {
				// Composite: trend + momentum + volume + volatility.
				// Use change_pct for momentum and log-scaled turnover for activity.
				const chg = kline.change_pct ?? 0;
				const to = Math.log10((kline.turnover ?? 0) + 1);
				return chg * 0.5 + to * 0.5;
			}
			case "low_volatility": {
				// Lower recent return volatility = higher score. Use percentage returns
				// over the lookback window ending at scoreDate to make it comparable across stocks.
				const idx = dateIndex.get(scoreDate);
				if (idx == null) return 0;
				const lookback = config.volatilityLookbackDays ?? 5;
				const startIdx = Math.max(0, idx - lookback + 1);
				const closes: number[] = [];
				for (let i = startIdx; i <= idx; i++) {
					const k = klineMap?.get(allDates[i]);
					if (k?.close != null) closes.push(k.close);
				}
				if (closes.length < 2) return 0;
				const returns: number[] = [];
				for (let i = 1; i < closes.length; i++) {
					if (closes[i - 1] > 0) returns.push((closes[i] / closes[i - 1] - 1) * 100);
				}
				if (returns.length < 2) return 0;
				const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
				const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
				return -Math.sqrt(variance);
			}
			case "signal_recency":
				// More recent signal / position = higher score (lower days = higher).
				return recencyDays != null ? -recencyDays : 0;
			case "ma_alignment": {
				// Bullish alignment strength: 10/20/60 MA, price on top.
				// Score = (close/MA10 - 1) + (MA10/MA20 - 1) + (MA20/MA60 - 1).
				// Higher = more strongly aligned; negative = bearish / no alignment.
				const idx = dateIndex.get(scoreDate);
				if (idx == null) return 0;
				const needed = 60;
				const startIdx = Math.max(0, idx - needed + 1);
				const closes: number[] = [];
				for (let i = startIdx; i <= idx; i++) {
					const k = klineMap?.get(allDates[i]);
					if (k?.close != null) closes.push(k.close);
				}
				if (closes.length < needed) return 0;
				const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
				const ma10 = avg(closes.slice(-10));
				const ma20 = avg(closes.slice(-20));
				const ma60 = avg(closes.slice(-60));
				if (ma10 <= 0 || ma20 <= 0 || ma60 <= 0) return 0;
				const close = closes[closes.length - 1];
				return close / ma10 - 1 + (ma10 / ma20 - 1) + (ma20 / ma60 - 1);
			}
			case "weekly_ma_alignment": {
				// Bullish alignment strength on weekly closes: 5/10/20 week MA.
				// Score = (close/WMA5 - 1) + (WMA5/WMA10 - 1) + (WMA10/WMA20 - 1).
				const series = weeklyCloseSeries.get(stock.code);
				if (!series || series.length === 0) return 0;
				let idx = -1;
				for (let i = 0; i < series.length; i++) {
					if (series[i].endDate <= scoreDate) idx = i;
					else break;
				}
				if (idx < 0) return 0;
				const needed = 20;
				if (idx + 1 < needed) return 0;
				const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
				const closes = series.slice(0, idx + 1).map((s) => s.close);
				const wma5 = avg(closes.slice(-5));
				const wma10 = avg(closes.slice(-10));
				const wma20 = avg(closes.slice(-20));
				if (wma5 <= 0 || wma10 <= 0 || wma20 <= 0) return 0;
				const close = closes[closes.length - 1];
				return close / wma5 - 1 + (wma5 / wma10 - 1) + (wma10 / wma20 - 1);
			}
			default:
				return 0;
		}
	}

	// 4. Simulation state
	let cash = initialCapital;
	const positions = new Map<
		string,
		{ shares: number; entryPrice: number; entryDate: string; daysHeld: number; lastClose: number }
	>();
	const trades: PoolTrade[] = [];
	const equityCurve: EquityPoint[] = [];

	// 5. Day-by-day simulation
	for (let dateIdx = 0; dateIdx < allDates.length; dateIdx++) {
		const date = allDates[dateIdx];
		const prevDate = dateIdx > 0 ? allDates[dateIdx - 1] : undefined;

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
				// Skip if at limit-down
				const execKline = klineMaps.find((m) => m.code === code)?.map.get(date);
				if (execKline && isLimitDown(execKline)) continue;
				const sellPrice = exec.price * (1 - slippage);
				const sellAmount = pos.shares * sellPrice;
				if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
					continue;
				}
				const proceeds = sellAmount * (1 - commission);
				const costBasis = pos.shares * pos.entryPrice * (1 + commission);
				const pnl = proceeds - costBasis;
				trades.push({
					code,
					market: stock.market,
					direction: "sell",
					date,
					price: sellPrice,
					shares: pos.shares,
					amount: sellAmount,
					pnl,
					pnlPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
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
				const costBasis = pos.shares * pos.entryPrice * (1 + commission);
				const pnl = proceeds - costBasis;

				trades.push({
					code,
					market: stock.market,
					direction: "sell",
					date,
					price: sellPrice,
					shares: pos.shares,
					amount: pos.shares * sellPrice,
					pnl,
					pnlPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
					daysHeld: pos.daysHeld,
					result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
					memo: `强制平仓（持仓${pos.daysHeld}天，超过${maxHoldingDays}天上限）`,
				});
				cash += proceeds;
				positions.delete(code);
			}
		}

		// 5.3 Build target holdings from existing positions + today's buy candidates
		const buyCandidates = stockData
			.filter((s) => !positions.has(s.code))
			.filter((s) => passesIndustryFilter(s, s.execMap.get(date), industryFilter))
			.filter((s) => passesSizeFilter(s, s.execMap.get(date), sizeFilter))
			.map((s) => {
				const exec = s.execMap.get(date);
				if (exec?.type !== "buy") return null;
				// Use signal date for scoring to avoid lookahead bias
				const scoreDate = exec.signalDate;
				const signalDateIdx = dateIndex.get(exec.signalDate);
				const currentDateIdx = dateIndex.get(date);
				const recencyDays = signalDateIdx != null && currentDateIdx != null ? currentDateIdx - signalDateIdx : 0;
				const rankScore =
					config.rankBy === "random"
						? Math.random()
						: computeRankScore(s, klineMaps, scoreDate, config.rankBy, recencyDays);
				return { code: s.code, stock: s, score: rankScore };
			})
			.filter((c): c is NonNullable<typeof c> => c !== null)
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				return a.code.localeCompare(b.code);
			});

		// Score existing positions too so maxPositions applies to total holdings
		const scoredHoldings: Array<{ code: string; score: number; stock: (typeof stockData)[number] }> = [];
		for (const code of [...positions.keys()].sort()) {
			const stock = stockData.find((s) => s.code === code);
			if (!stock) continue;
			// Use previous trading day for scoring to avoid lookahead bias
			const scoreDate = prevDate ?? date;
			const pos = positions.get(code)!;
			const recencyDays = pos.daysHeld;
			const score =
				config.rankBy === "random"
					? Math.random()
					: computeRankScore(stock, klineMaps, scoreDate, config.rankBy, recencyDays);
			scoredHoldings.push({ code, score, stock });
		}
		for (const c of buyCandidates) {
			if (!scoredHoldings.some((h) => h.code === c.code)) {
				scoredHoldings.push({ code: c.code, score: c.score, stock: c.stock });
			}
		}
		scoredHoldings.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.code.localeCompare(b.code);
		});
		const maxHoldings = config.maxPositions ?? scoredHoldings.length;
		const targetCodes = new Set<string>();
		for (const h of scoredHoldings) {
			if (targetCodes.size >= maxHoldings) break;
			// Existing positions can be kept even if limit-up; new candidates must be buyable today
			if (positions.has(h.code)) {
				targetCodes.add(h.code);
			} else {
				const klineMap = klineMaps.find((m) => m.code === h.code)?.map;
				const kline = klineMap?.get(date);
				if (kline && isLimitUp(kline)) continue;
				targetCodes.add(h.code);
			}
		}

		// Sell positions that dropped out of top maxPositions
		for (const code of [...positions.keys()].sort()) {
			if (targetCodes.has(code)) continue;
			const pos = positions.get(code)!;
			const stock = stockData.find((s) => s.code === code);
			if (!stock) continue;

			const klineMap = klineMaps.find((m) => m.code === code)?.map;
			const kline = klineMap?.get(date);
			const sellPrice = (kline?.open ?? pos.lastClose) * (1 - slippage);
			const sellAmount = pos.shares * sellPrice;
			if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
				continue;
			}
			const proceeds = sellAmount * (1 - commission);
			const costBasis = pos.shares * pos.entryPrice * (1 + commission);
			const pnl = proceeds - costBasis;
			trades.push({
				code,
				market: stock.market,
				direction: "sell",
				date,
				price: sellPrice,
				shares: pos.shares,
				amount: sellAmount,
				pnl,
				pnlPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
				daysHeld: pos.daysHeld,
				result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
				memo: "调出目标持仓",
			});
			cash += proceeds;
			positions.delete(code);
		}

		// 5.4 Buy / rebalance target holdings
		if (!fullPosition) {
			// Non-full-position: buy new target holdings with available cash
			for (const code of [...targetCodes].sort()) {
				if (positions.has(code)) continue;
				const stock = stockData.find((s) => s.code === code);
				if (!stock) continue;

				const exec = stock.execMap.get(date);
				if (exec?.type !== "buy") continue;

				const execKline = klineMaps.find((m) => m.code === code)?.map.get(date);
				if (execKline && isLimitUp(execKline)) continue;

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

		// 5.5 Full-position rebalance
		if (fullPosition) {
			if (fullPositionMode === "add_to_holdings") {
				// Buy new target positions first, then distribute remaining cash across held positions
				const targetCodesArray = [...targetCodes].sort();
				const heldTargetCodes = targetCodesArray.filter((code) => positions.has(code));
				const newTargetCodes = targetCodesArray.filter((code) => !positions.has(code));

				if (targetCodesArray.length > 0) {
					let totalValue = cash;
					for (const code of heldTargetCodes) {
						const pos = positions.get(code)!;
						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						const price = kline?.open ?? pos.lastClose;
						if (price > 0) totalValue += pos.shares * price;
					}
					const targetValue = totalValue / targetCodes.size;
					const maxTargetValue = totalValue * maxPositionWeight;
					const effectiveTargetValue = Math.min(targetValue, maxTargetValue);

					// Buy new target positions up to the target weight
					for (const code of newTargetCodes) {
						const stock = stockData.find((s) => s.code === code);
						if (!stock) continue;
						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						if (!kline || isLimitUp(kline)) continue;
						const buyPrice = (kline.open ?? 0) * (1 + slippage);
						if (buyPrice <= 0) continue;
						const rawShares = Math.floor(effectiveTargetValue / buyPrice);
						const shares = Math.floor(rawShares / minLot) * minLot;
						if (shares >= minLot) {
							const amount = shares * buyPrice;
							if (!isTradeAmountValid(amount, minTradeAmount)) continue;
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
									memo: "满仓买入",
								});
							}
						}
					}

					// Distribute remaining cash evenly across all held target positions
					const allHeldTargetCodes = targetCodesArray.filter((code) => positions.has(code));
					if (allHeldTargetCodes.length > 0 && cash > 0) {
						let remaining = allHeldTargetCodes.length;
						for (const code of allHeldTargetCodes) {
							const pos = positions.get(code)!;
							const stock = stockData.find((s) => s.code === code);
							if (!stock) {
								remaining--;
								continue;
							}
							const klineMap = klineMaps.find((m) => m.code === code)?.map;
							const kline = klineMap?.get(date);
							if (kline && isLimitUp(kline)) {
								remaining--;
								continue;
							}
							const buyPrice = (kline?.open ?? pos.lastClose) * (1 + slippage);
							const currentValue = pos.shares * buyPrice;
							const maxAddValue = Math.max(0, totalValue * maxPositionWeight - currentValue);
							const cashPerStock = cash / remaining;
							const cashToUse = Math.min(cashPerStock, maxAddValue);
							const rawShares = Math.floor(cashToUse / buyPrice);
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
				}
			} else if (fullPositionMode === "equal_weight") {
				// Target equal-weight rebalancing among target holdings
				if (targetCodes.size > 0) {
					// Total portfolio value at today's open
					let totalValue = cash;
					for (const code of targetCodes) {
						const pos = positions.get(code);
						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						const price = kline?.open ?? pos?.lastClose ?? 0;
						if (pos && price > 0) totalValue += pos.shares * price;
					}

					const targetValue = totalValue / targetCodes.size;
					const maxTargetValue = totalValue * maxPositionWeight;
					const effectiveTargetValue = Math.min(targetValue, maxTargetValue);

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
						if (currentValue <= effectiveTargetValue) continue;

						const excessValue = currentValue - effectiveTargetValue;
						if (excessValue <= effectiveTargetValue * rebalanceThreshold) continue;

						const rawShares = Math.floor(excessValue / sellPrice);
						const shares = Math.floor(rawShares / minLot) * minLot;

						if (shares >= minLot && shares < pos.shares) {
							const sellAmount = shares * sellPrice;
							if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
								continue;
							}
							const proceeds = sellAmount * (1 - commission);
							const costBasis = shares * pos.entryPrice * (1 + commission);
							const pnl = proceeds - costBasis;
							trades.push({
								code,
								market: stock.market,
								direction: "sell",
								date,
								price: sellPrice,
								shares,
								amount: sellAmount,
								pnl,
								pnlPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
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
						// Skip rebalancing buy if at limit-up
						if (kline && isLimitUp(kline)) continue;
						const buyPrice = (kline?.open ?? pos?.lastClose ?? 0) * (1 + slippage);
						if (buyPrice <= 0) continue;

						const currentValue = pos ? pos.shares * buyPrice : 0;
						const deficitValue = effectiveTargetValue - currentValue;
						if (deficitValue <= effectiveTargetValue * rebalanceThreshold) continue;

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

					// Cash sweep: if some targets were limit-up, redistribute remaining cash
					// evenly across the targets that are actually buyable today.
					const buyableTargetCodes = [...targetCodes].filter((code) => {
						const klineMap = klineMaps.find((m) => m.code === code)?.map;
						const kline = klineMap?.get(date);
						return !(kline && isLimitUp(kline));
					});
					if (buyableTargetCodes.length > 0 && cash > 0) {
						let remaining = buyableTargetCodes.length;
						for (const code of buyableTargetCodes) {
							const pos = positions.get(code);
							const stock = stockData.find((s) => s.code === code);
							if (!stock) {
								remaining--;
								continue;
							}
							const klineMap = klineMaps.find((m) => m.code === code)?.map;
							const kline = klineMap?.get(date);
							const buyPrice = (kline?.open ?? pos?.lastClose ?? 0) * (1 + slippage);
							if (buyPrice <= 0) {
								remaining--;
								continue;
							}
							const currentValue = pos ? pos.shares * buyPrice : 0;
							const maxAddValue = Math.max(0, totalValue * maxPositionWeight - currentValue);
							const cashPerStock = cash / remaining;
							const cashToUse = Math.min(cashPerStock, maxAddValue);
							const rawShares = Math.floor(cashToUse / buyPrice);
							const shares = Math.floor(rawShares / minLot) * minLot;

							if (shares >= minLot) {
								const amount = shares * buyPrice;
								if (isTradeAmountValid(amount, minTradeAmount)) {
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
											memo: "等权现金 sweep",
										});
									}
								}
							}
							remaining--;
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

	const metrics = computeMetrics(sellTrades, equityCurve, initialCapital, config.period);

	return {
		stocks,
		strategy: resolveStrategyLabel(config),
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
