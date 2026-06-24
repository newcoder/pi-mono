import type { DataStore } from "../data/index.js";
import type { TradingIdea } from "./types.js";

const MIN_UNIVERSE_SIZE = 10;
const MIN_LOOKBACK_KLINES = 15;
const MAX_RECENCY_DAYS = 3;

function s(v: string | null | undefined): string {
	if (v == null) return "NULL";
	return `'${v.replace(/'/g, "''")}'`;
}

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
	const ay = Number(a.slice(0, 4));
	const am = Number(a.slice(5, 7)) - 1;
	const ad = Number(a.slice(8, 10));
	const by = Number(b.slice(0, 4));
	const bm = Number(b.slice(5, 7)) - 1;
	const bd = Number(b.slice(8, 10));
	return Math.abs((new Date(ay, am, ad).getTime() - new Date(by, bm, bd).getTime()) / (1000 * 60 * 60 * 24));
}

export async function checkFeasibility(
	store: DataStore,
	idea: TradingIdea,
): Promise<{ pass: boolean; reason: string }> {
	const today = formatDate(new Date());
	const latest = idea.dataSnapshot.latestDate;

	// 1. Recency
	if (!latest) {
		return { pass: false, reason: "没有可用的最新数据日期" };
	}
	if (daysBetween(latest, today) > MAX_RECENCY_DAYS) {
		return { pass: false, reason: `数据最新日期 ${latest} 距今超过 ${MAX_RECENCY_DAYS} 天` };
	}

	// 2. Universe non-empty
	const universeCount = await estimateUniverseSize(store, idea);
	if (universeCount < MIN_UNIVERSE_SIZE) {
		return { pass: false, reason: `估算股票池仅 ${universeCount} 只，少于最小要求 ${MIN_UNIVERSE_SIZE}` };
	}

	// 3. Sample sufficiency: ensure klines exist for enough lookback days
	const klineCount = await estimateKlineCoverage(store, latest);
	if (klineCount < MIN_LOOKBACK_KLINES) {
		return { pass: false, reason: `K线覆盖天数 ${klineCount}，少于最小要求 ${MIN_LOOKBACK_KLINES}` };
	}

	// 4. Factor/signal consistency
	const consistency = checkFactorConsistency(idea);
	if (!consistency.pass) {
		return { pass: false, reason: consistency.reason };
	}

	idea.dataSnapshot.sampleSize = universeCount;
	return { pass: true, reason: `估算股票池 ${universeCount} 只，K线覆盖 ${klineCount} 天，数据日期 ${latest}` };
}

async function estimateUniverseSize(store: DataStore, idea: TradingIdea): Promise<number> {
	const { industryFilter, sizeFilter } = idea.suggestedStrategy;

	// Industry filter: stocks in top momentum industries on latest date
	if (industryFilter) {
		const rows = (await store.query<{ count: number }>(`
			SELECT COUNT(DISTINCT si.code) as count
			FROM stock_industries si
			JOIN industry_indicators ii ON si.industry_code = ii.code AND si.standard = ${s(industryFilter.standard)}
			WHERE ii.period_days = ${industryFilter.periodDays}
			  AND ii.date = ${s(idea.dataSnapshot.latestDate)}
			  AND ii.momentum_rank <= ${industryFilter.topIndustryCount}
		`)) as { count: number }[];
		return rows[0]?.count ?? 0;
	}

	// Size filter: stocks by market cap rank
	if (sizeFilter) {
		const order = sizeFilter.direction === "small" ? "ASC" : "DESC";
		const rows = (await store.query<{ count: number }>(`
			SELECT COUNT(*) as count FROM (
				SELECT code FROM quotes
				WHERE snapshot_date = ${s(idea.dataSnapshot.latestDate)}
				  AND total_cap IS NOT NULL
				ORDER BY total_cap ${order}
				LIMIT ${sizeFilter.topStockCount}
			)
		`)) as { count: number }[];
		return rows[0]?.count ?? 0;
	}

	// Fundamental: low PE/PB healthy companies
	if (idea.category === "fundamental") {
		const rows = (await store.query<{ count: number }>(`
			SELECT COUNT(DISTINCT q.code) as count
			FROM quotes q
			WHERE q.snapshot_date = ${s(idea.dataSnapshot.latestDate)}
			  AND q.pe > 0 AND q.pe < 30
			  AND q.pb > 0 AND q.pb < 2
		`)) as { count: number }[];
		return rows[0]?.count ?? 0;
	}

	// Technical / event / classic: all stocks with recent klines
	const rows = (await store.query<{ count: number }>(`
		SELECT COUNT(DISTINCT code) as count
		FROM klines
		WHERE date = ${s(idea.dataSnapshot.latestDate)} AND period = 'daily'
	`)) as { count: number }[];
	return rows[0]?.count ?? 0;
}

async function estimateKlineCoverage(store: DataStore, latestDate: string): Promise<number> {
	const rows = (await store.query<{ count: number }>(`
		SELECT COUNT(DISTINCT date) as count
		FROM klines
		WHERE period = 'daily' AND date <= ${s(latestDate)}
		ORDER BY date DESC
		LIMIT 60
	`)) as { count: number }[];
	return rows[0]?.count ?? 0;
}

function checkFactorConsistency(idea: TradingIdea): { pass: boolean; reason: string } {
	const { industryFilter, sizeFilter } = idea.suggestedStrategy;

	if (industryFilter) {
		const ic = idea.dataSnapshot.factorIcDirection.industry_momentum_20d_forward5d;
		if (ic == null || ic <= 0) {
			return { pass: false, reason: "行业动量因子IC非正，不支持行业动量过滤想法" };
		}
	}

	if (sizeFilter) {
		const ic = idea.dataSnapshot.factorIcDirection[`size_forward${sizeFilter.forwardDays}d`];
		if (ic == null) {
			return { pass: false, reason: `缺少 size_forward${sizeFilter.forwardDays}d 因子IC数据` };
		}
		if (sizeFilter.direction === "small" && ic > sizeFilter.icThreshold) {
			return { pass: false, reason: `小市值过滤要求IC <= ${sizeFilter.icThreshold}，当前 ${ic.toFixed(3)}` };
		}
		if (sizeFilter.direction === "large" && ic < sizeFilter.icThreshold) {
			return { pass: false, reason: `大市值过滤要求IC >= ${sizeFilter.icThreshold}，当前 ${ic.toFixed(3)}` };
		}
	}

	return { pass: true, reason: "因子方向与假设一致" };
}
