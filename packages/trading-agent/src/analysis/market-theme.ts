import type { DataStore } from "../data/index.js";
import type { QuoteRow } from "../data/types.js";

const DEFAULT_LOOKBACK_DAYS = 5;
const MAIN_BOARD_LIMIT = 9.9;
const KCB_CYB_LIMIT = 19.9;
const BSE_LIMIT = 29.9;
const ST_LIMIT = 4.9;

export interface ExternalConceptData {
	name: string;
	latestChangePct: number | null;
	windowChangePct: number | null;
	turnoverYi: number | null;
	limitUpCount: number | null;
	leadingStocks: Array<{ code: string; name: string; changePct: number | null }>;
	source: string;
}

export interface ThemeOptions {
	lookbackDays?: number;
	endDate?: string;
	externalConcepts?: ExternalConceptData[];
}

export interface BoardStats {
	date: string;
	total: number;
	up: number;
	down: number;
	flat: number;
	limitUp: number;
	limitDown: number;
	approxTurnoverYi: number | null;
}

export interface LianbanStock {
	code: string;
	market: number;
	name: string;
	streak: number;
	totalLimitUpsInWindow: number;
	latestChangePct: number;
	marketCap: number | null;
}

export interface SectorMomentum {
	code: string;
	name: string;
	latestChangePct: number | null;
	cumulativeReturn: number | null;
	latestRank: number;
	windowRank: number;
	upDays: number;
	downDays: number;
	momentumProxy?: boolean;
	external?: boolean;
	limitUpCount?: number;
	turnoverYi?: number | null;
	newsMentions?: number;
}

export interface NewsTheme {
	theme: string;
	mentions: number;
	positive: number;
	negative: number;
	neutral: number;
	recentTitles: string[];
}

export interface LeaderStock {
	code: string;
	market: number;
	name: string;
	tier: "情绪龙头" | "趋势中军" | "补涨标的" | "后排跟风";
	cumulativeReturn: number;
	latestChangePct: number | null;
	marketCap: number | null;
	avgTurnover: number;
	latestTurnover: number | null;
	streak: number;
	limitUpCount: number;
	sector?: string;
}

export interface ThemeSustainability {
	theme: string;
	industryLogic: "弱" | "一般" | "较强" | "强";
	catalyst: "弱" | "一般" | "较强" | "强";
	capitalConvergence: "弱" | "一般" | "较强" | "强";
	overall: "弱" | "一般" | "较强" | "强";
	trigger: string;
}

export interface SentimentCycle {
	phase: "冰点" | "修复" | "主升" | "高位震荡" | "退潮";
	maxStreak: number;
	limitUpTrend: "上升" | "下降" | "震荡";
	limitDownSpike: boolean;
	highPositionFeedback: "差" | "一般" | "好";
	firstBoardRatio: number | null;
	openBoardRate: number | null;
	reason: string;
}

export interface MarketThemeAnalysis {
	window: { startDate: string; endDate: string; lookbackDays: number; tradingDates: string[] };
	boardStats: BoardStats[];
	latestStats: BoardStats;
	lianbanStocks: LianbanStock[];
	sectors: SectorMomentum[];
	newsThemes: NewsTheme[];
	leaders: LeaderStock[];
	sentiment: SentimentCycle;
	sustainability: ThemeSustainability[];
	sections: {
		marketEnvironment: string;
		mainTheme: string;
		secondaryThemes: string;
		coreAnchors: string;
		sentimentCycle: string;
		sustainability: string;
		tomorrowWatch: string;
		conclusion: string;
	};
}

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function isIpoName(name: string | null | undefined): boolean {
	if (!name) return false;
	return name.startsWith("N") || name.startsWith("C");
}

function isStName(name: string | null | undefined): boolean {
	if (!name) return false;
	return name.includes("ST") || name.includes("*ST");
}

function detectBoardLimit(code: string, name?: string | null): { up: number; down: number } {
	const n = name ?? "";
	if (n.includes("ST") || n.includes("*ST")) {
		return { up: ST_LIMIT, down: -ST_LIMIT };
	}
	if (code.startsWith("688") || code.startsWith("689") || code.startsWith("300") || code.startsWith("301")) {
		return { up: KCB_CYB_LIMIT, down: -KCB_CYB_LIMIT };
	}
	if (code.startsWith("8") || code.startsWith("4") || code.startsWith("92") || code.startsWith("43")) {
		return { up: BSE_LIMIT, down: -BSE_LIMIT };
	}
	return { up: MAIN_BOARD_LIMIT, down: -MAIN_BOARD_LIMIT };
}

function isLimitUp(changePct: number, limit: number): boolean {
	// Must be within 0.5% of the exact board limit — consistent with backtest engine.
	// Previous `>= limit * 0.99` was too loose (e.g. 9.91% counted as limit-up on 10% board).
	return Math.abs(changePct - limit) < 0.5;
}

function isLimitDown(changePct: number, limit: number): boolean {
	// limit is already negative (e.g., -10). Check within 0.5% of exact limit.
	return Math.abs(changePct - limit) < 0.5;
}

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function rank<T>(items: T[], key: (item: T) => number, ascending = false): number[] {
	const indexed = items.map((item, i) => ({ item, i, value: key(item) }));
	indexed.sort((a, b) => (ascending ? a.value - b.value : b.value - a.value));
	const ranks = new Array(items.length).fill(0);
	for (let i = 0; i < indexed.length; i++) {
		ranks[indexed[i].i] = i + 1;
	}
	return ranks;
}

function rankWithMissing<T>(items: T[], key: (item: T) => number | null | undefined, ascending = false): number[] {
	const indexed = items.map((item, i) => ({ item, i, value: key(item) }));
	const valid = indexed.filter((v) => v.value != null && !Number.isNaN(v.value));
	valid.sort((a, b) => (ascending ? a.value! - b.value! : b.value! - a.value!));
	const worstRank = valid.length + 1;
	const rankMap = new Map<number, number>();
	for (let i = 0; i < valid.length; i++) {
		rankMap.set(valid[i].i, i + 1);
	}
	const ranks = new Array(items.length).fill(worstRank);
	for (let i = 0; i < items.length; i++) {
		if (rankMap.has(i)) ranks[i] = rankMap.get(i)!;
	}
	return ranks;
}

