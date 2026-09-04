import type { DataStore } from "../data/index.js";

const DEFAULT_LOOKBACK_DAYS = 60;
const TRADING_DAYS_PER_YEAR = 252;

export interface MultiFactorScore {
	code: string;
	name?: string | null;
	market: number;
	/** Value factor Z-score: 0.5*(1/PE) + 0.5*(1/PB) */
	valueZ: number;
	/** Momentum factor Z-score: 60-day return */
	momentumZ: number;
	/** Quality factor Z-score: ROE */
	qualityZ: number;
	/** Low-volatility factor Z-score: negated annualised volatility */
	lowVolZ: number;
	/** Equal-weight composite Z-score */
	composite: number;
}

export interface MultiFactorStats {
	value: { mean: number; std: number };
	momentum: { mean: number; std: number };
	quality: { mean: number; std: number };
	lowVol: { mean: number; std: number };
}

export interface MultiFactorContext {
	scores: MultiFactorScore[];
	topScores: MultiFactorScore[];
	bottomScores: MultiFactorScore[];
	stats: MultiFactorStats;
	latestDate: string;
	lookbackDays: number;
}

interface QuoteFactorData {
	code: string;
	market: number;
	name?: string | null;
	pe: number;
	pb: number;
	totalCap: number;
}

interface KlineCloseData {
	code: string;
	market: number;
	date: string;
	close: number;
}

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function tradingDaysAgo(dateStr: string, days: number): string {
	const y = Number(dateStr.slice(0, 4));
	const m = Number(dateStr.slice(5, 7)) - 1;
	const d = Number(dateStr.slice(8, 10));
	const date = new Date(y, m, d);
	date.setDate(date.getDate() - days);
	return formatDate(date);
}

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
	if (values.length === 0) return 0;
	const mean = avg(values);
	const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
	return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
	return sorted[index];
}

function winsorize(values: number[]): number[] {
	if (values.length === 0) return [];
	const lower = percentile(values, 0.01);
	const upper = percentile(values, 0.99);
	return values.map((v) => Math.max(lower, Math.min(upper, v)));
}

function zScore(values: number[]): number[] {
	if (values.length === 0) return [];
	const mean = avg(values);
	const s = std(values);
	if (s === 0) return values.map(() => 0);
	return values.map((v) => (v - mean) / s);
}

async function fetchQuoteFactors(store: DataStore, latestDate: string): Promise<QuoteFactorData[]> {
	const rows = (await store.query<{
		code: string;
		market: number;
		name: string | null;
		pe: number | null;
		pb: number | null;
		total_cap: number | null;
	}>(
		`
		SELECT code, market, name, pe, pb, total_cap
		FROM quotes
		WHERE snapshot_date = ? AND pe > 0 AND pb > 0 AND total_cap IS NOT NULL
	`,
		[latestDate],
	)) as {
		code: string;
		market: number;
		name: string | null;
		pe: number | null;
		pb: number | null;
		total_cap: number | null;
	}[];

	return rows.map((r) => ({
		code: r.code,
		market: r.market,
		name: r.name,
		pe: r.pe ?? 0,
		pb: r.pb ?? 0,
		totalCap: r.total_cap ?? 0,
	}));
}

async function fetchRoeMap(store: DataStore): Promise<Map<string, number>> {
	const rows = (await store.query<{
		code: string;
		market: number;
		roe: number | null;
	}>(`
		SELECT fi.code, fi.market, fi.roe
		FROM fundamental_indicators fi
		JOIN (
			SELECT code, market, MAX(report_date) as max_date
			FROM fundamental_indicators
			WHERE roe IS NOT NULL
			GROUP BY code, market
		) latest ON fi.code = latest.code AND fi.market = latest.market AND fi.report_date = latest.max_date
		WHERE fi.roe IS NOT NULL
	`)) as { code: string; market: number; roe: number | null }[];

	const map = new Map<string, number>();
	for (const row of rows) {
		map.set(`${row.code}:${row.market}`, row.roe ?? 0);
	}
	return map;
}

async function fetchKlineCloses(
	store: DataStore,
	latestDate: string,
	lookbackDays: number,
): Promise<Map<string, KlineCloseData[]>> {
	const startDate = tradingDaysAgo(latestDate, lookbackDays + 10); // buffer for holidays/weekends
	const rows = (await store.query<{
		code: string;
		market: number;
		date: string;
		close: number | null;
	}>(
		`
		SELECT code, market, date, close
		FROM klines
		WHERE period = 'daily' AND adjust = 'bfq' AND date <= ? AND date >= ?
		ORDER BY code, market, date ASC
	`,
		[latestDate, startDate],
	)) as { code: string; market: number; date: string; close: number | null }[];

	const map = new Map<string, KlineCloseData[]>();
	for (const row of rows) {
		if (row.close == null) continue;
		const key = `${row.code}:${row.market}`;
		if (!map.has(key)) map.set(key, []);
		map.get(key)!.push({ code: row.code, market: row.market, date: row.date, close: row.close });
	}
	return map;
}

