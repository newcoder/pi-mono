import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runAStockDataJsonScript, runJsonScript } from "../tools/_utils.js";
import type { DataStore } from "./data-store.js";
import type {
	ConceptStockRow,
	FundamentalsRow,
	IndustryIndexRow,
	IndustryKlineRow,
	IndustryQuoteRow,
	KlineRow,
	MacroRow,
	QuoteRow,
	SectorRow,
	StockRow,
} from "./types.js";

// TTL configurations (in minutes)
const TTL = {
	quote: 1, // 1 minute during market hours
	quoteAfterHours: 60, // 1 hour after hours
	klineRecent: 60, // 1 hour for last 5 days
	klineHistorical: Infinity, // never expires
	fundamentals: 10080, // 1 week
	sector: 15, // 15 minutes
	concept: 1440, // 1 day
	macro: 60, // 1 hour
	stockList: 1440, // 1 day
};

function isMarketHours(): boolean {
	const now = new Date();
	const h = now.getHours();
	const m = now.getMinutes();
	const day = now.getDay();
	// Monday-Friday, 9:30-11:30, 13:00-15:00 CST
	if (day === 0 || day === 6) return false;
	const time = h * 60 + m;
	return (time >= 570 && time <= 690) || (time >= 780 && time <= 900);
}