function parseAffectedSectors(raw: string | null): { benefit: string[]; harm: string[] } {
	if (!raw) return { benefit: [], harm: [] };
	try {
		const parsed = JSON.parse(raw) as { benefit?: string[]; harm?: string[] };
		return {
			benefit: Array.isArray(parsed.benefit) ? parsed.benefit : [],
			harm: Array.isArray(parsed.harm) ? parsed.harm : [],
		};
	} catch {
		return { benefit: [], harm: [] };
	}
}

async function determineDateWindow(
	store: DataStore,
	options?: ThemeOptions,
): Promise<{ startDate: string; endDate: string; lookbackDays: number; tradingDates: string[] }> {
	const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
	let endDate = options?.endDate;
	if (!endDate) {
		const rows = await store.query<{ max_date: string }>("SELECT MAX(snapshot_date) as max_date FROM quotes");
		endDate = rows[0]?.max_date ?? formatDate(new Date());
	}
	// Use actual trading dates from quotes so the window contains exactly lookbackDays trading days.
	const rows = await store.query<{ snapshot_date: string }>(
		`SELECT DISTINCT snapshot_date FROM quotes WHERE snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT ?`,
		[endDate, lookbackDays],
	);
	const tradingDates = rows.map((r) => r.snapshot_date).sort();
	const startDate = tradingDates.length > 0 ? tradingDates[0] : endDate;
	return { startDate, endDate, lookbackDays, tradingDates };
}

async function fetchQuotesInWindow(store: DataStore, startDate: string, endDate: string): Promise<QuoteRow[]> {
	const rows = (await store.query<{
		code: string;
		market: number;
		name: string | null;
		snapshot_date: string;
		change_pct: number | null;
		turnover: number | null;
		total_cap: number | null;
		float_cap: number | null;
		latest: number | null;
	}>(
		`
		SELECT code, market, name, snapshot_date, change_pct, turnover, total_cap, float_cap, latest
		FROM quotes
		WHERE snapshot_date >= ? AND snapshot_date <= ?
		ORDER BY snapshot_date, code
	`,
		[startDate, endDate],
	)) as {
		code: string;
		market: number;
		name: string | null;
		snapshot_date: string;
		change_pct: number | null;
		turnover: number | null;
		total_cap: number | null;
		float_cap: number | null;
		latest: number | null;
	}[];

	return rows
		.filter((r) => !isIpoName(r.name))
		.map((r) => ({
			code: r.code,
			market: r.market,
			name: r.name ?? undefined,
			snapshot_date: r.snapshot_date,
			latest: r.latest,
			open: null,
			high: null,
			low: null,
			prev_close: null,
			volume: null,
			turnover: r.turnover,
			change_pct: r.change_pct,
			pe: null,
			pb: null,
			total_cap: r.total_cap,
			float_cap: r.float_cap,
			high_52w: null,
			low_52w: null,
		}));
}

export function computeBoardStats(quotes: QuoteRow[]): BoardStats[] {
	const byDate = new Map<string, QuoteRow[]>();
	for (const q of quotes) {
		if (!byDate.has(q.snapshot_date)) byDate.set(q.snapshot_date, []);
		byDate.get(q.snapshot_date)!.push(q);
	}

	const dates = [...byDate.keys()].sort();
	return dates.map((date) => {
		const dayQuotes = byDate.get(date)!;
		let up = 0;
		let down = 0;
		let flat = 0;
		let limitUp = 0;
		let limitDown = 0;
		let turnover = 0;
		for (const q of dayQuotes) {
			const pct = q.change_pct ?? 0;
			if (pct > 0.001) up++;
			else if (pct < -0.001) down++;
			else flat++;
			const limit = detectBoardLimit(q.code, q.name);
			if (isLimitUp(pct, limit.up)) limitUp++;
			if (isLimitDown(pct, limit.down)) limitDown++;
			if (q.turnover != null) turnover += q.turnover;
		}
		return {
			date,
			total: dayQuotes.length,
			up,
			down,
			flat,
			limitUp,
			limitDown,
			approxTurnoverYi: turnover > 0 ? turnover / 10000 : null,
		};
	});
}

export function computeLianbanStocks(quotes: QuoteRow[], _endDate: string): LianbanStock[] {
	const byStock = new Map<string, QuoteRow[]>();
	for (const q of quotes) {
		const key = `${q.code}:${q.market}`;
		if (!byStock.has(key)) byStock.set(key, []);
		byStock.get(key)!.push(q);
	}

	const result: LianbanStock[] = [];
	for (const [, dayQuotes] of byStock) {
		const sorted = dayQuotes.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
		const hasStName = sorted.some((q) => isStName(q.name));
		const hasIpoName = sorted.some((q) => isIpoName(q.name));
		if (hasStName || hasIpoName) continue;
		let streak = 0;
		let totalLimitUps = 0;
		for (let i = sorted.length - 1; i >= 0; i--) {
			const q = sorted[i];
			const pct = q.change_pct ?? 0;
			const limit = detectBoardLimit(q.code, q.name);
			if (isLimitUp(pct, limit.up)) {
				totalLimitUps++;
				if (i === sorted.length - 1 - streak) {
					streak++;
				}
			} else {
				break;
			}
		}
		if (streak >= 2) {
			const latest = sorted[sorted.length - 1];
			result.push({
				code: latest.code,
				market: latest.market,
				name: latest.name ?? latest.code,
				streak,
				totalLimitUpsInWindow: totalLimitUps,
				latestChangePct: latest.change_pct ?? 0,
				marketCap: latest.total_cap ?? null,
			});
		}
	}

	return result.sort((a, b) => b.streak - a.streak || b.totalLimitUpsInWindow - a.totalLimitUpsInWindow);
}

async function computeOpenBoardRate(store: DataStore, endDate: string): Promise<number | null> {
	const rows = (await store.query<{
		code: string;
		market: number;
		high: number | null;
		close: number | null;
		pre_close: number | null;
		name: string | null;
	}>(
		`
		SELECT k.code, k.market, k.high, k.close, k.pre_close, q.name
		FROM klines k
		LEFT JOIN quotes q ON k.code = q.code AND k.market = q.market AND q.snapshot_date = k.date
		WHERE k.period = 'daily' AND k.adjust = 'bfq' AND k.date = ? AND (q.name IS NULL OR (q.name NOT LIKE 'N%' AND q.name NOT LIKE 'C%'))
	`,
		[endDate],
	)) as {
		code: string;
		market: number;
		high: number | null;
		close: number | null;
		pre_close: number | null;
		name: string | null;
	}[];

	let touchedLimitUp = 0;
	let openedBoard = 0;
	for (const r of rows) {
		if (r.high == null || r.close == null || r.pre_close == null || r.pre_close <= 0) continue;
		const limit = detectBoardLimit(r.code, r.name);
		const limitUpPrice = r.pre_close * (1 + limit.up / 100);
		if (r.high >= limitUpPrice * 0.99) {
			touchedLimitUp++;
			if (r.close < limitUpPrice * 0.99) {
				openedBoard++;
			}
		}
	}
	if (touchedLimitUp === 0) return null;
	return openedBoard / touchedLimitUp;
}

