import type { EquityPoint } from "../backtest/types.js";
import { getDataStore } from "../data/index.js";
import type { PortfolioHolding, PortfolioTradeRow, PortfolioValueBreakdown } from "../data/types.js";
import { applyAdjustment } from "../tools/market-data.js";

export interface ReplayResult {
	cashDelta: number;
	holdings: Map<string, PortfolioHolding>;
}

/**
 * Replay portfolio trades up to (and including) asOfDate to reconstruct holdings.
 * Returns cash delta (relative to initial cash) and current holdings map.
 */
export function replayHoldings(trades: PortfolioTradeRow[], asOfDate: string): ReplayResult {
	const holdings = new Map<string, PortfolioHolding>();
	let cashDelta = 0;

	for (const trade of trades) {
		if (trade.trade_date > asOfDate) break;

		const key = `${trade.code}:${trade.market}`;
		const totalCost = trade.quantity * trade.price;
		const fees = (trade.commission ?? 0) + (trade.tax ?? 0);

		if (trade.direction === "buy") {
			const existing = holdings.get(key);
			if (existing) {
				const newTotalCost = existing.totalCost + totalCost + fees;
				const newQty = existing.quantity + trade.quantity;
				existing.quantity = newQty;
				existing.avgCost = newTotalCost / newQty;
				existing.totalCost = newTotalCost;
			} else {
				holdings.set(key, {
					code: trade.code,
					market: trade.market,
					quantity: trade.quantity,
					avgCost: (totalCost + fees) / trade.quantity,
					totalCost: totalCost + fees,
				});
			}
			cashDelta -= totalCost + fees;
		} else {
			const existing = holdings.get(key);
			if (existing) {
				const proceeds = totalCost - fees;
				existing.quantity -= trade.quantity;
				existing.totalCost = existing.avgCost * existing.quantity;
				if (existing.quantity <= 0) {
					holdings.delete(key);
				}
				cashDelta += proceeds;
			}
		}
	}

	return { cashDelta, holdings };
}

/**
 * Compute portfolio value at a specific date.
 */
export async function computePortfolioValue(
	portfolioId: number,
	asOfDate: string,
	priceMode: "open" | "close" = "close",
): Promise<PortfolioValueBreakdown> {
	const store = getDataStore();
	if (!store) throw new Error("DataStore not initialized");

	const portfolio = await store.getPortfolioById(portfolioId);
	if (!portfolio) throw new Error(`Portfolio ${portfolioId} not found`);

	const trades = await store.getPortfolioTrades(portfolioId, undefined, asOfDate);
	const { cashDelta, holdings } = replayHoldings(trades, asOfDate);
	const cash = portfolio.initial_cash + cashDelta;

	let holdingsValue = 0;
	let holdingsTotalCost = 0;
	const holdingDetails = [];

	// Batch fetch klines in parallel to avoid N+1 queries
	const klinePromises = Array.from(holdings.values()).map((h) =>
		store.getKlines({
			code: h.code,
			market: h.market,
			period: "daily",
			adjust: "qfq",
			start: asOfDate,
			end: asOfDate,
			limit: 1,
		}),
	);
	const klineResults = await Promise.all(klinePromises);

	let i = 0;
	for (const [, h] of holdings) {
		const klines = klineResults[i++];
		const price = klines.length > 0 ? (priceMode === "open" ? klines[0].open : klines[0].close) : null;
		const marketValue = price != null ? h.quantity * price : 0;
		const unrealizedPnl = marketValue - h.totalCost;

		holdingsValue += marketValue;
		holdingsTotalCost += h.totalCost;

		holdingDetails.push({
			code: h.code,
			market: h.market,
			quantity: h.quantity,
			avgCost: h.avgCost,
			marketPrice: price,
			marketValue,
			unrealizedPnl,
		});
	}

	const totalValue = cash + holdingsValue;
	const totalCost = holdingsTotalCost;
	const unrealizedPnl = holdingsValue - holdingsTotalCost;
	const unrealizedPnlPct = holdingsTotalCost > 0 ? (unrealizedPnl / holdingsTotalCost) * 100 : 0;

	return {
		date: asOfDate,
		cash,
		holdings: holdingDetails,
		totalValue,
		totalCost,
		unrealizedPnl,
		unrealizedPnlPct,
	};
}

/**
 * Build daily equity curve for a portfolio over a date range.
 * Uses market calendar (000001.SH klines) to determine trading days.
 * Falls back to first stock's kline dates if market index not available.
 */