function isFresh(updatedAt: string | undefined, ttlMinutes: number): boolean {
	if (!updatedAt || ttlMinutes === Infinity) return true;
	const updated = new Date(updatedAt).getTime();
	const now = Date.now();
	return now - updated < ttlMinutes * 60 * 1000;
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

export class DataSyncService {
	private store: DataStore;

	constructor(store: DataStore) {
		this.store = store;
	}

	async initStorageDir(dbPath: string): Promise<void> {
		await mkdir(dirname(dbPath), { recursive: true });
	}

	// ─── K-line Sync ────────────────────────────────────────────────

	/**
	 * Sync kline data for a stock. Fetches missing data incrementally.
	 * @returns number of rows synced
	 */
	async syncKline(
		code: string,
		market: number,
		period: string,
		_adjust: string,
		start?: string,
		end?: string,
	): Promise<number> {
		const today = todayStr();
		const defaultEnd = end || today;

		// Always store bfq (unadjusted) klines for incremental efficiency.
		// Adjustment is applied dynamically on read via adjust_factors table.
		const adjust = "bfq";

		// Find the latest date we have in DB
		const latestDate = await this.store.getLatestKlineDate(code, market, period, adjust);

		let fetchStart: string;
		if (!latestDate) {
			fetchStart = start || "20200101";
		} else {
			// Start from day after latest date
			const d = new Date(latestDate);
			d.setDate(d.getDate() + 1);
			fetchStart = d.toISOString().slice(0, 10).replace(/-/g, "");
		}

		if (fetchStart > defaultEnd.replace(/-/g, "")) {
			return 0; // Already up to date
		}

		const args = [code, "--market", String(market), "--period", period, "--adjust", adjust];
		args.push("--start", fetchStart);
		args.push("--end", defaultEnd.replace(/-/g, ""));

		const data = await runJsonScript("get_kline.py", args);
		if (!data.klines || data.klines.length === 0) return 0;

		const rows: KlineRow[] = data.klines.map((k: any) => ({
			code,
			market,
			period,
			adjust,
			date: k.date,
			open: k.open ?? null,
			high: k.high ?? null,
			low: k.low ?? null,
			close: k.close ?? null,
			volume: k.volume ?? null,
			turnover: k.amount ?? k.turnover ?? null,
			change_pct: k.change_pct ?? null,
			change_amount: k.change_amount ?? null,
			amplitude: k.amplitude ?? null,
			pre_close: k.pre_close ?? null,
		}));

		await this.store.saveKlines(rows);

		// Save adjustment factors alongside bfq data
		if (data.factors && data.factors.length > 0) {
			const factorRows = data.factors.map((f: any) => ({
				code,
				market,
				date: f.date,
				qfq_factor: f.qfq_factor ?? null,
				hfq_factor: f.hfq_factor ?? null,
			}));
			await this.store.saveAdjustFactors(factorRows);
		}

		return rows.length;
	}

	/**
	 * Fetch all A-share stock list from akshare, fallback to local DB if unavailable.
	 */
	async fetchAllAshareList(): Promise<Array<{ code: string; market: number; name: string }>> {
		try {
			const data = await runJsonScript("get_all_stocks.py", []);
			return data as Array<{ code: string; market: number; name: string }>;
		} catch (e) {
			console.warn(
				"[fetchAllAshareList] akshare failed, falling back to local DB:",
				e instanceof Error ? e.message : String(e),
			);
			const stocks = await this.store.getAllStocks();
			return stocks.map((s) => ({ code: s.code, market: s.market, name: s.name }));
		}
	}

	/**
	 * Sync kline data for ALL A-share stocks in batches.
	 * Uses mootdx (TCP direct) for bfq, akshare for qfq/hfq.
	 *
	 * Incremental mode (default): only fetches data from the latest date
	 * already in the DB up to today. For initial sync, pass an explicit
	 * startDate (e.g. "20200101").
	 *
	 * @returns total number of rows synced
	 */
	async syncAllKlines(period = "daily", _adjust = "bfq", batchSize = 500, startDate?: string): Promise<number> {
		// Always store bfq klines; adjustment applied on read via adjust_factors table.
		const adjust = "bfq";

		// 1. Get all A-share stocks
		const stocks = await this.fetchAllAshareList();
		console.log(`[syncAllKlines] Total stocks: ${stocks.length}`);

		// 2. Compute date range
		const endDate = todayStr();
		let syncStart: string;

		if (startDate) {
			// Explicit start date for initial/backfill sync
			syncStart = startDate;
		} else {
			// Incremental: find the latest date across all stocks for this period (always bfq)
			const latestRows = await this.store.query<{ latest: string | null }>(
				`SELECT MAX(date) as latest FROM klines WHERE period = '${period}' AND adjust = '${adjust}'`,
			);
			const latestDate = latestRows[0]?.latest;
			if (latestDate) {
				// Start from 3 days before latest to handle gaps, then move forward
				const d = new Date(latestDate);
				d.setDate(d.getDate() - 3);
				syncStart = d.toISOString().slice(0, 10).replace(/-/g, "");
				console.log(`[syncAllKlines] Incremental mode: latest=${latestDate}, fetching from ${syncStart}`);
			} else {
				// No existing data — default to 3 years ago
				const d = new Date();
				d.setFullYear(d.getFullYear() - 3);
				syncStart = d.toISOString().slice(0, 10).replace(/-/g, "");
				console.log(`[syncAllKlines] No existing data, fetching from ${syncStart}`);
			}
		}

		if (syncStart > endDate.replace(/-/g, "")) {
			console.log("[syncAllKlines] Already up to date.");
			return 0;
		}

		// 3. Process in batches
		let totalSynced = 0;
		const totalBatches = Math.ceil(stocks.length / batchSize);
		const startTime = Date.now();

		for (let i = 0; i < stocks.length; i += batchSize) {
			const batchNum = Math.floor(i / batchSize) + 1;
			const batch = stocks.slice(i, i + batchSize);
			const codes = batch.map((s) => s.code).join(",");
			const markets = batch.map((s) => s.market).join(",");

			console.log(`[syncAllKlines] Batch ${batchNum}/${totalBatches} (${batch.length} stocks)...`);

			try {
				const data = await runJsonScript(
					"batch_get_kline.py",
					[
						"--codes",
						codes,
						"--markets",
						markets,
						"--start",
						syncStart,
						"--end",
						endDate.replace(/-/g, ""),
						"--period",
						period === "weekly" ? "week" : period === "monthly" ? "month" : period,
						"--adjust",
						adjust,
					],
					120_000,
				);

				if (data.klines && data.klines.length > 0) {
					const rows: KlineRow[] = data.klines.map((k: any) => ({
						code: k.code,
						market: k.market,
						period,
						adjust,
						date: k.date,
						open: k.open ?? null,
						high: k.high ?? null,
						low: k.low ?? null,
						close: k.close ?? null,
						volume: k.volume ?? null,
						turnover: k.amount ?? null,
						change_pct: k.change_pct ?? null,
						change_amount: k.change_amount ?? null,
						amplitude: k.amplitude ?? null,
						pre_close: k.pre_close ?? null,
					}));
					await this.store.saveKlines(rows);
					totalSynced += rows.length;
					console.log(`[syncAllKlines]   Saved ${rows.length} rows (total: ${totalSynced})`);
				} else {
					console.log(`[syncAllKlines]   No data for this batch`);
				}

				// Sync adjustment factors alongside bfq data
				try {
					const factorData = await runJsonScript(
						"batch_get_factors.py",
						["--codes", codes, "--markets", markets, "--start", syncStart, "--end", endDate.replace(/-/g, "")],
						300_000,
					);
					if (factorData.factors && factorData.factors.length > 0) {
						const factorRows = factorData.factors.map((f: any) => ({
							code: f.code,
							market: f.market,
							date: f.date,
							qfq_factor: f.qfq_factor ?? null,
							hfq_factor: f.hfq_factor ?? null,
						}));
						await this.store.saveAdjustFactors(factorRows);
						console.log(`[syncAllKlines]   Saved ${factorRows.length} factor rows`);
					}
				} catch (e) {
					console.warn(`[syncAllKlines]   Factor sync failed for batch ${batchNum}:`, e);
				}
			} catch (e) {
				console.warn(`[syncAllKlines] Batch ${batchNum} failed:`, e);
			}
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log(`[syncAllKlines] Done. Total ${totalSynced} rows synced in ${elapsed}s`);
		return totalSynced;
	}

	// ─── Quote Sync ─────────────────────────────────────────────────

	async syncQuote(code: string, market: number): Promise<QuoteRow> {
		const data = await runJsonScript("get_quote.py", [code, "--market", String(market)]);

		const quote: QuoteRow = {
			code,
			market,
			snapshot_date: todayStr(),
			name: data.name,
			latest: data.latest ?? null,
			open: data.open ?? null,
			high: data.high ?? null,
			low: data.low ?? null,
			prev_close: data.prev_close ?? null,
			volume: data.volume ?? null,
			turnover: data.turnover ?? null,
			change_pct: data.change_pct ?? null,
			pe: data.pe ?? null,
			pb: null,
			total_cap: data.total_cap ?? null,
			float_cap: data.float_cap ?? null,
			high_52w: data["52w_high"] ?? null,
			low_52w: data["52w_low"] ?? null,
			updated_at: new Date().toISOString(),
		};

		await this.store.saveQuote(quote);
		return quote;
	}

	async getQuoteWithCache(code: string, market: number): Promise<QuoteRow> {
		const today = todayStr();
		const cached = await this.store.getQuote(code, market, today);
		const ttl = isMarketHours() ? TTL.quote : TTL.quoteAfterHours;

		if (cached && isFresh(cached.updated_at, ttl)) {
			return cached;
		}

		return this.syncQuote(code, market);
	}

	// ─── Fundamentals Sync ──────────────────────────────────────────

	async syncFundamentals(code: string, market: number, historyLimit = 12): Promise<FundamentalsRow[]> {
		const args = [code, "--market", String(market), "--history"];
		if (historyLimit > 0) {
			args.push("--limit", String(historyLimit));
		}
		const data = await runJsonScript("get_fundamentals.py", args, 120_000);

		// Skip stocks with no F10 data (delisted, indices, invalid codes)
		if (data._no_f10_data) {
			return [];
		}

		const rows: FundamentalsRow[] = [];
		const now = new Date().toISOString();

		function parseNum(v: any): number | null {
			if (v == null || v === "-" || v === "") return null;
			const n = parseFloat(String(v).replace(/,/g, ""));
			return Number.isNaN(n) ? null : n;
		}

		function extractReports(stmt: any): Array<{ report_date: string; data: any }> {
			if (!stmt) return [];
			if (stmt.reports) return stmt.reports;
			if (stmt.report_date) return [{ report_date: stmt.report_date, data: stmt.data || {} }];
			return [];
		}

		function inferReportType(dateStr: string): string | undefined {
			const month = dateStr.slice(5, 7);
			switch (month) {
				case "03":
					return "一季报";
				case "06":
					return "中报";
				case "09":
					return "三季报";
				case "12":
					return "年报";
				default:
					return undefined;
			}
		}

		const incomeReports = extractReports(data.利润表);
		const balanceReports = extractReports(data.资产负债表);
		const cashflowReports = extractReports(data.现金流量表);

		const reportMap = new Map<string, FundamentalsRow>();

		for (const r of incomeReports) {
			const d = r.report_date;
			if (!reportMap.has(d)) {
				reportMap.set(d, {
					code,
					market,
					report_date: d,
					report_type: inferReportType(d),
					updated_at: now,
				} as FundamentalsRow);
			}
			const row = reportMap.get(d)!;
			row.total_revenue = parseNum(r.data.营业总收入);
			row.operate_revenue = parseNum(r.data.营业收入);
			row.operate_cost = parseNum(r.data.营业成本);
			row.total_operate_cost = parseNum(r.data.营业总成本);
			row.operate_profit = parseNum(r.data.营业利润);
			row.total_profit = parseNum(r.data.利润总额);
			row.net_profit = parseNum(r.data.净利润);
			row.parent_net_profit = parseNum(r.data.归母净利润);
			row.eps = parseNum(r.data.基本每股收益);
			row.diluted_eps = parseNum(r.data.稀释每股收益);
			row.research_expense = parseNum(r.data.研发费用);
			row.sale_expense = parseNum(r.data.销售费用);
			row.manage_expense = parseNum(r.data.管理费用);
			row.finance_expense = parseNum(r.data.财务费用);
			row.interest_expense = parseNum(r.data.利息费用);
			row.income_tax = parseNum(r.data.所得税费用);
			row.credit_impairment = parseNum(r.data.信用减值损失);
			row.asset_impairment = parseNum(r.data.资产减值损失);
			row.non_operate_income = parseNum(r.data.营业外收入);
			row.non_operate_expense = parseNum(r.data.营业外支出);
			row.operate_tax_add = parseNum(r.data.营业税金及附加);
		}

		for (const r of balanceReports) {
			const d = r.report_date;
			if (!reportMap.has(d)) {
				reportMap.set(d, {
					code,
					market,
					report_date: d,
					report_type: inferReportType(d),
					updated_at: now,
				} as FundamentalsRow);
			}
			const row = reportMap.get(d)!;
			row.total_assets = parseNum(r.data.资产总计);
			row.total_liabilities = parseNum(r.data.负债合计);
			row.total_equity = parseNum(r.data.所有者权益合计);
			row.parent_equity = parseNum(r.data.归母所有者权益);
			row.total_current_assets = parseNum(r.data.流动资产合计);
			row.total_current_liab = parseNum(r.data.流动负债合计);
			row.inventory = parseNum(r.data.存货);
			row.accounts_rece = parseNum(r.data.应收账款);
			row.fixed_asset = parseNum(r.data.固定资产);
			row.short_loan = parseNum(r.data.短期借款);
			row.long_loan = parseNum(r.data.长期借款);
			row.total_noncurrent_liab = parseNum(r.data.非流动负债合计);
			row.monetary_funds = parseNum(r.data.货币资金);
			row.total_shares = parseNum(r.data.总股本);
		}

		for (const r of cashflowReports) {
			const d = r.report_date;
			if (!reportMap.has(d)) {
				reportMap.set(d, {
					code,
					market,
					report_date: d,
					report_type: inferReportType(d),
					updated_at: now,
				} as FundamentalsRow);
			}
			const row = reportMap.get(d)!;
			row.operate_cash_flow = parseNum(r.data.经营活动产生的现金流量净额);
			row.invest_cash_flow = parseNum(r.data.投资活动产生的现金流量净额);
			row.finance_cash_flow = parseNum(r.data.筹资活动产生的现金流量净额);
			row.net_cash_increase = parseNum(r.data.现金及现金等价物净增加额);
			row.construct_long_asset = parseNum(
				(r.data as Record<string, unknown>)["购建固定资产、无形资产和其他长期资产支付的现金"],
			);
		}

		for (const row of reportMap.values()) {
			await this.store.saveFundamentals(row);
			rows.push(row);
		}

		rows.sort((a, b) => b.report_date.localeCompare(a.report_date));

		// Recalculate fundamental indicators for this stock
		try {
			await runJsonScript("calc_fundamental_indicators.py", ["--code", code], 60_000);
		} catch (e) {
			console.warn(`[syncFundamentals] Indicator recalculation failed for ${code}:`, e);
		}

		return rows;
	}

	async getFundamentalsWithCache(code: string, market: number): Promise<FundamentalsRow[]> {
		const cached = await this.store.getLatestFundamentals(code, market);
		if (cached && isFresh(cached.updated_at, TTL.fundamentals)) {
			return this.store.getFundamentals(code, market);
		}
		// If cache exists but stale, return it immediately and trigger background sync
		if (cached) {
			this.syncFundamentals(code, market).catch((e) =>
				console.warn(`[Fundamentals] Background sync failed for ${code}:`, e),
			);
			return this.store.getFundamentals(code, market);
		}
		return this.syncFundamentals(code, market);
	}

	/**
	 * Sync fundamentals for ALL A-share stocks in batches.
	 * Uses batched API for efficient fetching.
	 *
	 * @returns total number of report rows synced
	 */
	async syncAllFundamentals(batchSize = 100, historyLimit = 12, force = false): Promise<number> {
		const stocks = await this.fetchAllAshareList();
		console.log(`[syncAllFundamentals] Total stocks: ${stocks.length}, historyLimit=${historyLimit}, force=${force}`);

		let totalSynced = 0;
		const startTime = Date.now();

		for (let i = 0; i < stocks.length; i += batchSize) {
			const batchNum = Math.floor(i / batchSize) + 1;
			const totalBatches = Math.ceil(stocks.length / batchSize);
			const batch = stocks.slice(i, i + batchSize);

			console.log(`[syncAllFundamentals] Batch ${batchNum}/${totalBatches} (${batch.length} stocks)...`);

			for (let j = 0; j < batch.length; j++) {
				const stock = batch[j];
				try {
					// Incremental: skip if recently synced (unless force=true)
					if (!force) {
						const latest = await this.store.getLatestFundamentals(stock.code, stock.market);
						if (latest && isFresh(latest.updated_at, TTL.fundamentals)) {
							continue;
						}
					}
					const rows = await this.syncFundamentals(stock.code, stock.market, historyLimit);
					totalSynced += rows.length;
				} catch (e) {
					console.warn(`[syncAllFundamentals] Failed to sync ${stock.code}:`, e);
				}
				// Small delay between stocks to avoid rate limiting Eastmoney F10 page
				if (j < batch.length - 1) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}

			// Small delay between batches to avoid rate limiting
			if (i + batchSize < stocks.length) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log(`[syncAllFundamentals] Done. Total ${totalSynced} rows synced in ${elapsed}s`);

		// Recalculate fundamental indicators for all stocks
		if (totalSynced > 0) {
			console.log("[syncAllFundamentals] Recalculating fundamental indicators...");
			try {
				const result = await runJsonScript("calc_fundamental_indicators.py", ["--all"], 600_000);
				console.log(`[syncAllFundamentals] Indicators recalculated: ${result.rows_inserted ?? "?"} rows`);
			} catch (e) {
				console.warn("[syncAllFundamentals] Indicator recalculation failed:", e);
			}
		}

		return totalSynced;
	}

	/**
	 * Backfill fundamentals history for stocks missing data before sinceYear.
	 * Only re-syncs stocks whose earliest report_date is later than the target.
	 */
	async backfillFundamentals(sinceYear = 2019, batchSize = 100): Promise<number> {
		const stocks = await this.fetchAllAshareList();
		const currentYear = new Date().getFullYear();
		const yearsNeeded = currentYear - sinceYear + 1;
		const historyLimit = Math.min(yearsNeeded * 4 + 4, 60); // ~4 reports/year + buffer, cap at 60

		console.log(`[backfillFundamentals] Target: since ${sinceYear}, limit=${historyLimit}, stocks=${stocks.length}`);

		let totalSynced = 0;
		let skipped = 0;
		let processed = 0;
		const startTime = Date.now();

		for (let i = 0; i < stocks.length; i += batchSize) {
			const batchNum = Math.floor(i / batchSize) + 1;
			const totalBatches = Math.ceil(stocks.length / batchSize);
			const batch = stocks.slice(i, i + batchSize);

			console.log(`[backfillFundamentals] Batch ${batchNum}/${totalBatches} (${batch.length} stocks)...`);

			for (const stock of batch) {
				try {
					const rows = await this.store.query<{ earliest: string | null }>(
						"SELECT MIN(report_date) as earliest FROM fundamentals WHERE code = ? AND market = ?",
						[stock.code, stock.market],
					);
					const earliest = rows[0]?.earliest;
					const targetDate = `${sinceYear}-01-01`;

					if (earliest && earliest <= targetDate) {
						skipped++;
						continue;
					}

					const synced = await this.syncFundamentals(stock.code, stock.market, historyLimit);
					totalSynced += synced.length;
					processed++;
				} catch (e) {
					console.warn(`[backfillFundamentals] Failed for ${stock.code}:`, e);
				}
			}

			if (i + batchSize < stocks.length) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log(
			`[backfillFundamentals] Done. Processed ${processed}, skipped ${skipped}, total ${totalSynced} rows in ${elapsed}s`,
		);

		if (totalSynced > 0) {
			console.log("[backfillFundamentals] Recalculating fundamental indicators...");
			try {
				const result = await runJsonScript("calc_fundamental_indicators.py", ["--all"], 600_000);
				console.log(`[backfillFundamentals] Indicators recalculated: ${result.rows_inserted ?? "?"} rows`);
			} catch (e) {
				console.warn("[backfillFundamentals] Indicator recalculation failed:", e);
			}
		}

		return totalSynced;
	}

	// ─── Sector Sync ────────────────────────────────────────────────

	async syncSectors(): Promise<SectorRow[]> {
		const resp = await fetch(
			"https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f13,f14,f3,f128,f136,f140,f141",
		);
		if (!resp.ok) throw new Error(`Sector API error: ${resp.status}`);
		const json = (await resp.json()) as any;
		const list = json?.data?.diff || [];

		const rows: SectorRow[] = list.map((item: any) => ({
			name: item.f14 || "",
			change_pct: item.f3 ?? null,
			leading_stock: item.f128 || null,
			leading_stock_code: item.f140 || null,
			leading_change_pct: item.f136 ?? null,
			volume_ratio: null,
			snapshot_date: todayStr(),
			updated_at: new Date().toISOString(),
		}));

		await this.store.saveSectors(rows);
		return rows;
	}

	async getSectorsWithCache(): Promise<SectorRow[]> {
		const sectors = await this.store.getSectors();
		if (sectors.length > 0 && sectors[0]?.updated_at && isFresh(sectors[0].updated_at, TTL.sector)) {
			return sectors;
		}
		return this.syncSectors();
	}

	// ─── Industry Index Sync ────────────────────────────────────────

	async syncIndustryList(): Promise<number> {
		console.log("[syncIndustryList] Fetching industry index list from Eastmoney...");
		const data = await runAStockDataJsonScript("get_industry_index_em.py", ["list"], 60_000);
		const industries: IndustryIndexRow[] = (data.data || []).map((item: any) => ({
			code: item.板块代码,
			name: item.板块名称,
			updated_at: new Date().toISOString(),
		}));
		await this.store.saveIndustryList(industries);
		console.log(`[syncIndustryList] Saved ${industries.length} industry indices`);
		return industries.length;
	}

	async syncIndustryQuote(code: string): Promise<IndustryQuoteRow> {
		const data = await runAStockDataJsonScript("get_industry_index_em.py", ["spot", "--symbol", code], 30_000);
		const raw = data;
		const now = new Date().toISOString();
		const quote: IndustryQuoteRow = {
			code: raw.板块代码 || code,
			snapshot_date: todayStr(),
			name: null,
			latest: raw.最新 ?? null,
			open: raw.开盘 ?? null,
			high: raw.最高 ?? null,
			low: raw.最低 ?? null,
			prev_close: raw.昨收 ?? null,
			volume: raw.成交量 ?? null,
			turnover: raw.成交额 ?? null,
			change_pct: raw.涨跌幅 ?? null,
			change_amount: raw.涨跌额 ?? null,
			amplitude: raw.振幅 ?? null,
			turnover_rate: raw.换手率 ?? null,
			up_count: null,
			down_count: null,
			flat_count: null,
			leading_stock: null,
			leading_stock_code: null,
			leading_change_pct: null,
			lagging_stock: null,
			lagging_stock_code: null,
			lagging_change_pct: null,
			updated_at: now,
		};
		await this.store.saveIndustryQuote(quote);
		return quote;
	}

	async syncAllIndustryQuotes(): Promise<number> {
		console.log("[syncAllIndustryQuotes] Fetching all industry index quotes from Eastmoney...");
		const data = await runAStockDataJsonScript("get_industry_index_em.py", ["list"], 60_000);
		const items = data.data || [];
		const now = new Date().toISOString();
		for (const item of items) {
			const quote: IndustryQuoteRow = {
				code: item.板块代码,
				snapshot_date: todayStr(),
				name: item.板块名称 ?? null,
				latest: item.最新价 ?? null,
				open: item.今开 ?? null,
				high: item.最高 ?? null,
				low: item.最低 ?? null,
				prev_close: item.昨收 ?? null,
				volume: item.成交量 ?? null,
				turnover: item.成交额 ?? null,
				change_pct: item.涨跌幅 ?? null,
				change_amount: item.涨跌额 ?? null,
				amplitude: item.振幅 ?? null,
				turnover_rate: item.换手率 ?? null,
				up_count: item.上涨家数 ?? null,
				down_count: item.下跌家数 ?? null,
				flat_count: item.平盘家数 ?? null,
				leading_stock: item.领涨股票 ?? null,
				leading_stock_code: item.领涨股票代码 ?? null,
				leading_change_pct: item["领涨股票-涨跌幅"] ?? null,
				lagging_stock: item.领跌股票 ?? null,
				lagging_stock_code: item.领跌股票代码 ?? null,
				lagging_change_pct: item["领跌股票-涨跌幅"] ?? null,
				updated_at: now,
			};
			await this.store.saveIndustryQuote(quote);
		}
		await this.store.saveIndustryList(
			items.map((item: any) => ({
				code: item.板块代码,
				name: item.板块名称,
				updated_at: now,
			})),
		);
		console.log(`[syncAllIndustryQuotes] Saved ${items.length} industry quotes`);
		return items.length;
	}

	async syncIndustryKlines(code: string, period = "daily"): Promise<number> {
		const today = todayStr();
		const latestDate = await this.store.getLatestIndustryKlineDate(code, period);
		let fetchStart: string;
		if (!latestDate) {
			fetchStart = "20200101";
		} else {
			const d = new Date(latestDate);
			d.setDate(d.getDate() + 1);
			fetchStart = d.toISOString().slice(0, 10).replace(/-/g, "");
		}
		if (fetchStart > today.replace(/-/g, "")) {
			return 0;
		}

		const periodArg = period === "weekly" ? "week" : period === "monthly" ? "month" : "daily";
		const data = await runAStockDataJsonScript(
			"get_industry_index_em.py",
			["klines", "--symbol", code, "--start", fetchStart, "--end", today.replace(/-/g, ""), "--period", periodArg],
			60_000,
		);
		const rows: IndustryKlineRow[] = (data.data || []).map((k: any) => ({
			code: k.板块代码 || code,
			period,
			date: k.日期,
			open: k.开盘 ?? null,
			high: k.最高 ?? null,
			low: k.最低 ?? null,
			close: k.收盘 ?? null,
			volume: k.成交量 ?? null,
			turnover: k.成交额 ?? null,
			change_pct: k.涨跌幅 ?? null,
			change_amount: k.涨跌额 ?? null,
			amplitude: k.振幅 ?? null,
			turnover_rate: k.换手率 ?? null,
		}));
		await this.store.saveIndustryKlines(rows);
		return rows.length;
	}

	async syncAllIndustryKlines(period = "daily"): Promise<number> {
		let industries = await this.store.getIndustryList();
		if (industries.length === 0) {
			await this.syncIndustryList();
			industries = await this.store.getIndustryList();
		}
		let total = 0;
		console.log(`[syncAllIndustryKlines] Syncing klines for ${industries.length} industries...`);
		for (const ind of industries) {
			try {
				const n = await this.syncIndustryKlines(ind.code, period);
				total += n;
			} catch (e) {
				console.warn(`[syncAllIndustryKlines] Failed for ${ind.code}:`, e);
			}
		}
		console.log(`[syncAllIndustryKlines] Done. Total ${total} rows synced`);
		return total;
	}

	// ─── Concept Stocks Sync ────────────────────────────────────────

	async syncConceptStocks(concept: string): Promise<ConceptStockRow[]> {
		// Use Eastmoney/akshare (no JoinQuant dependency)
		try {
			const result = await runJsonScript("sync_concepts_jq.py", ["--concept", concept], 120_000);
			const actualConcept = result.concept || concept;
			return this.store.getConceptStocks(actualConcept);
		} catch (e) {
			console.warn("[syncConceptStocks] Concept sync failed:", e);
		}

		// Fallback to Eastmoney API via Python script
		const data = await runJsonScript("get_concept_stocks.py", [concept], 60_000);
		const stocks: ConceptStockRow[] = (data.stocks || []).map((s: any) => ({
			concept: data.concept || concept,
			code: s.code,
			name: s.name,
			updated_at: new Date().toISOString(),
		}));
		await this.store.saveConceptStocks(stocks);
		return stocks;
	}

	async syncAllConcepts(): Promise<number> {
		console.log("[syncAllConcepts] Starting full concept sync via Eastmoney/akshare...");
		await runJsonScript("sync_concepts_jq.py", ["--all"], 600_000);
		const concepts = await this.store.getAllConcepts();
		console.log(`[syncAllConcepts] Done. ${concepts.length} concepts in local DB.`);
		return concepts.length;
	}

	async syncIndustries(): Promise<{ standards: number; industries: number; mappings: number; errors: string[] }> {
		console.log("[syncIndustries] Syncing all industry classifications via Eastmoney/akshare...");
		const result = await runJsonScript("sync_industries_jq.py", ["--all"], 600_000);

		const results = result.results || [];
		let totalIndustries = 0;
		let totalMappings = 0;
		const errors: string[] = [];

		for (const r of results) {
			if (r.error) {
				errors.push(`${r.standard}: ${r.error}`);
			} else {
				totalIndustries += r.industries || 0;
				totalMappings += r.mappings || 0;
				console.log(`[syncIndustries] ${r.standard}: ${r.industries} industries, ${r.mappings} mappings`);
			}
		}

		console.log(
			`[syncIndustries] Done. ${results.length} standards, ${totalIndustries} industries, ${totalMappings} mappings`,
		);
		if (errors.length > 0) {
			console.warn(`[syncIndustries] ${errors.length} standard(s) failed:`, errors);
		}

		return {
			standards: results.length,
			industries: totalIndustries,
			mappings: totalMappings,
			errors,
		};
	}

	async getConceptStocksWithCache(concept: string): Promise<ConceptStockRow[]> {
		const cached = await this.store.getConceptStocks(concept);
		// Check freshness using the most recent updated_at
		if (cached.length > 0) {
			const newest = cached.reduce((a, b) => (a.updated_at && b.updated_at && a.updated_at > b.updated_at ? a : b));
			if (newest.updated_at && isFresh(newest.updated_at, TTL.concept)) {
				return cached;
			}
		}
		return this.syncConceptStocks(concept);
	}

	// ─── Macro Sync ─────────────────────────────────────────────────

	async syncMacro(): Promise<MacroRow> {
		const { fetchMacroData } = await import("../tools/macro-data.js");
		const data = await fetchMacroData();

		const row: MacroRow = {
			snapshot_date: todayStr(),
			ndx_latest: data.usMarkets.NDX.latest,
			ndx_change_pct: data.usMarkets.NDX.changePct,
			spx_latest: data.usMarkets.SPX.latest,
			spx_change_pct: data.usMarkets.SPX.changePct,
			dji_latest: data.usMarkets.DJI.latest,
			dji_change_pct: data.usMarkets.DJI.changePct,
			a50_latest: data.a50?.latest ?? null,
			a50_change_pct: data.a50?.changePct ?? null,
			usdcnh_latest: data.fx?.latest ?? null,
			usdcnh_change_pct: data.fx?.changePct ?? null,
			updated_at: new Date().toISOString(),
		};

		await this.store.saveMacro(row);
		return row;
	}

	async getMacroWithCache(): Promise<MacroRow> {
		const cached = await this.store.getLatestMacro();
		if (cached && isFresh(cached.updated_at, TTL.macro)) {
			return cached;
		}
		return this.syncMacro();
	}

	// ─── Stock List Sync ────────────────────────────────────────────

	async syncStockList(scope = "all"): Promise<number> {
		const data = await runJsonScript("stock_screener.py", ["--scope", scope, "--top", "5000"]);
		const results = data.results || [];

		const rows: StockRow[] = results.map((r: any) => ({
			code: r.代码,
			name: r.名称,
			market: r.代码?.startsWith("6") ? 1 : 0,
			updated_at: new Date().toISOString(),
		}));

		await this.store.saveStocks(rows);
		return rows.length;
	}

	// ─── Watchlist Sync ─────────────────────────────────────────────

	async syncWatchlist(watchlist: Array<{ code: string; market: number }>): Promise<void> {
		for (const item of watchlist) {
			try {
				await this.getQuoteWithCache(item.code, item.market);
				// Also sync kline data
				await this.syncKline(item.code, item.market, "daily", "bfq");
			} catch (e) {
				console.warn(`[DataSync] Failed to sync ${item.code}:`, e);
			}
		}
	}
}