async function fetchSectorMomentum(
	store: DataStore,
	quotes: QuoteRow[],
	startDate: string,
	endDate: string,
): Promise<SectorMomentum[]> {
	const rows = (await store.query<{
		code: string;
		name: string | null;
		snapshot_date: string;
		change_pct: number | null;
	}>(
		`
		SELECT code, name, snapshot_date, change_pct
		FROM industry_quotes
		WHERE snapshot_date >= ? AND snapshot_date <= ?
		ORDER BY snapshot_date, code
	`,
		[startDate, endDate],
	)) as {
		code: string;
		name: string | null;
		snapshot_date: string;
		change_pct: number | null;
	}[];

	if (rows.length === 0) {
		const stockSectors = await fetchSectorMomentumFromStocks(store, quotes);
		return stockSectors.length > 0 ? stockSectors : fetchSectorMomentumFromIndicators(store, startDate, endDate);
	}

	// If industry_quotes data is stale relative to the analysis end date, prefer computing sector performance from individual stock quotes.
	const maxIndustryQuoteDate = rows.reduce(
		(max, r) => (r.snapshot_date > max ? r.snapshot_date : max),
		rows[0]?.snapshot_date ?? "",
	);
	if (maxIndustryQuoteDate && maxIndustryQuoteDate < endDate) {
		const stockSectors = await fetchSectorMomentumFromStocks(store, quotes);
		return stockSectors.length > 0 ? stockSectors : fetchSectorMomentumFromIndicators(store, startDate, endDate);
	}

	const byCode = new Map<string, { name: string; changes: number[]; dates: string[] }>();
	for (const r of rows) {
		if (!byCode.has(r.code)) byCode.set(r.code, { name: r.name ?? r.code, changes: [], dates: [] });
		const entry = byCode.get(r.code)!;
		if (r.change_pct != null) entry.changes.push(r.change_pct / 100);
		entry.dates.push(r.snapshot_date);
	}

	const sectors: SectorMomentum[] = [];
	for (const [code, entry] of byCode) {
		if (entry.changes.length === 0) continue;
		const cumulative = entry.changes.reduce((prod, c) => prod * (1 + c), 1) - 1;
		const upDays = entry.changes.filter((c) => c > 0).length;
		const downDays = entry.changes.filter((c) => c < 0).length;
		sectors.push({
			code,
			name: entry.name,
			latestChangePct: entry.changes[entry.changes.length - 1],
			cumulativeReturn: cumulative,
			latestRank: 0,
			windowRank: 0,
			upDays,
			downDays,
			momentumProxy: false,
			limitUpCount: 0,
			turnoverYi: null,
			newsMentions: 0,
		});
	}

	const latestRanks = rank(sectors, (s) => s.latestChangePct ?? -Infinity);
	const windowRanks = rank(sectors, (s) => s.cumulativeReturn ?? -Infinity);
	for (let i = 0; i < sectors.length; i++) {
		sectors[i].latestRank = latestRanks[i];
		sectors[i].windowRank = windowRanks[i];
	}
	return sectors.sort((a, b) => a.windowRank - b.windowRank);
}

async function fetchSectorMomentumFromIndicators(
	store: DataStore,
	startDate: string,
	endDate: string,
): Promise<SectorMomentum[]> {
	const rows = (await store.query<{
		code: string;
		name: string | null;
		date: string;
		momentum_return: number | null;
		momentum_rank: number | null;
	}>(
		`
		SELECT ii.code, idx.name, ii.date, ii.momentum_return, ii.momentum_rank
		FROM industry_indicators ii
		LEFT JOIN industry_indices idx ON ii.code = idx.code
		WHERE ii.period_days = 20 AND ii.date >= ? AND ii.date <= ?
		ORDER BY ii.date, ii.code
	`,
		[startDate, endDate],
	)) as {
		code: string;
		name: string | null;
		date: string;
		momentum_return: number | null;
		momentum_rank: number | null;
	}[];

	const byCode = new Map<string, { name: string; returns: number[]; latestRank: number | null }>();
	for (const r of rows) {
		if (!byCode.has(r.code)) byCode.set(r.code, { name: r.name ?? r.code, returns: [], latestRank: null });
		const entry = byCode.get(r.code)!;
		if (r.momentum_return != null) entry.returns.push(r.momentum_return);
		if (r.date === endDate && r.momentum_rank != null) entry.latestRank = r.momentum_rank;
	}

	const sectors: SectorMomentum[] = [];
	for (const [code, entry] of byCode) {
		if (entry.returns.length === 0) continue;
		const latestReturn = entry.returns[entry.returns.length - 1];
		const cumulative = latestReturn;
		const upDays = latestReturn > 0 ? 1 : 0;
		const downDays = latestReturn < 0 ? 1 : 0;
		sectors.push({
			code,
			name: entry.name,
			latestChangePct: latestReturn,
			cumulativeReturn: cumulative,
			latestRank: entry.latestRank ?? 0,
			windowRank: 0,
			upDays,
			downDays,
			momentumProxy: true,
			limitUpCount: 0,
			turnoverYi: null,
			newsMentions: 0,
		});
	}

	const windowRanks = rank(sectors, (s) => s.cumulativeReturn ?? -Infinity);
	for (let i = 0; i < sectors.length; i++) {
		sectors[i].windowRank = windowRanks[i];
	}
	return sectors.sort((a, b) => a.windowRank - b.windowRank);
}