function computeMomentumAndVolatility(
	closes: KlineCloseData[],
	lookbackDays: number,
): { momentum: number; volatility: number } | null {
	if (closes.length < lookbackDays * 0.5) return null;
	const recent = closes.slice(-lookbackDays);
	if (recent.length < 2) return null;
	const firstClose = recent[0].close;
	const lastClose = recent.at(-1)!.close;
	if (firstClose <= 0) return null;
	const momentum = lastClose / firstClose - 1;

	const returns: number[] = [];
	for (let i = 1; i < recent.length; i++) {
		const prev = recent[i - 1].close;
		const curr = recent[i].close;
		if (prev > 0) returns.push(curr / prev - 1);
	}
	if (returns.length < 5) return null;
	const dailyStd = std(returns);
	const volatility = dailyStd * Math.sqrt(TRADING_DAYS_PER_YEAR);
	return { momentum, volatility };
}

export async function computeMultiFactorScores(
	store: DataStore,
	latestDate: string,
	options?: {
		minTotalCap?: number;
		lookbackDays?: number;
		topN?: number;
		bottomN?: number;
	},
): Promise<MultiFactorContext | null> {
	const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
	const minTotalCap = options?.minTotalCap ?? 1; // total_cap is stored in billions CNY; default >= 1B CNY
	const topN = options?.topN ?? 20;
	const bottomN = options?.bottomN ?? 20;

	const quotes = await fetchQuoteFactors(store, latestDate);
	if (quotes.length === 0) return null;

	const roeMap = await fetchRoeMap(store);
	const klineMap = await fetchKlineCloses(store, latestDate, lookbackDays);

	const candidates: {
		code: string;
		market: number;
		name?: string | null;
		value: number;
		momentum: number;
		quality: number;
		lowVol: number;
	}[] = [];

	for (const q of quotes) {
		if (q.totalCap < minTotalCap) continue;
		const roe = roeMap.get(`${q.code}:${q.market}`);
		if (roe == null || roe <= 0) continue;
		const klines = klineMap.get(`${q.code}:${q.market}`);
		if (!klines || klines.length === 0) continue;
		const mv = computeMomentumAndVolatility(klines, lookbackDays);
		if (!mv) continue;

		const value = 0.5 * (1 / q.pe) + 0.5 * (1 / q.pb);
		candidates.push({
			code: q.code,
			market: q.market,
			name: q.name,
			value,
			momentum: mv.momentum,
			quality: roe,
			lowVol: -mv.volatility,
		});
	}

	if (candidates.length < 20) return null;

	const valueRaw = winsorize(candidates.map((c) => c.value));
	const momentumRaw = winsorize(candidates.map((c) => c.momentum));
	const qualityRaw = winsorize(candidates.map((c) => c.quality));
	const lowVolRaw = winsorize(candidates.map((c) => c.lowVol));

	const valueZ = zScore(valueRaw);
	const momentumZ = zScore(momentumRaw);
	const qualityZ = zScore(qualityRaw);
	const lowVolZ = zScore(lowVolRaw);

	const scores: MultiFactorScore[] = candidates.map((c, i) => ({
		code: c.code,
		name: c.name,
		market: c.market,
		valueZ: valueZ[i],
		momentumZ: momentumZ[i],
		qualityZ: qualityZ[i],
		lowVolZ: lowVolZ[i],
		composite: (valueZ[i] + momentumZ[i] + qualityZ[i] + lowVolZ[i]) / 4,
	}));

	scores.sort((a, b) => b.composite - a.composite);

	return {
		scores,
		topScores: scores.slice(0, topN),
		bottomScores: scores.slice(-bottomN).reverse(),
		stats: {
			value: { mean: avg(valueRaw), std: std(valueRaw) },
			momentum: { mean: avg(momentumRaw), std: std(momentumRaw) },
			quality: { mean: avg(qualityRaw), std: std(qualityRaw) },
			lowVol: { mean: avg(lowVolRaw), std: std(lowVolRaw) },
		},
		latestDate,
		lookbackDays,
	};
}
