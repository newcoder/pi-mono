import type { DataStore } from "../data/index.js";
import type { MarketRegime } from "./types.js";

const FACTOR_NAMES = ["industry_momentum_20d_forward5d", "size_forward5d", "size_forward10d", "size_forward20d"];

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

export async function classifyMarketRegime(store: DataStore, lookbackDays: number): Promise<MarketRegime> {
	// ─── Determine latest available dates per table ───────────────────
	const dateRows = (await store.query<{ source: string; max_date: string }>(`
		SELECT 'factor_ic' as source, MAX(date) as max_date FROM factor_ic
		UNION ALL
		SELECT 'industry_indicators', MAX(date) FROM industry_indicators
		UNION ALL
		SELECT 'industry_quotes', MAX(snapshot_date) FROM industry_quotes
		UNION ALL
		SELECT 'quotes', MAX(snapshot_date) FROM quotes
	`)) as { source: string; max_date: string }[];

	const latestBySource = new Map<string, string>();
	for (const row of dateRows) {
		if (row.max_date) latestBySource.set(row.source, row.max_date);
	}

	const latestDate = latestBySource.get("quotes") ?? latestBySource.get("factor_ic") ?? formatDate(new Date());
	const latestIndustryDate = latestBySource.get("industry_indicators") ?? latestDate;
	const latestIndustryQuoteDate = latestBySource.get("industry_quotes") ?? latestDate;
	const startDate = tradingDaysAgo(latestDate, lookbackDays);

	// ─── Factor IC snapshot ───────────────────────────────────────────
	const factorIcSnapshot: MarketRegime["factorIcSnapshot"] = {};
	for (const factorName of FACTOR_NAMES) {
		const rows = await store.getFactorIc(factorName, startDate, latestDate);
		if (rows.length === 0) {
			factorIcSnapshot[factorName] = { latest: 0, avg20d: 0, direction: "neutral" };
			continue;
		}
		const values = rows.map((r) => r.ic_value ?? 0);
		const latest = values.at(-1) ?? 0;
		const avg20d = avg(values.slice(-Math.min(20, values.length)));
		let direction: "positive" | "negative" | "neutral" = "neutral";
		if (avg20d > 0.02) direction = "positive";
		else if (avg20d < -0.02) direction = "negative";
		factorIcSnapshot[factorName] = { latest, avg20d, direction };
	}

	// ─── Industry momentum ranks on latest date ───────────────────────
	const topIndustryRows = (await store.query<{
		code: string;
		name: string;
		momentum_return: number;
		momentum_rank: number;
	}>(
		`
		SELECT ii.code, i.name, ii.momentum_return, ii.momentum_rank
		FROM industry_indicators ii
		JOIN industries i ON ii.code = i.industry_code AND i.standard = 'sw_l1'
		WHERE ii.period_days = 20 AND ii.date = ?
		ORDER BY ii.momentum_rank ASC
		LIMIT 10
	`,
		[latestIndustryDate],
	)) as { code: string; name: string; momentum_return: number; momentum_rank: number }[];

	const topIndustries = topIndustryRows.slice(0, 5).map((r) => ({
		code: r.code,
		name: r.name ?? r.code,
		momentumReturn: r.momentum_return ?? 0,
		rank: r.momentum_rank ?? 0,
	}));

	const weakIndustryRows = (await store.query<{
		code: string;
		name: string;
		momentum_return: number;
		momentum_rank: number;
	}>(
		`
		SELECT ii.code, i.name, ii.momentum_return, ii.momentum_rank
		FROM industry_indicators ii
		JOIN industries i ON ii.code = i.industry_code AND i.standard = 'sw_l1'
		WHERE ii.period_days = 20 AND ii.date = ?
		ORDER BY ii.momentum_rank DESC
		LIMIT 5
	`,
		[latestIndustryDate],
	)) as { code: string; name: string; momentum_return: number; momentum_rank: number }[];

	const weakIndustries = weakIndustryRows.map((r) => ({
		code: r.code,
		name: r.name ?? r.code,
		momentumReturn: r.momentum_return ?? 0,
		rank: r.momentum_rank ?? 0,
	}));

	// ─── Volatility proxy from industry quotes ────────────────────────
	const volRows = (await store.query<{ avg_amplitude: number }>(
		`
		SELECT AVG(amplitude) as avg_amplitude
		FROM industry_quotes
		WHERE snapshot_date = ?
	`,
		[latestIndustryQuoteDate],
	)) as { avg_amplitude: number }[];
	const volatilityProxy = volRows[0]?.avg_amplitude ?? null;

	// ─── Hot sectors from sector table ────────────────────────────────
	const _hotSectorRows = (await store.query<{ name: string; change_pct: number }>(`
		SELECT name, change_pct FROM sectors
		ORDER BY change_pct DESC
		LIMIT 5
	`)) as { name: string; change_pct: number }[];

	// ─── Simple sentiment proxy from quotes ───────────────────────────
	const sentimentRows = (await store.query<{ up_ratio: number }>(
		`
		SELECT AVG(CASE WHEN change_pct > 0 THEN 1.0 ELSE 0.0 END) as up_ratio
		FROM quotes
		WHERE snapshot_date = ?
	`,
		[latestDate],
	)) as { up_ratio: number }[];
	const upRatio = sentimentRows[0]?.up_ratio ?? null;
	const sentimentIndex = upRatio == null ? null : Math.round(upRatio * 100);

	// ─── Classify sub-regimes ─────────────────────────────────────────
	const subRegimes: string[] = [];

	const industryMomentum = factorIcSnapshot.industry_momentum_20d_forward5d;
	if (industryMomentum) {
		if (industryMomentum.avg20d > 0.05) subRegimes.push("strong_momentum");
		else if (industryMomentum.avg20d < 0) subRegimes.push("weak_momentum");
	}

	const size5d = factorIcSnapshot.size_forward5d;
	const size10d = factorIcSnapshot.size_forward10d;
	const size20d = factorIcSnapshot.size_forward20d;
	const sizeNegative = [size5d, size10d, size20d].filter(Boolean).some((s) => s!.avg20d < -0.03);
	const sizePositive = [size5d, size10d, size20d].filter(Boolean).some((s) => s!.avg20d > 0.03);
	if (sizeNegative) subRegimes.push("small_cap_favored");
	if (sizePositive) subRegimes.push("large_cap_favored");

	if (volatilityProxy != null && volatilityProxy > 3) subRegimes.push("high_volatility");
	else if (volatilityProxy != null && volatilityProxy < 1.5) subRegimes.push("low_volatility");

	if (sentimentIndex != null && sentimentIndex > 60) subRegimes.push("bullish_sentiment");
	else if (sentimentIndex != null && sentimentIndex < 40) subRegimes.push("bearish_sentiment");

	const regime = subRegimes.length > 0 ? subRegimes.join("_") : "neutral";

	return {
		regime,
		subRegimes,
		latestDate,
		topIndustries,
		weakIndustries,
		factorIcSnapshot,
		sentimentIndex,
		volatilityProxy,
	};
}