async function fetchSectorMomentumFromStocks(store: DataStore, quotes: QuoteRow[]): Promise<SectorMomentum[]> {
	// Map each stock to its SW L2 industry. Exclude ST and IPO stocks from driving sector performance.
	const mappingRows = (await store.query<{ code: string; market: number; industry_code: string }>(
		`
		SELECT si.code, si.market, si.industry_code
		FROM stock_industries si
		WHERE si.standard = 'sw_l2'
	`,
		[],
	)) as { code: string; market: number; industry_code: string }[];

	const industryRows = (await store.query<{ industry_code: string; name: string }>(
		`
		SELECT industry_code, name
		FROM industries
		WHERE standard = 'sw_l2'
	`,
		[],
	)) as { industry_code: string; name: string }[];

	const industryNames = new Map(industryRows.map((r) => [r.industry_code, r.name]));
	const stockToIndustry = new Map<string, string>();
	for (const r of mappingRows) {
		stockToIndustry.set(`${r.code}:${r.market}`, r.industry_code);
	}

	const byIndustryDate = new Map<string, Map<string, number[]>>();
	const industryLimitUps = new Map<string, number>();
	for (const q of quotes) {
		if (isStName(q.name) || isIpoName(q.name)) continue;
		const industryCode = stockToIndustry.get(`${q.code}:${q.market}`);
		if (!industryCode) continue;
		if (q.change_pct != null) {
			if (!byIndustryDate.has(industryCode)) byIndustryDate.set(industryCode, new Map());
			const byDate = byIndustryDate.get(industryCode)!;
			if (!byDate.has(q.snapshot_date)) byDate.set(q.snapshot_date, []);
			byDate.get(q.snapshot_date)!.push(q.change_pct / 100);
		}
		const limit = detectBoardLimit(q.code, q.name);
		if (q.change_pct != null && isLimitUp(q.change_pct, limit.up)) {
			industryLimitUps.set(industryCode, (industryLimitUps.get(industryCode) ?? 0) + 1);
		}
	}

	const sectors: SectorMomentum[] = [];
	for (const [industryCode, byDate] of byIndustryDate) {
		const dates = [...byDate.keys()].sort();
		if (dates.length === 0) continue;
		const dailyReturns = dates.map((d) => avg(byDate.get(d)!));
		const cumulative = dailyReturns.reduce((prod, c) => prod * (1 + c), 1) - 1;
		const latest = dailyReturns[dailyReturns.length - 1];
		const upDays = dailyReturns.filter((c) => c > 0).length;
		const downDays = dailyReturns.filter((c) => c < 0).length;
		const limitUpCount = industryLimitUps.get(industryCode) ?? 0;
		sectors.push({
			code: industryCode,
			name: industryNames.get(industryCode) ?? industryCode,
			latestChangePct: latest,
			cumulativeReturn: cumulative,
			latestRank: 0,
			windowRank: 0,
			upDays,
			downDays,
			momentumProxy: false,
			limitUpCount,
			turnoverYi: null,
			newsMentions: 0,
		});
	}

	const latestRanks = rank(sectors, (s) => s.latestChangePct ?? -Infinity);
	const windowRanks = rank(sectors, (s) => s.cumulativeReturn ?? -Infinity);
	for (let i = 0; i < sectors.length; i++) {
		sectors[i].latestRank = latestRanks[i];
		sectors[i].windowRank = windowRanks[i];
	}
	return sectors.sort((a, b) => a.windowRank - b.windowRank);
}

function normalizeConceptName(name: string): string {
	return name.replace(/概念$/, "").replace(/板块$/, "").trim();
}

export function mergeExternalConcepts(
	localSectors: SectorMomentum[],
	externalConcepts: ExternalConceptData[] | undefined,
): SectorMomentum[] {
	if (!externalConcepts || externalConcepts.length === 0) return localSectors;

	const sectors = [...localSectors];
	for (const ext of externalConcepts) {
		const normalized = normalizeConceptName(ext.name);
		const matchIndex = sectors.findIndex(
			(s) =>
				s.name === ext.name ||
				s.name.includes(ext.name) ||
				ext.name.includes(s.name) ||
				s.name.includes(normalized) ||
				normalized.includes(s.name),
		);

		if (matchIndex >= 0) {
			const s = sectors[matchIndex];
			s.external = true;
			s.limitUpCount = Math.max(s.limitUpCount ?? 0, ext.limitUpCount ?? 0);
			if (s.turnoverYi == null && ext.turnoverYi != null) s.turnoverYi = ext.turnoverYi;
			if (ext.windowChangePct != null) {
				s.cumulativeReturn = ext.windowChangePct / 100;
			} else if (s.cumulativeReturn == null && ext.latestChangePct != null) {
				s.cumulativeReturn = ext.latestChangePct / 100;
			}
			if (s.latestChangePct == null && ext.latestChangePct != null) {
				s.latestChangePct = ext.latestChangePct / 100;
			}
		} else {
			sectors.push({
				code: `ext:${ext.name}`,
				name: ext.name,
				latestChangePct: ext.latestChangePct != null ? ext.latestChangePct / 100 : null,
				cumulativeReturn:
					ext.windowChangePct != null
						? ext.windowChangePct / 100
						: ext.latestChangePct != null
							? ext.latestChangePct / 100
							: null,
				latestRank: 0,
				windowRank: 0,
				upDays: 0,
				downDays: 0,
				external: true,
				momentumProxy: true,
				limitUpCount: ext.limitUpCount ?? 0,
				turnoverYi: ext.turnoverYi,
				newsMentions: 0,
			});
		}
	}
	return sectors;
}

export function scoreSectors(sectors: SectorMomentum[], newsThemes: NewsTheme[]): SectorMomentum[] {
	// Enrich with news mentions.
	for (const s of sectors) {
		s.newsMentions = newsThemes
			.filter((n) => s.name.includes(n.theme) || n.theme.includes(s.name))
			.reduce((sum, n) => sum + n.mentions, 0);
	}

	const cumulativeRanks = rankWithMissing(sectors, (s) => s.cumulativeReturn);
	const latestRanks = rankWithMissing(sectors, (s) => s.latestChangePct);
	const heatRanks = rank(sectors, (s) => (s.limitUpCount ?? 0) + (s.newsMentions ?? 0) * 0.5);
	const turnoverRanks = rankWithMissing(sectors, (s) => s.turnoverYi);
	const persistenceRanks = rank(sectors, (s) => s.upDays - s.downDays);
	const newsRanks = rank(sectors, (s) => s.newsMentions ?? 0);

	const weights = {
		cumulative: 0.25,
		latest: 0.1,
		heat: 0.2,
		turnover: 0.25,
		persistence: 0.1,
		news: 0.1,
	};

	const scores = sectors.map(
		(_, i) =>
			weights.cumulative * cumulativeRanks[i] +
			weights.latest * latestRanks[i] +
			weights.heat * heatRanks[i] +
			weights.turnover * turnoverRanks[i] +
			weights.persistence * persistenceRanks[i] +
			weights.news * newsRanks[i],
	);

	const indexed = sectors.map((s, i) => ({ s, score: scores[i] }));
	const sortedByScore = [...indexed].sort((a, b) => a.score - b.score);
	for (let i = 0; i < sortedByScore.length; i++) {
		sortedByScore[i].s.windowRank = i + 1;
	}
	return sortedByScore.map(({ s }) => s);
}