export async function buildPortfolioEquityCurve(
	portfolioId: number,
	startDate: string,
	endDate: string,
	priceMode: "open" | "close" = "close",
): Promise<EquityPoint[]> {
	const store = getDataStore();
	if (!store) throw new Error("DataStore not initialized");

	const portfolio = await store.getPortfolioById(portfolioId);
	if (!portfolio) throw new Error(`Portfolio ${portfolioId} not found`);

	const trades = await store.getPortfolioTrades(portfolioId, startDate, endDate);

	// Gather unique stocks for pre-fetch
	const uniqueStocks = new Map<string, { code: string; market: number }>();
	for (const t of trades) {
		uniqueStocks.set(`${t.code}:${t.market}`, { code: t.code, market: t.market });
	}

	// ── Trading calendar ───────────────────────────────────────────
	// Try SSE market index first, then fallback to any stock's dates
	let tradingDays: string[] = [];
	const marketKlines = await store.getKlines({
		code: "000001",
		market: 1,
		period: "daily",
		adjust: "bfq",
		start: startDate,
		end: endDate,
	});
	if (marketKlines.length > 0) {
		tradingDays = marketKlines.map((k) => k.date);
	} else if (uniqueStocks.size > 0) {
		const firstStock = uniqueStocks.values().next().value!;
		const fallbackKlines = await store.getKlines({
			code: firstStock.code,
			market: firstStock.market,
			period: "daily",
			adjust: "bfq",
			start: startDate,
			end: endDate,
		});
		tradingDays = fallbackKlines.map((k) => k.date);
	}
	if (tradingDays.length === 0) return [];

	// ── Pre-fetch all bfq klines and adjustment factors ────────────
	const priceCache = new Map<string, Map<string, number | null>>(); // "code:market" -> date -> price
	for (const { code, market } of uniqueStocks.values()) {
		const bfqKlines = await store.getKlines({
			code,
			market,
			period: "daily",
			adjust: "bfq",
			start: startDate,
			end: endDate,
		});
		const factors = await store.getAdjustFactors(code, market, startDate, endDate);

		// Apply qfq adjustment dynamically (qfq data may not exist in DB)
		const adjustedKlines = factors.length > 0 ? applyAdjustment(bfqKlines, factors, "qfq") : bfqKlines;

		const dateMap = new Map<string, number | null>();
		for (const k of adjustedKlines) {
			const price = priceMode === "open" ? k.open : k.close;
			dateMap.set(k.date, price);
		}
		priceCache.set(`${code}:${market}`, dateMap);
	}

	// ── Build equity curve day by day ──────────────────────────────
	const curve: EquityPoint[] = [];
	let cash = portfolio.initial_cash;
	const positions = new Map<string, PortfolioHolding>();
	let tradeIdx = 0;

	for (const date of tradingDays) {
		// Apply trades on this day
		while (tradeIdx < trades.length && trades[tradeIdx].trade_date === date) {
			const t = trades[tradeIdx];
			const key = `${t.code}:${t.market}`;
			const totalCost = t.quantity * t.price;
			const fees = (t.commission ?? 0) + (t.tax ?? 0);

			if (t.direction === "buy") {
				const pos = positions.get(key);
				if (pos) {
					const newTotalCost = pos.totalCost + totalCost + fees;
					const newQty = pos.quantity + t.quantity;
					pos.quantity = newQty;
					pos.avgCost = newTotalCost / newQty;
					pos.totalCost = newTotalCost;
				} else {
					positions.set(key, {
						code: t.code,
						market: t.market,
						quantity: t.quantity,
						avgCost: (totalCost + fees) / t.quantity,
						totalCost: totalCost + fees,
					});
				}
				cash -= totalCost + fees;
			} else {
				const pos = positions.get(key);
				if (pos) {
					const proceeds = totalCost - fees;
					pos.quantity -= t.quantity;
					pos.totalCost = pos.avgCost * pos.quantity;
					if (pos.quantity <= 0) positions.delete(key);
					cash += proceeds;
				}
			}
			tradeIdx++;
		}

		// Compute holdings market value for this day using cached prices
		let holdingsValue = 0;
		for (const [, pos] of positions) {
			const price = priceCache.get(`${pos.code}:${pos.market}`)?.get(date) ?? null;
			if (price != null) holdingsValue += pos.quantity * price;
		}

		curve.push({ date, equity: cash + holdingsValue });
	}

	return curve;
}
