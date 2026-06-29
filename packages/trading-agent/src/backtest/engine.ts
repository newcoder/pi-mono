import { getDataStore } from "../data/index.js";
import type { KlineRow } from "../data/types.js";
import { cachedMA, indicatorCache } from "./indicator-cache.js";
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
import { round } from "./utils.js";

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

/** Check if a kline is tradeable (not suspended / zero volume / missing prices). */
function isTradeable(kline: KlineRow): boolean {
	if (kline.volume == null || kline.volume === 0) return false;
	if (kline.open == null && kline.high == null && kline.low == null && kline.close == null) return false;
	return true;
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
	indicatorCache.clear();

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
	const taxRate = config.taxRate ?? 0;
	const transferFee = config.transferFee ?? 0;
	const positionSize = config.positionSize ?? 1.0;
	const minLot = config.minLot ?? 100;

	const { trades, equityCurve, filteredTradeCount } = simulateTrades(
		klines,
		signals,
		initialCapital,
		positionSize,
		slippage,
		commission,
		minLot,
		taxRate,
		transferFee,
		config.skipNoVolume ?? true,
		config.maxHoldingDays ?? Infinity,
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
		filteredTradeCount,
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

export function simulateTrades(
	klines: KlineRow[],
	signals: Signal[],
	initialCapital: number,
	positionSize: number,
	slippage: number,
	commission: number,
	minLot: number,
	taxRate = 0,
	transferFee = 0,
	skipNoVolume = true,
	maxHoldingDays = Infinity,
): { trades: Trade[]; equityCurve: EquityPoint[]; filteredTradeCount: number } {
	const trades: Trade[] = [];
	const equityCurve: EquityPoint[] = [];
	let capital = initialCapital;
	let entryIndex = -1;
	let entryPrice = 0;
	let shares = 0;
	let signalIdx = 0;
	let lastClose = 0;
	let filteredTradeCount = 0;

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
				if (skipNoVolume && !isTradeable(execKline)) {
					filteredTradeCount++;
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

				const cost = newShares * entryPrice * (1 + commission + transferFee);
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
				if (skipNoVolume && !isTradeable(execKline)) {
					filteredTradeCount++;
					signalIdx++;
					continue;
				}

				const exitPrice = execKline.open * (1 - slippage);
				const proceeds = shares * exitPrice * (1 - commission - transferFee - taxRate);
				const costBasis = shares * entryPrice * (1 + commission + transferFee);
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

		// Force-sell if holding period exceeded maxHoldingDays
		if (entryIndex >= 0 && maxHoldingDays !== Infinity) {
			const daysHeld = i - entryIndex;
			if (daysHeld >= maxHoldingDays) {
				const k = klines[i];
				if (k && (k.open != null || k.close != null)) {
					const exitPrice = (k.open ?? k.close!) * (1 - slippage);
					const proceeds = shares * exitPrice * (1 - commission - transferFee - taxRate);
					const costBasis = shares * entryPrice * (1 + commission + transferFee);
					const pnl = proceeds - costBasis;
					const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
					trades.push({
						entryIndex,
						entryDate: klines[entryIndex].date,
						entryPrice,
						exitIndex: i,
						exitDate: k.date,
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
			const proceeds = shares * exitPrice * (1 - commission - transferFee - taxRate);
			const costBasis = shares * entryPrice * (1 + commission + transferFee);
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

	return { trades, equityCurve, filteredTradeCount };
}

// ─── Pool Backtest ────────────────────────────────────────────────

export async function runPoolBacktest(
	stocks: Array<{ code: string; market: number; name?: string }>,
	config: PoolBacktestConfig,
	dynamicPoolItems?: Map<string, Array<{ code: string; market: number; name?: string; weight?: number }>>,
): Promise<PoolBacktestResult> {
	const t0 = performance.now();
	const profile = process.env.TRADING_AGENT_PROFILE === "1";
	indicatorCache.clear();

	const store = getDataStore();
	if (!store) throw new Error("DataStore not initialized.");

	const initialCapital = config.initialCapital ?? 100_000;

	const slippage = config.slippage ?? 0.001;
	const commission = config.commission ?? 0.0003;
	const taxRate = config.taxRate ?? 0;
	const transferFee = config.transferFee ?? 0;
	const minLot = config.minLot ?? 100;
	const skipNoVolume = config.skipNoVolume ?? true;
	const maxHoldingDays = config.maxHoldingDays ?? Infinity;
	const fullPosition = config.fullPosition ?? true;
	const fullPositionMode = config.fullPositionMode ?? "equal_weight";
	const rebalanceThreshold = config.rebalanceThreshold ?? 0;
	const rebalanceFrequency = config.rebalanceFrequency ?? 1;
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
		dateToIndex: Map<string, number>;
		signals: Signal[];
		execMap: Map<string, { type: "buy" | "sell"; price: number; signalDate: string }>;
	}> = [];

	const period = config.period ?? "daily";
	const adjust = config.adjust ?? "bfq";

	const tLoadStart = performance.now();
	let signalGenTime = 0;

	// Batch load bfq klines and adjustment factors for all requested stocks
	const [klineGroups, factorGroups] = await Promise.all([
		store.getKlinesForCodes(stocks, period, "bfq", defaultStart, defaultEnd),
		adjust !== "bfq" ? store.getAdjustFactorsForCodes(stocks, defaultStart, defaultEnd) : Promise.resolve(null),
	]);

	const tDbEnd = performance.now();

	for (const stock of stocks) {
		const key = `${stock.code}_${stock.market}`;
		const klines = klineGroups.get(key) ?? [];

		if (klines.length === 0) continue;

		// Apply adjustment factors
		let adjustedKlines = klines;
		if (adjust !== "bfq" && factorGroups) {
			const factors = factorGroups.get(key) ?? [];
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

		const tSignalGen = performance.now();
		const signals = generateAllSignals(adjustedKlines, config);
		signalGenTime += performance.now() - tSignalGen;

		// Pre-compute execution events: signal at index i executes at index i+1 open
		// When multiple signals target the same exec date, sell takes priority over buy
		// (T+1 constraint: a buy-then-sell on the same day is invalid).
		const execMap = new Map<string, { type: "buy" | "sell"; price: number; signalDate: string }>();
		for (const signal of signals) {
			const execIdx = signal.index + 1;
			if (execIdx < adjustedKlines.length) {
				const execKline = adjustedKlines[execIdx];
				const signalKline = adjustedKlines[signal.index];
				if (execKline.open != null && signalKline != null) {
					const existing = execMap.get(execKline.date);
					// Don't overwrite a sell with a buy — sell always wins on collision
					if (!existing || existing.type !== "sell") {
						execMap.set(execKline.date, {
							type: signal.type,
							price: execKline.open,
							signalDate: signalKline.date,
						});
					}
				}
			}
		}

		const dateToIndex = new Map<string, number>();
		for (let i = 0; i < adjustedKlines.length; i++) {
			dateToIndex.set(adjustedKlines[i].date, i);
		}

		stockData.push({
			code: stock.code,
			market: stock.market,
			name: stock.name,
			klines: adjustedKlines,
			dateToIndex,
			signals,
			execMap,
		});
	}

	const tSignalEnd = performance.now();
	let rankLoopTime = 0;
	let execLoopTime = 0;

	if (stockData.length === 0) {
		throw new Error("No kline data available for any stock in the pool.");
	}

	// Build O(1) lookup maps for the simulation hot loop
	const stockMap = new Map(stockData.map((s) => [s.code, s]));
	const klineMapByCode = new Map<string, Map<string, KlineRow>>();

	// 1b. Dynamic pool support
	const isDynamic = dynamicPoolItems != null && dynamicPoolItems.size > 0;
	const dynamicDates = isDynamic ? [...dynamicPoolItems.keys()].sort() : [];
	let lastAllowedCodes = new Set<string>();
	function getAllowedCodes(date: string): Set<string> {
		if (!isDynamic) return new Set(stockData.map((s) => s.code));
		const exact = dynamicPoolItems.get(date);
		if (exact) {
			lastAllowedCodes = new Set(exact.map((i) => i.code));
			return lastAllowedCodes;
		}
		// Carry forward from latest available date <= current date
		let latest = "";
		for (const d of dynamicDates) {
			if (d <= date) latest = d;
			else break;
		}
		if (latest) {
			lastAllowedCodes = new Set(dynamicPoolItems.get(latest)!.map((i) => i.code));
			return lastAllowedCodes;
		}
		// Before first dynamic date: use first available date
		if (dynamicDates.length > 0) {
			lastAllowedCodes = new Set(dynamicPoolItems.get(dynamicDates[0])!.map((i) => i.code));
			return lastAllowedCodes;
		}
		return new Set();
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

	for (const km of klineMaps) klineMapByCode.set(km.code, km.map);

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
		const industryResults = await Promise.all(
			stockData.map(async (s) => {
				const industries = await store!.getStockIndustries(s.code, s.market);
				const match = industries.find((i) => i.standard === filter.standard);
				return { key: `${s.code}_${s.market}`, code: match?.industry_code };
			}),
		);
		for (const { key, code } of industryResults) {
			if (code) stockIndustry.set(key, code);
		}

		const uniqueIndustries = [...new Set(stockIndustry.values())];
		const momentumResults = await Promise.all(
			uniqueIndustries.map(async (indCode) => {
				const rows = await store!.getIndustryIndicators(indCode, filter.periodDays, defaultStart, defaultEnd);
				return { indCode, rows };
			}),
		);
		const industryMomentum = new Map<string, IndustryMomentumInfo>();
		for (const { indCode, rows } of momentumResults) {
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

		const sizeResults = await Promise.all(
			stockData.map(async (s) => {
				const rows = await store!.getStockIndicators(s.code, s.market, "size_mcap", defaultStart, defaultEnd);
				return { s, rows };
			}),
		);
		const stockSize = new Map<string, number>();
		const maxRankByDate = new Map<string, number>();
		for (const { s, rows } of sizeResults) {
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
		scoreDate: string,
		rankBy?: PoolBacktestConfig["rankBy"],
		recencyDays?: number,
	): number {
		if (!rankBy) return 0;

		const klineMap = klineMapByCode.get(stock.code);
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
				const localIdx = stock.dateToIndex.get(scoreDate);
				if (localIdx == null) return 0;
				const ma10Values = cachedMA(stock.klines, 10).values;
				const ma20Values = cachedMA(stock.klines, 20).values;
				const ma60Values = cachedMA(stock.klines, 60).values;
				const ma10 = ma10Values[localIdx];
				const ma20 = ma20Values[localIdx];
				const ma60 = ma60Values[localIdx];
				const close = kline?.close ?? null;
				if (ma10 == null || ma20 == null || ma60 == null || close == null) return 0;
				if (ma10 <= 0 || ma20 <= 0 || ma60 <= 0) return 0;
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

	// 4. Run simulation (single pass or multi-run for random rankBy)
	function runOneSimulation(): {
		trades: PoolTrade[];
		equityCurve: EquityPoint[];
		filteredTradeCount: number;
		rankLoopTime: number;
		execLoopTime: number;
	} {
		// 4. Simulation state
		let cash = initialCapital;
		const positions = new Map<
			string,
			{ shares: number; entryPrice: number; entryDate: string; daysHeld: number; lastClose: number }
		>();
		const trades: PoolTrade[] = [];
		const equityCurve: EquityPoint[] = [];
		let filteredTradeCount = 0;

		function checkTradeable(kline: KlineRow | undefined): boolean {
			if (!skipNoVolume) return true;
			if (!kline || !isTradeable(kline)) {
				filteredTradeCount++;
				return false;
			}
			return true;
		}

		// 5. Day-by-day simulation
		for (let dateIdx = 0; dateIdx < allDates.length; dateIdx++) {
			const date = allDates[dateIdx];
			const prevDate = dateIdx > 0 ? allDates[dateIdx - 1] : undefined;
			const allowedCodes = getAllowedCodes(date);

			// 5.1 Increment holding days
			for (const pos of positions.values()) pos.daysHeld++;

			// 5.1b Force-sell positions that dropped out of the dynamic pool
			if (isDynamic) {
				for (const code of [...positions.keys()].sort()) {
					if (allowedCodes.has(code)) continue;
					const pos = positions.get(code)!;
					const stock = stockMap.get(code);
					if (!stock) continue;

					const klineMap = klineMapByCode.get(code);
					const kline = klineMap?.get(date);
					if (!checkTradeable(kline)) continue;
					const sellPrice = (kline?.open ?? pos.lastClose) * (1 - slippage);
					const sellAmount = pos.shares * sellPrice;
					if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
						continue;
					}
					const proceeds = sellAmount * (1 - commission - transferFee - taxRate);
					const costBasis = pos.shares * pos.entryPrice * (1 + commission + transferFee);
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
						memo: "调出动态池",
					});
					cash += proceeds;
					positions.delete(code);
				}
			}

			// 5.2 Sell phase (sorted by code for determinism)
			const sortedHoldings = [...positions.keys()].sort();
			for (const code of sortedHoldings) {
				const pos = positions.get(code)!;
				const stock = stockMap.get(code);
				if (!stock) continue;

				const exec = stock.execMap.get(date);
				if (exec?.type === "sell") {
					// Skip if at limit-down
					const execKline = klineMapByCode.get(code)?.get(date);
					if (execKline && isLimitDown(execKline)) continue;
					if (!checkTradeable(execKline)) continue;
					const sellPrice = exec.price * (1 - slippage);
					const sellAmount = pos.shares * sellPrice;
					if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
						continue;
					}
					const proceeds = sellAmount * (1 - commission - transferFee - taxRate);
					const costBasis = pos.shares * pos.entryPrice * (1 + commission + transferFee);
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
					.filter(([, pos]) => pos.daysHeld >= maxHoldingDays)
					.map(([code]) => code)
					.sort();
				for (const code of staleCodes) {
					const pos = positions.get(code)!;
					const stock = stockMap.get(code);
					if (!stock) continue;

					const klineMap = klineMapByCode.get(code);
					const kline = klineMap?.get(date);
					if (!checkTradeable(kline)) continue;
					const sellPrice = (kline?.open ?? pos.lastClose) * (1 - slippage);
					const proceeds = pos.shares * sellPrice * (1 - commission - transferFee - taxRate);
					const costBasis = pos.shares * pos.entryPrice * (1 + commission + transferFee);
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

			const tRankStart = performance.now();

			// 5.3 Build target holdings from existing positions + today's buy candidates
			const buyCandidates = stockData
				.filter((s) => allowedCodes.has(s.code))
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
							: computeRankScore(s, scoreDate, config.rankBy, recencyDays);
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
				const stock = stockMap.get(code);
				if (!stock) continue;
				// Use previous trading day for scoring to avoid lookahead bias
				const scoreDate = prevDate ?? date;
				const pos = positions.get(code)!;
				const recencyDays = pos.daysHeld;
				const score =
					config.rankBy === "random"
						? Math.random()
						: computeRankScore(stock, scoreDate, config.rankBy, recencyDays);
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
					const klineMap = klineMapByCode.get(h.code);
					const kline = klineMap?.get(date);
					if (kline && isLimitUp(kline)) continue;
					targetCodes.add(h.code);
				}
			}

			rankLoopTime += performance.now() - tRankStart;
			const tExecStart = performance.now();

			const isRebalanceDay = rebalanceFrequency <= 1 || dateIdx % rebalanceFrequency === 0;

			// Force-sell all positions on full-rebalance days before rebuilding the portfolio
			if (isRebalanceDay && config.rebalanceFullPortfolio) {
				for (const code of [...positions.keys()].sort()) {
					const pos = positions.get(code)!;
					const stock = stockMap.get(code);
					if (!stock) continue;

					const klineMap = klineMapByCode.get(code);
					const kline = klineMap?.get(date);
					if (!checkTradeable(kline)) continue;
					const sellPrice = (kline?.open ?? pos.lastClose) * (1 - slippage);
					const sellAmount = pos.shares * sellPrice;
					if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
						continue;
					}
					const proceeds = sellAmount * (1 - commission - transferFee - taxRate);
					const costBasis = pos.shares * pos.entryPrice * (1 + commission + transferFee);
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
						memo: "周期强制换仓",
					});
					cash += proceeds;
					positions.delete(code);
				}
			}

			// Sell positions that dropped out of top maxPositions
			if (isRebalanceDay) {
				for (const code of [...positions.keys()].sort()) {
					if (targetCodes.has(code)) continue;
					const pos = positions.get(code)!;
					const stock = stockMap.get(code);
					if (!stock) continue;

					const klineMap = klineMapByCode.get(code);
					const kline = klineMap?.get(date);
					if (!checkTradeable(kline)) continue;
					const sellPrice = (kline?.open ?? pos.lastClose) * (1 - slippage);
					const sellAmount = pos.shares * sellPrice;
					if (!isTradeAmountValid(sellAmount, minTradeAmount)) {
						continue;
					}
					const proceeds = sellAmount * (1 - commission - transferFee - taxRate);
					const costBasis = pos.shares * pos.entryPrice * (1 + commission + transferFee);
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
			}

			// 5.4 Buy / rebalance target holdings
			if (!isRebalanceDay) {
				// do nothing on off days; hold existing positions
			} else if (!fullPosition) {
				// Non-full-position: buy new target holdings with available cash
				for (const code of [...targetCodes].sort()) {
					if (positions.has(code)) continue;
					const stock = stockMap.get(code);
					if (!stock) continue;

					const exec = stock.execMap.get(date);
					if (exec?.type !== "buy") continue;

					const execKline = klineMapByCode.get(code)?.get(date);
					if (execKline && isLimitUp(execKline)) continue;
					if (!checkTradeable(execKline)) continue;

					const buyPrice = exec.price * (1 + slippage);
					const maxBuyAmount = computeMaxBuyAmount(initialCapital, cash, positions.size, allowedCodes.size);
					const rawShares = Math.floor(maxBuyAmount / buyPrice);
					const shares = Math.floor(rawShares / minLot) * minLot;

					if (shares >= minLot) {
						const amount = shares * buyPrice;
						if (!isTradeAmountValid(amount, minTradeAmount)) {
							continue;
						}
						const cost = amount * (1 + commission + transferFee);
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
			else if (fullPosition) {
				if (fullPositionMode === "add_to_holdings") {
					// Buy new target positions first, then distribute remaining cash across held positions
					const targetCodesArray = [...targetCodes].sort();
					const heldTargetCodes = targetCodesArray.filter((code) => positions.has(code));
					const newTargetCodes = targetCodesArray.filter((code) => !positions.has(code));

					if (targetCodesArray.length > 0) {
						let totalValue = cash;
						for (const code of heldTargetCodes) {
							const pos = positions.get(code)!;
							const klineMap = klineMapByCode.get(code);
							const kline = klineMap?.get(date);
							const price = kline?.open ?? pos.lastClose;
							if (price > 0) totalValue += pos.shares * price;
						}
						const targetValue = totalValue / targetCodes.size;
						const maxTargetValue = totalValue * maxPositionWeight;
						const effectiveTargetValue = Math.min(targetValue, maxTargetValue);

						// Buy new target positions up to the target weight
						for (const code of newTargetCodes) {
							const stock = stockMap.get(code);
							if (!stock) continue;
							const klineMap = klineMapByCode.get(code);
							const kline = klineMap?.get(date);
							if (!kline || isLimitUp(kline)) continue;
							if (!checkTradeable(kline)) continue;
							const buyPrice = (kline.open ?? 0) * (1 + slippage);
							if (buyPrice <= 0) continue;
							const rawShares = Math.floor(effectiveTargetValue / buyPrice);
							const shares = Math.floor(rawShares / minLot) * minLot;
							if (shares >= minLot) {
								const amount = shares * buyPrice;
								if (!isTradeAmountValid(amount, minTradeAmount)) continue;
								const cost = amount * (1 + commission + transferFee);
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
								const stock = stockMap.get(code);
								if (!stock) {
									remaining--;
									continue;
								}
								const klineMap = klineMapByCode.get(code);
								const kline = klineMap?.get(date);
								if (kline && isLimitUp(kline)) {
									remaining--;
									continue;
								}
								if (!checkTradeable(kline)) {
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
									const cost = amount * (1 + commission + transferFee);
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
							const klineMap = klineMapByCode.get(code);
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

							const stock = stockMap.get(code);
							if (!stock) continue;

							const klineMap = klineMapByCode.get(code);
							const kline = klineMap?.get(date);
							if (!checkTradeable(kline)) continue;
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
								const proceeds = sellAmount * (1 - commission - transferFee - taxRate);
								const costBasis = shares * pos.entryPrice * (1 + commission + transferFee);
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
							const stock = stockMap.get(code);
							if (!stock) continue;

							const klineMap = klineMapByCode.get(code);
							const kline = klineMap?.get(date);
							// Skip rebalancing buy if at limit-up
							if (kline && isLimitUp(kline)) continue;
							if (!checkTradeable(kline)) continue;
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
								const cost = amount * (1 + commission + transferFee);
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
							const klineMap = klineMapByCode.get(code);
							const kline = klineMap?.get(date);
							if (kline && isLimitUp(kline)) return false;
							return checkTradeable(kline);
						});
						if (buyableTargetCodes.length > 0 && cash > 0) {
							let remaining = buyableTargetCodes.length;
							for (const code of buyableTargetCodes) {
								const pos = positions.get(code);
								const stock = stockMap.get(code);
								if (!stock) {
									remaining--;
									continue;
								}
								const klineMap = klineMapByCode.get(code);
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
										const cost = amount * (1 + commission + transferFee);
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
			} else if (fullPositionMode === "linear") {
				// Linear decreasing weights: rank 1 gets N shares, rank N gets 1 share.
				// Build ranked target list from scoredHoldings (already sorted by score desc).
				const targetRanked = scoredHoldings.filter((h) => targetCodes.has(h.code));
				const n = targetRanked.length;
				if (n > 0) {
					// Weight_i = n - i (0-based). Total = n*(n+1)/2. Fraction = weight_i / total.
					const totalWeight = (n * (n + 1)) / 2;

					// Total portfolio value at today's open
					let totalValue = cash;
					for (const h of targetRanked) {
						const pos = positions.get(h.code);
						const klineMap = klineMapByCode.get(h.code);
						const kline = klineMap?.get(date);
						const price = kline?.open ?? pos?.lastClose ?? 0;
						if (pos && price > 0) totalValue += pos.shares * price;
					}

					const maxTargetValue = totalValue * maxPositionWeight;

					// Sell overweight positions first (partial sells allowed)
					for (let i = 0; i < n; i++) {
						const h = targetRanked[i];
						const pos = positions.get(h.code);
						if (!pos) continue;

						const stock = stockMap.get(h.code);
						if (!stock) continue;

						const klineMap = klineMapByCode.get(h.code);
						const kline = klineMap?.get(date);
						if (!checkTradeable(kline)) continue;
						const sellPrice = (kline?.open ?? pos.lastClose) * (1 - slippage);

						const linearWeight = n - i;
						const targetFraction = linearWeight / totalWeight;
						const effectiveTargetValue = Math.min(targetFraction * totalValue, maxTargetValue);
						const currentValue = pos.shares * sellPrice;
						if (currentValue <= effectiveTargetValue) continue;

						const excessValue = currentValue - effectiveTargetValue;
						if (excessValue <= effectiveTargetValue * rebalanceThreshold) continue;

						const rawShares = Math.floor(excessValue / sellPrice);
						const shares = Math.floor(rawShares / minLot) * minLot;
						if (shares >= minLot && shares < pos.shares) {
							const sellAmount = shares * sellPrice;
							if (!isTradeAmountValid(sellAmount, minTradeAmount)) continue;
							const proceeds = sellAmount * (1 - commission - transferFee - taxRate);
							const costBasis = shares * pos.entryPrice * (1 + commission + transferFee);
							const pnl = proceeds - costBasis;
							trades.push({
								code: h.code,
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
								memo: "线性减仓",
							});
							cash += proceeds;
							pos.shares -= shares;
							if (pos.shares <= 0) positions.delete(h.code);
						}
					}

					// Buy underweight positions
					for (let i = 0; i < n; i++) {
						const h = targetRanked[i];
						const pos = positions.get(h.code);
						const stock = stockMap.get(h.code);
						if (!stock) continue;

						const klineMap = klineMapByCode.get(h.code);
						const kline = klineMap?.get(date);
						if (kline && isLimitUp(kline)) continue;
						if (!checkTradeable(kline)) continue;
						const buyPrice = (kline?.open ?? pos?.lastClose ?? 0) * (1 + slippage);
						if (buyPrice <= 0) continue;

						const linearWeight = n - i;
						const targetFraction = linearWeight / totalWeight;
						const effectiveTargetValue = Math.min(targetFraction * totalValue, maxTargetValue);
						const currentValue = pos ? pos.shares * buyPrice : 0;
						const deficitValue = effectiveTargetValue - currentValue;
						if (deficitValue <= effectiveTargetValue * rebalanceThreshold) continue;

						const rawShares = Math.floor(deficitValue / buyPrice);
						const shares = Math.floor(rawShares / minLot) * minLot;
						if (shares >= minLot) {
							const amount = shares * buyPrice;
							if (!isTradeAmountValid(amount, minTradeAmount)) continue;
							const cost = amount * (1 + commission + transferFee);
							if (cost <= cash) {
								cash -= cost;
								if (pos) {
									const totalCost = pos.entryPrice * pos.shares + amount;
									pos.shares += shares;
									pos.entryPrice = totalCost / pos.shares;
								} else {
									positions.set(h.code, {
										shares,
										entryPrice: buyPrice,
										entryDate: date,
										daysHeld: 0,
										lastClose: buyPrice,
									});
								}
								trades.push({
									code: h.code,
									market: stock.market,
									direction: "buy",
									date,
									price: buyPrice,
									shares,
									amount,
									memo: "线性买入",
								});
							}
						}
					}

					// Cash sweep: redistribute remaining cash linearly to buyable targets
					const buyableRanked = targetRanked.filter((h) => {
						const klineMap = klineMapByCode.get(h.code);
						const kline = klineMap?.get(date);
						if (kline && isLimitUp(kline)) return false;
						return checkTradeable(kline);
					});
					if (buyableRanked.length > 0 && cash > 0) {
						let remaining = buyableRanked.length;
						for (const h of buyableRanked) {
							const pos = positions.get(h.code);
							const stock = stockMap.get(h.code);
							if (!stock) {
								remaining--;
								continue;
							}

							const klineMap = klineMapByCode.get(h.code);
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
									const cost = amount * (1 + commission + transferFee);
									if (cost <= cash) {
										cash -= cost;
										if (pos) {
											const totalCost = pos.entryPrice * pos.shares + amount;
											pos.shares += shares;
											pos.entryPrice = totalCost / pos.shares;
										} else {
											positions.set(h.code, {
												shares,
												entryPrice: buyPrice,
												entryDate: date,
												daysHeld: 0,
												lastClose: buyPrice,
											});
										}
										trades.push({
											code: h.code,
											market: stock.market,
											direction: "buy",
											date,
											price: buyPrice,
											shares,
											amount,
											memo: "线性现金 sweep",
										});
									}
								}
							}
							remaining--;
						}
					}
				}
			}

			execLoopTime += performance.now() - tExecStart;

			// 5.4 Compute equity at market close after all trades
			let marketValue = 0;
			for (const [code, pos] of positions) {
				const klineMap = klineMapByCode.get(code);
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

		return { trades, equityCurve, filteredTradeCount, rankLoopTime, execLoopTime };
	}

	const isRandomMultiRun = config.rankBy === "random" && (config.randomRuns ?? 1) > 1;
	const actualRuns = isRandomMultiRun ? (config.randomRuns ?? 1) : 1;
	const passResults: Array<ReturnType<typeof runOneSimulation>> = [];
	const tSimStart = performance.now();
	for (let r = 0; r < actualRuns; r++) {
		passResults.push(runOneSimulation());
	}
	const tSimEnd = performance.now();

	// Aggregate across random runs if multi-run; otherwise use single pass
	let allTrades: PoolTrade[];
	let finalEquityCurve: EquityPoint[];
	let finalFilteredCount: number;
	let finalRankLoopTime: number;
	let finalExecLoopTime: number;
	if (isRandomMultiRun) {
		allTrades = passResults.flatMap((p) => p.trades);
		const maxEqLen = Math.max(...passResults.map((p) => p.equityCurve.length));
		finalEquityCurve = [];
		for (let d = 0; d < maxEqLen; d++) {
			const vals = passResults.map((p) => p.equityCurve[d]?.equity).filter((e): e is number => e != null);
			if (vals.length >= passResults.length / 2) {
				finalEquityCurve.push({
					date: passResults[0].equityCurve[Math.min(d, passResults[0].equityCurve.length - 1)].date,
					equity: vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)],
				});
			}
		}
		finalFilteredCount = passResults.reduce((sum, p) => sum + p.filteredTradeCount, 0);
		finalRankLoopTime = passResults.reduce((sum, p) => sum + p.rankLoopTime, 0);
		finalExecLoopTime = passResults.reduce((sum, p) => sum + p.execLoopTime, 0);
	} else {
		const single = passResults[0];
		allTrades = single.trades;
		finalEquityCurve = single.equityCurve;
		finalFilteredCount = single.filteredTradeCount;
		finalRankLoopTime = single.rankLoopTime;
		finalExecLoopTime = single.execLoopTime;
	}

	// 6. Compute metrics (adapt PoolTrade sells to Trade shape)
	const sellTrades: Trade[] = allTrades
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

	const metrics = computeMetrics(sellTrades, finalEquityCurve, initialCapital, config.period);

	if (profile) {
		console.log(
			`[profile] stocks=${stockData.length} dates=${allDates.length} setup=${(tLoadStart - t0).toFixed(0)}ms ` +
				`db=${(tDbEnd - tLoadStart).toFixed(0)}ms signal=${signalGenTime.toFixed(0)}ms ` +
				`filterCtx=${(tSimStart - tSignalEnd).toFixed(0)}ms rank=${finalRankLoopTime.toFixed(0)}ms ` +
				`exec=${finalExecLoopTime.toFixed(0)}ms sim=${(tSimEnd - tSimStart).toFixed(0)}ms ` +
				`metrics=${(performance.now() - tSimEnd).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`,
		);
	}

	return {
		stocks,
		strategy: resolveStrategyLabel(config),
		startDate: allDates[0] ?? "",
		endDate: allDates[allDates.length - 1] ?? "",
		initialCapital,
		trades: allTrades,
		equityCurve: finalEquityCurve,
		metrics,
		filteredTradeCount: finalFilteredCount,
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

export async function runDynamicPoolBacktest(poolId: number, config: PoolBacktestConfig): Promise<PoolBacktestResult> {
	const store = getDataStore();
	if (!store) throw new Error("DataStore not initialized.");

	const pool = await store.getStockPoolById(poolId);
	if (!pool) throw new Error(`Dynamic pool ${poolId} not found.`);

	const today = localDateString();
	const defaultEnd = config.end
		? `${config.end.slice(0, 4)}-${config.end.slice(4, 6)}-${config.end.slice(6, 8)}`
		: today;
	const defaultStart = config.start
		? `${config.start.slice(0, 4)}-${config.start.slice(4, 6)}-${config.start.slice(6, 8)}`
		: localDateString(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));

	const dynamicItems = await store.getDynamicPoolItemsInRange(poolId, defaultStart, defaultEnd);
	if (dynamicItems.size === 0) {
		throw new Error(`No dynamic pool items found for pool ${poolId} in range ${defaultStart} ~ ${defaultEnd}.`);
	}

	// Union of all stocks that ever appear in the pool during the range
	const stockMap = new Map<string, { code: string; market: number; name?: string }>();
	for (const items of dynamicItems.values()) {
		for (const item of items) {
			if (!stockMap.has(item.code)) {
				stockMap.set(item.code, { code: item.code, market: item.market, name: item.name });
			}
		}
	}
	const stocks = Array.from(stockMap.values());

	return runPoolBacktest(stocks, { ...config, dynamicPoolId: poolId }, dynamicItems);
}