async function fetchNewsThemes(store: DataStore, startDate: string): Promise<NewsTheme[]> {
	const rows = (await store.query<{
		source: string;
		title: string;
		pub_time: string;
		sentiment: string | null;
		affected_sectors: string | null;
	}>(
		`
		SELECT source, title, pub_time, sentiment, affected_sectors
		FROM market_news
		WHERE pub_time >= ?
		ORDER BY pub_time DESC
	`,
		[startDate],
	)) as {
		source: string;
		title: string;
		pub_time: string;
		sentiment: string | null;
		affected_sectors: string | null;
	}[];

	const themeMap = new Map<string, NewsTheme>();
	for (const r of rows) {
		const sectors = parseAffectedSectors(r.affected_sectors);
		const themes = sectors.benefit.length > 0 ? sectors.benefit : ["宏观/其他"];
		for (const theme of themes) {
			if (!themeMap.has(theme)) {
				themeMap.set(theme, { theme, mentions: 0, positive: 0, negative: 0, neutral: 0, recentTitles: [] });
			}
			const entry = themeMap.get(theme)!;
			entry.mentions++;
			if (r.sentiment === "positive") entry.positive++;
			else if (r.sentiment === "negative") entry.negative++;
			else entry.neutral++;
			if (entry.recentTitles.length < 5) entry.recentTitles.push(r.title);
		}
	}

	return [...themeMap.values()].sort((a, b) => b.mentions - a.mentions);
}

export function identifyLeaders(quotes: QuoteRow[], lianbanStocks: LianbanStock[]): LeaderStock[] {
	const byStock = new Map<string, QuoteRow[]>();
	for (const q of quotes) {
		const key = `${q.code}:${q.market}`;
		if (!byStock.has(key)) byStock.set(key, []);
		byStock.get(key)!.push(q);
	}

	const stockMetrics: {
		code: string;
		market: number;
		name: string;
		cumulativeReturn: number;
		latestChangePct: number | null;
		marketCap: number | null;
		avgTurnover: number;
		latestTurnover: number | null;
		streak: number;
		limitUpCount: number;
	}[] = [];

	for (const [, dayQuotes] of byStock) {
		const sorted = dayQuotes.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
		const first = sorted[0];
		const latest = sorted[sorted.length - 1];
		const hasStName = sorted.some((q) => isStName(q.name));
		if (hasStName) continue;
		const displayName =
			[...sorted].reverse().find((q) => q.name)?.name ?? sorted.find((q) => q.name)?.name ?? latest.code;
		const cumulativeReturn = first.latest && first.latest > 0 && latest.latest ? latest.latest / first.latest - 1 : 0;
		const turnovers = sorted.map((q) => q.turnover ?? 0).filter((t) => t > 0);
		const avgTurnover = turnovers.length > 0 ? turnovers.reduce((a, b) => a + b, 0) / turnovers.length : 0;
		let limitUpCount = 0;
		for (const q of sorted) {
			const pct = q.change_pct ?? 0;
			const limit = detectBoardLimit(q.code, q.name);
			if (isLimitUp(pct, limit.up)) limitUpCount++;
		}
		const lb = lianbanStocks.find((l) => l.code === first.code && l.market === first.market);
		stockMetrics.push({
			code: first.code,
			market: first.market,
			name: displayName,
			cumulativeReturn,
			latestChangePct: latest.change_pct,
			marketCap: latest.total_cap ?? null,
			avgTurnover,
			latestTurnover: latest.turnover,
			streak: lb?.streak ?? 0,
			limitUpCount,
		});
	}

	const sortedByReturn = [...stockMetrics].sort((a, b) => b.cumulativeReturn - a.cumulativeReturn);
	const topReturn = new Set(
		sortedByReturn.slice(0, Math.max(10, Math.floor(stockMetrics.length * 0.02))).map((s) => `${s.code}:${s.market}`),
	);
	const sortedByTurnover = [...stockMetrics].sort((a, b) => b.avgTurnover - a.avgTurnover);
	const topTurnover = new Set(
		sortedByTurnover
			.slice(0, Math.max(10, Math.floor(stockMetrics.length * 0.02)))
			.map((s) => `${s.code}:${s.market}`),
	);
	const topLianban = lianbanStocks.slice(0, 10);
	const topLianbanKeys = new Set(topLianban.map((l) => `${l.code}:${l.market}`));

	const leaders: LeaderStock[] = [];
	for (const s of stockMetrics) {
		const key = `${s.code}:${s.market}`;
		const hasReturn = topReturn.has(key);
		const hasTurnover = topTurnover.has(key);
		let tier: LeaderStock["tier"] = "后排跟风";
		if (s.streak >= 2 && topLianbanKeys.has(key) && (hasReturn || hasTurnover)) {
			tier = "情绪龙头";
		} else if ((s.marketCap ?? 0) >= 200 && hasTurnover && s.cumulativeReturn >= 0) {
			tier = "趋势中军";
		} else if ((s.marketCap ?? 0) < 100 && s.limitUpCount >= 1 && (hasReturn || hasTurnover)) {
			tier = "补涨标的";
		}
		leaders.push({ ...s, tier });
	}

	return leaders
		.filter((l) => l.tier !== "后排跟风" || l.cumulativeReturn > 0.1)
		.sort((a, b) => b.cumulativeReturn - a.cumulativeReturn)
		.slice(0, 30);
}

