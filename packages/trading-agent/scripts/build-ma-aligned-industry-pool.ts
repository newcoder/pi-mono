#!/usr/bin/env node
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";
import { computeMA } from "../src/indicators/engine.js";

const DEFAULT_TARGET = 500;
const DEFAULT_MAX = 1000;

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

function isoWeekKey(dateStr: string): string {
	const d = new Date(dateStr);
	d.setHours(0, 0, 0, 0);
	const day = d.getDay() || 7; // 1=Mon ... 7=Sun
	const thu = new Date(d.getTime());
	thu.setDate(d.getDate() + 4 - day);
	const yearStart = new Date(thu.getFullYear(), 0, 1);
	const week = Math.ceil(((thu.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${thu.getFullYear()}-W${week.toString().padStart(2, "0")}`;
}

function buildWeekToDateClose(closes: number[], dates: string[]): number[] {
	const weeklyClose: number[] = [];
	let currentWeek = "";
	let weekClose = closes[0] ?? 0;
	for (let i = 0; i < dates.length; i++) {
		const wk = isoWeekKey(dates[i]);
		if (wk !== currentWeek) {
			currentWeek = wk;
			weekClose = closes[i];
		} else {
			weekClose = closes[i];
		}
		weeklyClose.push(weekClose);
	}
	return weeklyClose;
}

interface IndustrySignals {
	score: number;
}

interface IndustryData {
	code: string;
	name: string;
	stocks: Array<{ code: string; market: number; name?: string }>;
	byDate: Map<string, IndustrySignals>;
}

function calcScore(params: {
	c: number;
	m5?: number | null;
	m10?: number | null;
	m20?: number | null;
	m60?: number | null;
	m120?: number | null;
	wc?: number | null;
	wm5?: number | null;
	wm10?: number | null;
	ret5: number | null;
	ret10: number | null;
	ret20: number | null;
}): number {
	const { c, m5, m10, m20, m60, m120, wc, wm5, wm10, ret5, ret10, ret20 } = params;
	let score = 0;

	// 日线均线排列 (max 40)
	if (m5 != null && c > m5) score += 10;
	if (m5 != null && m10 != null && m5 > m10) score += 10;
	if (m10 != null && m20 != null && m10 > m20) score += 10;
	if (m20 != null && c > m20) score += 10;

	// 中长期均线排列 (max 20)
	if (m20 != null && m60 != null && m20 > m60) score += 10;
	if (m60 != null && m120 != null && m60 > m120) score += 10;

	// 动量分 (max 30): 每周期 10% 收益率封顶 10 分
	if (ret5 != null) score += Math.min(10, Math.max(0, ret5 * 100));
	if (ret10 != null) score += Math.min(10, Math.max(0, ret10 * 100));
	if (ret20 != null) score += Math.min(10, Math.max(0, ret20 * 100));

	// 偏离中期均线 (max 10): 价格高于 MA20 越多分越高
	if (m20 != null && m20 > 0) score += Math.min(10, Math.max(0, (c / m20 - 1) * 100));

	// 周线均线排列 (max 15)
	if (wc != null && wm5 != null && wc > wm5) score += 5;
	if (wm5 != null && wm10 != null && wm5 > wm10) score += 5;
	if (wc != null && wm10 != null && wc > wm10) score += 5;

	return score;
}

async function main() {
	const dataDir = getDataDir();
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataStore(store);

	const poolName = process.argv[2] || "MA多头排列行业成分股";
	const standard = process.argv[3] || "sw_l1";
	const level = Number(process.argv[4] || 1);
	const TARGET_STOCKS = Number(process.argv[5] || DEFAULT_TARGET);
	const MAX_STOCKS = Number(process.argv[6] || DEFAULT_MAX);

	const existing = await store.getStockPoolByName(poolName);
	if (existing) {
		console.log(`Deleting existing dynamic pool "${poolName}" (ID: ${existing.id})...`);
		await store.deleteStockPool(existing.id);
	}
	const poolId = await store.createStockPool(
		poolName,
		`按${standard}行业趋势强度打分，从最强行业取成分股，目标${TARGET_STOCKS}~${MAX_STOCKS}只`,
		true,
	);
	console.log(`Created dynamic pool "${poolName}" (ID: ${poolId})`);

	const industries = await store.getIndustries(standard, level);
	console.log(`Found ${industries.length} ${standard} level-${level} industries. Loading membership...`);

	const industriesWithStocks: IndustryData[] = [];
	for (const ind of industries) {
		const stocks = await store.getIndustryStocks(ind.industry_code, standard);
		if (stocks.length > 0) {
			industriesWithStocks.push({ code: ind.industry_code, name: ind.name, stocks, byDate: new Map() });
		}
	}
	console.log(`${industriesWithStocks.length} industries have ${standard} membership.`);

	const allDates = new Set<string>();
	let globalMinDate = "";
	let globalMaxDate = "";

	for (const ind of industriesWithStocks) {
		const klines = await store.getIndustrySyntheticKlines(ind.code, standard);
		if (klines.length < 20) continue;

		const dates = klines.map((k) => k.date);
		const closes = klines.map((k) => k.close);

		const m5 = computeMA(closes, 5).values;
		const m10 = computeMA(closes, 10).values;
		const m20 = computeMA(closes, 20).values;
		const m60 = computeMA(closes, 60).values;
		const m120 = computeMA(closes, 120).values;

		const weeklyClose = buildWeekToDateClose(closes, dates);
		const wm5 = computeMA(weeklyClose, 5).values;
		const wm10 = computeMA(weeklyClose, 10).values;

		for (let i = 0; i < klines.length; i++) {
			const c = closes[i];
			if (c == null) continue;

			const ret5 = i >= 5 ? c / closes[i - 5] - 1 : null;
			const ret10 = i >= 10 ? c / closes[i - 10] - 1 : null;
			const ret20 = i >= 20 ? c / closes[i - 20] - 1 : null;

			const score = calcScore({
				c,
				m5: m5[i],
				m10: m10[i],
				m20: m20[i],
				m60: m60[i],
				m120: m120[i],
				wc: weeklyClose[i],
				wm5: wm5[i],
				wm10: wm10[i],
				ret5,
				ret10,
				ret20,
			});

			const date = dates[i];
			ind.byDate.set(date, { score });
			allDates.add(date);
		}

		if (ind.byDate.size > 0) {
			const sorted = [...ind.byDate.keys()].sort();
			if (!globalMinDate || sorted[0] < globalMinDate) globalMinDate = sorted[0];
			if (!globalMaxDate || sorted[sorted.length - 1] > globalMaxDate) globalMaxDate = sorted[sorted.length - 1];
		}
	}

	console.log(`Loaded signals for ${industriesWithStocks.filter((i) => i.byDate.size > 0).length} industries.`);
	console.log(`Date range: ${globalMinDate} ~ ${globalMaxDate}`);

	const sortedDates = [...allDates].sort();
	console.log(`Total trading days: ${sortedDates.length}`);

	console.log("Writing dynamic pool items...");
	let totalItems = 0;
	let daysInRange = 0;
	let daysTooFew = 0;
	const t0 = Date.now();

	for (let i = 0; i < sortedDates.length; i++) {
		const date = sortedDates[i];
		const selected: Array<{ code: string; market: number; name?: string }> = [];
		const seen = new Set<string>();

		const candidates = industriesWithStocks
			.map((ind) => {
				const sig = ind.byDate.get(date);
				if (!sig) return null;
				return { ind, score: sig.score };
			})
			.filter((x): x is { ind: IndustryData; score: number } => x != null)
			.sort((a, b) => b.score - a.score);

		let total = 0;
		for (const { ind } of candidates) {
			const remaining = MAX_STOCKS - total;
			if (remaining <= 0) break;

			if (total >= TARGET_STOCKS && ind.stocks.length > remaining) {
				// 已达标，用当前行业补足到上限
				let taken = 0;
				for (const s of ind.stocks) {
					if (taken >= remaining) break;
					const key = `${s.code}:${s.market}`;
					if (!seen.has(key)) {
						seen.add(key);
						selected.push(s);
						taken++;
						total++;
					}
				}
				break;
			}

			for (const s of ind.stocks) {
				const key = `${s.code}:${s.market}`;
				if (!seen.has(key)) {
					seen.add(key);
					selected.push(s);
					total++;
				}
			}
		}

		if (selected.length > MAX_STOCKS) {
			selected.length = MAX_STOCKS;
		}
		if (selected.length === 0) continue;

		await store.setDynamicPoolItems(
			poolId,
			date,
			selected.map((s) => ({ code: s.code, market: s.market, name: s.name?.replace(/\0/g, "") })),
		);
		totalItems += selected.length;

		if (selected.length >= TARGET_STOCKS && selected.length <= MAX_STOCKS) daysInRange++;
		if (selected.length < TARGET_STOCKS) daysTooFew++;

		if ((i + 1) % 100 === 0 || i === sortedDates.length - 1) {
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			console.log(`  ${i + 1}/${sortedDates.length} days written, ${totalItems} total items (${elapsed}s)`);
		}
	}

	console.log(`\nDone. Dynamic pool ${poolId} has ${daysInRange + daysTooFew} days and ${totalItems} total (code,date) items.`);
	console.log(`Days in [${TARGET_STOCKS},${MAX_STOCKS}]: ${daysInRange}, days below ${TARGET_STOCKS}: ${daysTooFew}`);
	const sample = await store.getDynamicPoolItems(poolId, globalMaxDate);
	console.log(`Sample (${globalMaxDate}): ${sample.length} stocks`);

	await store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