async function fetchLeaderSectors(store: DataStore, leaders: LeaderStock[]): Promise<Map<string, string>> {
	if (leaders.length === 0) return new Map();
	const placeholders = leaders.map(() => "(?, ?)").join(", ");
	const params = leaders.flatMap((l) => [l.code, l.market]);
	const rows = (await store.query<{ code: string; market: number; name: string }>(
		`
		SELECT si.code, si.market, i.name
		FROM stock_industries si
		JOIN industries i ON si.industry_code = i.industry_code AND si.standard = i.standard
		WHERE si.standard = 'sw_l2' AND (si.code, si.market) IN (${placeholders})
	`,
		params,
	)) as { code: string; market: number; name: string }[];
	const map = new Map<string, string>();
	for (const r of rows) {
		map.set(`${r.code}:${r.market}`, r.name);
	}
	return map;
}

function assessSentimentCycle(
	boardStats: BoardStats[],
	lianbanStocks: LianbanStock[],
	quotes: QuoteRow[],
	lookbackDays: number,
): SentimentCycle {
	const sorted = [...boardStats].sort((a, b) => a.date.localeCompare(b.date));
	const latest = sorted[sorted.length - 1];
	const prev = sorted[sorted.length - 2];

	const maxStreak = lianbanStocks.length > 0 ? lianbanStocks[0].streak : 0;

	let limitUpTrend: "上升" | "下降" | "震荡" = "震荡";
	if (sorted.length >= 3) {
		const recent = sorted.slice(-3).map((s) => s.limitUp);
		if (recent[2] > recent[1] && recent[1] > recent[0]) limitUpTrend = "上升";
		else if (recent[2] < recent[1] && recent[1] < recent[0]) limitUpTrend = "下降";
	}

	const limitDownSpike = latest.limitDown > 50;

	const firstBoardRatio =
		latest.limitUp > 0
			? (latest.limitUp - (lianbanStocks.length > 0 ? lianbanStocks.length : 0)) / latest.limitUp
			: null;

	const highPositionFeedback = computeHighPositionFeedback(quotes, lookbackDays);

	let phase: SentimentCycle["phase"] = "修复";
	if (maxStreak >= 5 && limitUpTrend === "上升") phase = "主升";
	else if (maxStreak >= 3 && latest.limitDown < 30) phase = "高位震荡";
	else if (latest.limitDown > latest.limitUp || limitDownSpike) phase = "退潮";
	else if (maxStreak <= 2 && latest.limitUp < 30) phase = "冰点";

	const openBoardRate = null;

	const reasons: string[] = [];
	reasons.push(`最高连板 ${maxStreak} 板`);
	reasons.push(`涨停数趋势：${limitUpTrend}（最新 ${latest.limitUp}${prev ? `，前日 ${prev.limitUp}` : ""}）`);
	reasons.push(`跌停 ${latest.limitDown} 家`);
	reasons.push(`高位股反馈：${highPositionFeedback}`);

	return {
		phase,
		maxStreak,
		limitUpTrend,
		limitDownSpike,
		highPositionFeedback,
		firstBoardRatio,
		openBoardRate,
		reason: reasons.join("；"),
	};
}

function computeHighPositionFeedback(quotes: QuoteRow[], _lookbackDays: number): "差" | "一般" | "好" {
	const byStock = new Map<string, QuoteRow[]>();
	for (const q of quotes) {
		const key = `${q.code}:${q.market}`;
		if (!byStock.has(key)) byStock.set(key, []);
		byStock.get(key)!.push(q);
	}

	const metrics: { earlyReturn: number; lateReturn: number }[] = [];
	for (const dayQuotes of byStock.values()) {
		const sorted = dayQuotes.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
		if (sorted.length < 4) continue;
		const earlyDays = sorted.slice(0, Math.max(1, sorted.length - 3));
		const lateDays = sorted.slice(-3);
		const earlyFirst = earlyDays[0];
		const earlyLast = earlyDays[earlyDays.length - 1];
		const lateFirst = lateDays[0];
		const lateLast = lateDays[lateDays.length - 1];
		if (!earlyFirst.latest || !earlyLast.latest || !lateFirst.latest || !lateLast.latest) continue;
		const earlyReturn = earlyLast.latest / earlyFirst.latest - 1;
		const lateReturn = lateLast.latest / lateFirst.latest - 1;
		if (earlyReturn > 0.1) metrics.push({ earlyReturn, lateReturn });
	}

	if (metrics.length === 0) return "一般";
	const avgLate = avg(metrics.map((m) => m.lateReturn));
	if (avgLate < -0.05) return "差";
	if (avgLate > 0.02) return "好";
	return "一般";
}

function evaluateThemeSustainability(sectors: SectorMomentum[], news: NewsTheme[]): ThemeSustainability[] {
	const topSectors = sectors.slice(0, 5);
	return topSectors.map((s) => {
		const relatedNews = news.filter((n) => s.name.includes(n.theme) || n.theme.includes(s.name));
		const capitalScore: ThemeSustainability["capitalConvergence"] =
			s.cumulativeReturn != null && s.cumulativeReturn > 0.05 ? "较强" : "一般";
		const catalystScore: ThemeSustainability["catalyst"] =
			relatedNews.length > 2 ? "较强" : relatedNews.length > 0 ? "一般" : "弱";
		const logicScore: ThemeSustainability["industryLogic"] = s.upDays > s.downDays ? "较强" : "一般";

		const scores = { 弱: 1, 一般: 2, 较强: 3, 强: 4 };
		const avg = (scores[logicScore] + scores[catalystScore] + scores[capitalScore]) / 3;
		let overall: ThemeSustainability["overall"] = "一般";
		if (avg >= 3) overall = "强";
		else if (avg >= 2.5) overall = "较强";
		else if (avg < 1.5) overall = "弱";

		return {
			theme: s.name,
			industryLogic: logicScore,
			catalyst: catalystScore,
			capitalConvergence: capitalScore,
			overall,
			trigger: relatedNews.length > 0 ? `相关事件：${relatedNews[0].recentTitles[0] ?? ""}` : "缺乏新催化",
		};
	});
}

function buildSections(analysis: MarketThemeAnalysis): MarketThemeAnalysis["sections"] {
	const { window, latestStats, lianbanStocks, sectors, newsThemes, leaders, sentiment, sustainability } = analysis;
	const dates = window.startDate === window.endDate ? window.endDate : `${window.startDate} ~ ${window.endDate}`;

	const marketEnvironment = buildMarketEnvironmentSection(window, latestStats, sentiment, dates);
	const mainTheme = buildMainThemeSection(sectors, newsThemes, lianbanStocks, dates);
	const secondaryThemes = buildSecondaryThemesSection(sectors, newsThemes, dates);
	const coreAnchors = buildCoreAnchorsSection(leaders, sectors, dates);
	const sentimentCycle = buildSentimentCycleSection(sentiment, latestStats, dates);
	const sustainabilitySection = buildSustainabilitySection(sustainability);
	const tomorrowWatch = buildTomorrowWatchSection(leaders, sectors, newsThemes, sentiment);
	const conclusion = buildConclusionSection(sectors, sentiment, sustainability);

	return {
		marketEnvironment,
		mainTheme,
		secondaryThemes,
		coreAnchors,
		sentimentCycle,
		sustainability: sustainabilitySection,
		tomorrowWatch,
		conclusion,
	};
}

function buildMarketEnvironmentSection(
	window: MarketThemeAnalysis["window"],
	latest: BoardStats,
	sentiment: SentimentCycle,
	dates: string,
): string {
	const lines: string[] = [];
	const actualDays = window.tradingDates.length;
	const gapNote = actualDays < window.lookbackDays ? "（数据有缺）" : "";
	lines.push(`分析窗口：${dates}（实际 ${actualDays} 个交易日${gapNote}）`);
	lines.push(
		`最新交易日 ${latest.date}：上涨 ${latest.up} 家 / 下跌 ${latest.down} 家 / 平盘 ${latest.flat} 家，涨停 ${latest.limitUp} 家，跌停 ${latest.limitDown} 家。`,
	);
	if (latest.approxTurnoverYi != null) {
		lines.push(`成交额约 ${latest.approxTurnoverYi.toFixed(2)} 亿元。`);
	}
	lines.push(
		`情绪周期判断：${sentiment.phase}。最高连板 ${sentiment.maxStreak} 板，涨停数趋势${sentiment.limitUpTrend}，高位股反馈${sentiment.highPositionFeedback}。`,
	);
	lines.push(
		`定性：${sentiment.phase === "主升" || sentiment.phase === "高位震荡" ? "精选参与" : sentiment.phase === "冰点" ? "观望或极小仓位试错" : "控制仓位，围绕主线操作"}。`,
	);
	return lines.join("\n");
}

function buildMainThemeSection(
	sectors: SectorMomentum[],
	news: NewsTheme[],
	lianban: LianbanStock[],
	_dates: string,
): string {
	if (sectors.length === 0) return "数据不足，无法识别主线。";
	const top = sectors[0];
	const relatedNews = news.filter((n) => top.name.includes(n.theme) || n.theme.includes(top.name)).slice(0, 3);
	const lines: string[] = [];
	lines.push(`主线：${top.name}`);
	lines.push(
		`窗口期累计涨幅：${((top.cumulativeReturn ?? 0) * 100).toFixed(2)}%${top.momentumProxy ? "（基于20日动量代理）" : top.external ? "（外部数据源补充）" : `（${top.upDays} 涨 ${top.downDays} 跌）`}，最新单日涨幅 ${((top.latestChangePct ?? 0) * 100).toFixed(2)}%，窗口排名第 ${top.windowRank}。`,
	);
	if (lianban.length > 0) {
		const topLianban = lianban.filter((l) => l.streak >= 2).slice(0, 5);
		lines.push(`连板梯队：${topLianban.map((l) => `${l.name}(${l.streak}连板)`).join("、")}。`);
	}
	if (relatedNews.length > 0) {
		lines.push(
			`消息催化：${relatedNews.map((n) => n.theme).join("、")}（近 ${relatedNews[0]?.mentions ?? 0} 条相关）。`,
		);
	}
	return lines.join("\n");
}

function buildSecondaryThemesSection(sectors: SectorMomentum[], news: NewsTheme[], _dates: string): string {
	if (sectors.length <= 1) return "暂无明确次级热点。";
	const secondary = sectors.slice(1, 4);
	const lines: string[] = [];
	for (const s of secondary) {
		const relatedNews = news.filter((n) => s.name.includes(n.theme) || n.theme.includes(s.name)).slice(0, 1);
		lines.push(
			`- ${s.name}：窗口累计 ${((s.cumulativeReturn ?? 0) * 100).toFixed(2)}%${s.momentumProxy ? "（20日动量代理）" : s.external ? "（外部数据源）" : ""}，最新 ${((s.latestChangePct ?? 0) * 100).toFixed(2)}%${relatedNews.length > 0 ? `，催化：${relatedNews[0].theme}` : ""}`,
		);
	}
	return lines.join("\n");
}

function buildCoreAnchorsSection(leaders: LeaderStock[], sectors: SectorMomentum[], _dates: string): string {
	if (leaders.length === 0) return "暂无明确龙头/中军数据。";

	const targetSectors = sectors.slice(0, 4).map((s) => s.name);
	const bySector = new Map<string, Map<LeaderStock["tier"], LeaderStock[]>>();
	const otherLeaders: LeaderStock[] = [];

	for (const l of leaders) {
		const sectorName = l.sector;
		if (
			!sectorName ||
			!targetSectors.some((s) => sectorName === s || sectorName.includes(s) || s.includes(sectorName))
		) {
			otherLeaders.push(l);
			continue;
		}
		if (!bySector.has(sectorName)) {
			bySector.set(sectorName, new Map());
		}
		const byTier = bySector.get(sectorName)!;
		if (!byTier.has(l.tier)) byTier.set(l.tier, []);
		byTier.get(l.tier)!.push(l);
	}

	const lines: string[] = [];
	for (const sectorName of targetSectors) {
		const byTier = bySector.get(sectorName);
		if (!byTier) continue;
		lines.push(`${sectorName}：`);
		for (const tier of ["情绪龙头", "趋势中军", "补涨标的"] as LeaderStock["tier"][]) {
			const items = (byTier.get(tier) ?? []).slice(0, 4);
			if (items.length === 0) continue;
			lines.push(
				`  ${tier}：${items.map((l) => `${l.name}(${l.code}${l.streak > 0 ? `, ${l.streak}连板` : ""}, 累计${(l.cumulativeReturn * 100).toFixed(1)}%)`).join("、")}`,
			);
		}
	}

	if (otherLeaders.length > 0) {
		const byTierOther = new Map<LeaderStock["tier"], LeaderStock[]>();
		for (const l of otherLeaders) {
			if (!byTierOther.has(l.tier)) byTierOther.set(l.tier, []);
			byTierOther.get(l.tier)!.push(l);
		}
		lines.push("其他板块：");
		for (const tier of ["情绪龙头", "趋势中军", "补涨标的"] as LeaderStock["tier"][]) {
			const items = (byTierOther.get(tier) ?? []).slice(0, 3);
			if (items.length === 0) continue;
			lines.push(
				`  ${tier}：${items.map((l) => `${l.name}(${l.code}${l.streak > 0 ? `, ${l.streak}连板` : ""}, 累计${(l.cumulativeReturn * 100).toFixed(1)}%)`).join("、")}`,
			);
		}
	}

	if (lines.length === 0) return "暂无明确龙头/中军数据。";
	return lines.join("\n");
}

function buildSentimentCycleSection(sentiment: SentimentCycle, latest: BoardStats, _dates: string): string {
	const lines: string[] = [];
	lines.push(`当前阶段：${sentiment.phase}`);
	lines.push(`判断依据：`);
	lines.push(`- 最高连板 ${sentiment.maxStreak} 板`);
	lines.push(`- 涨停数趋势${sentiment.limitUpTrend}，最新 ${latest.limitUp} 家涨停`);
	lines.push(`- 跌停 ${latest.limitDown} 家${sentiment.limitDownSpike ? "（跌停潮信号）" : ""}`);
	lines.push(`- 高位股反馈${sentiment.highPositionFeedback}`);
	if (sentiment.openBoardRate != null) {
		lines.push(`- 炸板率约 ${(sentiment.openBoardRate * 100).toFixed(1)}%`);
	}
	return lines.join("\n");
}

function buildSustainabilitySection(sustainability: ThemeSustainability[]): string {
	if (sustainability.length === 0) return "数据不足，无法评估持续性。";
	const lines: string[] = [];
	for (const s of sustainability.slice(0, 5)) {
		lines.push(
			`- ${s.theme}：综合【${s.overall}】（产业逻辑 ${s.industryLogic} / 事件催化 ${s.catalyst} / 资金合力 ${s.capitalConvergence}）。失效条件：${s.trigger}`,
		);
	}
	return lines.join("\n");
}

function buildTomorrowWatchSection(
	leaders: LeaderStock[],
	sectors: SectorMomentum[],
	news: NewsTheme[],
	sentiment: SentimentCycle,
): string {
	const lines: string[] = [];
	const topLeaders = leaders.filter((l) => l.tier === "情绪龙头").slice(0, 3);
	if (topLeaders.length > 0) {
		lines.push(`核心锚点：${topLeaders.map((l) => `${l.name}能否弱转强/维持溢价`).join("、")}。`);
	}
	if (sectors.length > 0) {
		lines.push(`主线扩散：${sectors[0].name}内部是否有新补涨标的启动、后排是否大面积掉队。`);
	}
	const upcomingEvents = news.slice(0, 3);
	if (upcomingEvents.length > 0) {
		lines.push(`事件落地：${upcomingEvents.map((n) => n.theme).join("、")}相关催化是否兑现。`);
	}
	if (sentiment.limitDownSpike) {
		lines.push("风险信号：若跌停家数继续扩大，需降仓避险。");
	}
	return lines.join("\n");
}

function buildConclusionSection(
	sectors: SectorMomentum[],
	sentiment: SentimentCycle,
	sustainability: ThemeSustainability[],
): string {
	if (sectors.length === 0) return "数据不足，暂无法形成交易结论。";
	const topTheme = sectors[0].name;
	const topSustain = sustainability.find((s) => s.theme === topTheme);
	const action =
		sentiment.phase === "主升"
			? "围绕主线积极操作"
			: sentiment.phase === "高位震荡"
				? "精选龙头、避免后排"
				: "控制仓位、谨慎试错";
	return `${action}；当前主线为${topTheme}（持续性${topSustain?.overall ?? "待观察"}），重点关注龙头与中军承接，若核心标的补跌则全线降仓。`;
}

export function formatMarketTheme(analysis: MarketThemeAnalysis): string {
	const s = analysis.sections;
	return [
		"【1.市场环境】",
		s.marketEnvironment,
		"",
		"【2.当前主线】",
		s.mainTheme,
		"",
		"【3.次级热点】",
		s.secondaryThemes,
		"",
		"【4.核心龙头与中军】",
		s.coreAnchors,
		"",
		"【5.情绪周期】",
		s.sentimentCycle,
		"",
		"【6.主线持续性评估】",
		s.sustainability,
		"",
		"【7.明日观察重点】",
		s.tomorrowWatch,
		"",
		"【8.一句话交易结论】",
		s.conclusion,
	].join("\n");
}

export async function analyzeMarketTheme(store: DataStore, options?: ThemeOptions): Promise<MarketThemeAnalysis> {
	const { startDate, endDate, lookbackDays, tradingDates } = await determineDateWindow(store, options);
	const quotes = await fetchQuotesInWindow(store, startDate, endDate);
	if (quotes.length === 0) {
		throw new Error("No quote data found in the analysis window.");
	}

	const boardStats = computeBoardStats(quotes);
	const latestStats = boardStats[boardStats.length - 1];
	const lianbanStocks = computeLianbanStocks(quotes, endDate);
	const [rawSectors, newsThemes, openBoardRate] = await Promise.all([
		fetchSectorMomentum(store, quotes, startDate, endDate),
		fetchNewsThemes(store, startDate),
		computeOpenBoardRate(store, endDate),
	]);

	const sectors = scoreSectors(mergeExternalConcepts(rawSectors, options?.externalConcepts), newsThemes);

	const leaders = identifyLeaders(quotes, lianbanStocks);
	const leaderSectors = await fetchLeaderSectors(store, leaders);
	for (const l of leaders) {
		l.sector = leaderSectors.get(`${l.code}:${l.market}`);
	}
	const sentiment = assessSentimentCycle(boardStats, lianbanStocks, quotes, lookbackDays);
	sentiment.openBoardRate = openBoardRate;
	const sustainability = evaluateThemeSustainability(sectors, newsThemes);

	const base: MarketThemeAnalysis = {
		window: { startDate, endDate, lookbackDays, tradingDates },
		boardStats,
		latestStats,
		lianbanStocks,
		sectors,
		newsThemes,
		leaders,
		sentiment,
		sustainability,
		sections: {
			marketEnvironment: "",
			mainTheme: "",
			secondaryThemes: "",
			coreAnchors: "",
			sentimentCycle: "",
			sustainability: "",
			tomorrowWatch: "",
			conclusion: "",
		},
	};

	base.sections = buildSections(base);
	return base;
}
