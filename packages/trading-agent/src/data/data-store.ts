import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import sqlite3 from "sqlite3";
import type {
	AdjustFactorRow,
	BusinessCompositionRow,
	CalendarEventRow,
	ConceptStockRow,
	DynamicPoolItemRow,
	FactorIcRow,
	FundamentalIndicatorsRow,
	FundamentalsRow,
	HotStockRow,
	IndustryIndexRow,
	IndustryIndicatorRow,
	IndustryKlineRow,
	IndustryQuoteRow,
	IndustryRow,
	IndustrySyntheticKlineRow,
	KlineFilter,
	KlineRow,
	MacroRow,
	PortfolioRow,
	PortfolioTradeRow,
	QuoteRow,
	SectorRow,
	StockIndicatorRow,
	StockIndustryRow,
	StockRow,
} from "./types.js";

function promisifyQuery(db: sqlite3.Database, sql: string, params?: unknown[]): Promise<any[]> {
	return new Promise((resolve, reject) => {
		if (params) {
			db.all(sql, params, (err: Error | null, res: any[]) => {
				if (err) reject(err);
				else resolve(res);
			});
		} else {
			db.all(sql, (err: Error | null, res: any[]) => {
				if (err) reject(err);
				else resolve(res);
			});
		}
	});
}

function promisifyExec(db: sqlite3.Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => {
		db.exec(sql, (err: Error | null) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function s(v: string | null | undefined): string {
	if (v == null) return "NULL";
	return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Aggregate daily klines into weekly or monthly OHLC bars.
 * - Weekly: groups by Monday of each ISO week
 * - Monthly: groups by YYYY-MM
 * Returns bars sorted by date, limited to `maxBars` if specified.
 */
function aggregateDailyKlines(daily: KlineRow[], period: "week" | "month", maxBars?: number): KlineRow[] {
	if (daily.length === 0) return [];

	const groups = new Map<string, KlineRow[]>();

	for (const k of daily) {
		const d = new Date(`${k.date}T00:00:00`);
		let key: string;
		if (period === "week") {
			// Monday of the ISO week
			const dayOfWeek = d.getDay() || 7; // Sun=0→7, Mon=1
			const monday = new Date(d);
			monday.setDate(d.getDate() - (dayOfWeek - 1));
			key = monday.toISOString().slice(0, 10);
		} else {
			// YYYY-MM-01 (first of the month)
			key = `${k.date.slice(0, 7)}-01`;
		}
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(k);
	}

	const result: KlineRow[] = [];
	for (const [key, bars] of groups) {
		bars.sort((a, b) => a.date.localeCompare(b.date));
		const first = bars[0];
		const last = bars[bars.length - 1];
		result.push({
			code: first.code,
			market: first.market,
			period,
			adjust: first.adjust,
			date: key, // Monday date for week, YYYY-MM-01 for month
			open: first.open,
			high: Math.max(...bars.map((b) => b.high ?? -Infinity)),
			low: Math.min(...bars.map((b) => b.low ?? Infinity)),
			close: last.close,
			volume: bars.reduce((sum, b) => sum + (b.volume ?? 0), 0),
			turnover: bars.reduce((sum, b) => sum + (b.turnover ?? 0), 0),
			change_pct: null,
			change_amount: null,
			amplitude: null,
			pre_close: null,
		});
	}

	result.sort((a, b) => a.date.localeCompare(b.date));
	if (maxBars != null && result.length > maxBars) {
		return result.slice(result.length - maxBars);
	}
	return result;
}

/**
 * Aggregate daily industry klines into weekly or monthly OHLC bars.
 * Uses the same grouping logic as aggregateDailyKlines.
 */
function aggregateDailyIndustryKlines(
	daily: IndustryKlineRow[],
	period: "week" | "month",
	maxBars?: number,
): IndustryKlineRow[] {
	if (daily.length === 0) return [];

	const groups = new Map<string, IndustryKlineRow[]>();

	for (const k of daily) {
		const d = new Date(`${k.date}T00:00:00`);
		let key: string;
		if (period === "week") {
			const dayOfWeek = d.getDay() || 7;
			const monday = new Date(d);
			monday.setDate(d.getDate() - (dayOfWeek - 1));
			key = monday.toISOString().slice(0, 10);
		} else {
			key = `${k.date.slice(0, 7)}-01`;
		}
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(k);
	}

	const result: IndustryKlineRow[] = [];
	for (const [key, bars] of groups) {
		bars.sort((a, b) => a.date.localeCompare(b.date));
		const first = bars[0];
		const last = bars[bars.length - 1];
		result.push({
			code: first.code,
			period,
			date: key,
			open: first.open,
			high: Math.max(...bars.map((b) => b.high ?? -Infinity)),
			low: Math.min(...bars.map((b) => b.low ?? Infinity)),
			close: last.close,
			volume: bars.reduce((sum, b) => sum + (b.volume ?? 0), 0),
			turnover: bars.reduce((sum, b) => sum + (b.turnover ?? 0), 0),
			change_pct: null,
			change_amount: null,
			amplitude: null,
			turnover_rate: null,
		});
	}

	result.sort((a, b) => a.date.localeCompare(b.date));
	if (maxBars != null && result.length > maxBars) {
		return result.slice(result.length - maxBars);
	}
	return result;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stocks (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    market INTEGER NOT NULL,
    industry TEXT,
    concepts TEXT,
    list_date TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS klines (
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    period TEXT NOT NULL,
    adjust TEXT NOT NULL DEFAULT 'bfq',
    date TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    turnover REAL,
    change_pct REAL,
    change_amount REAL,
    amplitude REAL,
    pre_close REAL,
    PRIMARY KEY (code, market, period, adjust, date)
);

CREATE TABLE IF NOT EXISTS quotes (
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    snapshot_date TEXT NOT NULL,
    name TEXT,
    latest REAL,
    open REAL,
    high REAL,
    low REAL,
    prev_close REAL,
    volume REAL,
    turnover REAL,
    change_pct REAL,
    pe REAL,
    pb REAL,
    total_cap REAL,
    float_cap REAL,
    high_52w REAL,
    low_52w REAL,
    updated_at TEXT,
    PRIMARY KEY (code, market, snapshot_date)
);

CREATE TABLE IF NOT EXISTS hot_stocks (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    name TEXT,
    reason TEXT,
    price REAL,
    change_pct REAL,
    turnover_pct REAL,
    amount REAL,
    pe_ttm REAL,
    pb REAL,
    mcap_yi REAL,
    updated_at TEXT,
    PRIMARY KEY (date, code, market)
);

CREATE INDEX IF NOT EXISTS idx_hot_stocks_date ON hot_stocks(date);

CREATE TABLE IF NOT EXISTS fundamentals (
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    report_date TEXT NOT NULL,
    report_type TEXT,
    total_revenue REAL,
    operate_revenue REAL,
    operate_profit REAL,
    total_profit REAL,
    net_profit REAL,
    parent_net_profit REAL,
    eps REAL,
    total_assets REAL,
    total_liabilities REAL,
    total_equity REAL,
    parent_equity REAL,
    operate_cash_flow REAL,
    invest_cash_flow REAL,
    finance_cash_flow REAL,
    net_cash_increase REAL,
    operate_cost REAL,
    total_operate_cost REAL,
    diluted_eps REAL,
    research_expense REAL,
    sale_expense REAL,
    manage_expense REAL,
    finance_expense REAL,
    interest_expense REAL,
    income_tax REAL,
    total_current_assets REAL,
    total_current_liab REAL,
    inventory REAL,
    accounts_rece REAL,
    fixed_asset REAL,
    short_loan REAL,
    long_loan REAL,
    total_noncurrent_liab REAL,
    monetary_funds REAL,
    construct_long_asset REAL,
    credit_impairment REAL,
    asset_impairment REAL,
    non_operate_income REAL,
    non_operate_expense REAL,
    operate_tax_add REAL,
    total_shares REAL,
    updated_at TEXT,
    PRIMARY KEY (code, market, report_date)
);

CREATE TABLE IF NOT EXISTS sectors (
    name TEXT PRIMARY KEY,
    change_pct REAL,
    leading_stock TEXT,
    leading_stock_code TEXT,
    leading_change_pct REAL,
    volume_ratio REAL,
    snapshot_date TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS concept_stocks (
    concept TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    updated_at TEXT,
    PRIMARY KEY (concept, code)
);

CREATE TABLE IF NOT EXISTS business_composition (
    code TEXT NOT NULL,
    report_date TEXT NOT NULL,
    classify_type TEXT NOT NULL,
    item_name TEXT NOT NULL,
    revenue REAL,
    revenue_ratio REAL,
    profit REAL,
    profit_ratio REAL,
    gross_margin REAL,
    updated_at TEXT,
    PRIMARY KEY (code, report_date, classify_type, item_name)
);

CREATE INDEX IF NOT EXISTS idx_business_composition_code ON business_composition(code);
CREATE INDEX IF NOT EXISTS idx_business_composition_date ON business_composition(report_date);

CREATE TABLE IF NOT EXISTS industries (
    industry_code TEXT NOT NULL,
    name TEXT NOT NULL,
    standard TEXT NOT NULL,
    level INTEGER,
    parent_code TEXT,
    start_date TEXT,
    updated_at TEXT,
    PRIMARY KEY (industry_code, standard)
);

CREATE TABLE IF NOT EXISTS stock_industries (
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    industry_code TEXT NOT NULL,
    standard TEXT NOT NULL,
    updated_at TEXT,
    PRIMARY KEY (code, market, industry_code, standard)
);

CREATE TABLE IF NOT EXISTS macro (
    snapshot_date TEXT PRIMARY KEY,
    ndx_latest REAL,
    ndx_change_pct REAL,
    spx_latest REAL,
    spx_change_pct REAL,
    dji_latest REAL,
    dji_change_pct REAL,
    a50_latest REAL,
    a50_change_pct REAL,
    usdcnh_latest REAL,
    usdcnh_change_pct REAL,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_klines_code_period ON klines(code, period, adjust, date);
CREATE INDEX IF NOT EXISTS idx_quotes_date ON quotes(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_fundamentals_code ON fundamentals(code, report_date);
CREATE INDEX IF NOT EXISTS idx_stocks_industry ON stocks(industry);
CREATE INDEX IF NOT EXISTS idx_concept_stocks_concept ON concept_stocks(concept);
CREATE INDEX IF NOT EXISTS idx_stock_industries_code ON stock_industries(code, market);
CREATE INDEX IF NOT EXISTS idx_stock_industries_industry ON stock_industries(industry_code, standard);

CREATE TABLE IF NOT EXISTS industry_indices (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS industry_klines (
    code TEXT NOT NULL,
    period TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    turnover REAL,
    change_pct REAL,
    change_amount REAL,
    amplitude REAL,
    turnover_rate REAL,
    PRIMARY KEY (code, period, date)
);

CREATE INDEX IF NOT EXISTS idx_industry_klines_code_period ON industry_klines(code, period, date);

CREATE TABLE IF NOT EXISTS industry_quotes (
    code TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    name TEXT,
    latest REAL,
    open REAL,
    high REAL,
    low REAL,
    prev_close REAL,
    volume REAL,
    turnover REAL,
    change_pct REAL,
    change_amount REAL,
    amplitude REAL,
    turnover_rate REAL,
    up_count INTEGER,
    down_count INTEGER,
    flat_count INTEGER,
    leading_stock TEXT,
    leading_stock_code TEXT,
    leading_change_pct REAL,
    lagging_stock TEXT,
    lagging_stock_code TEXT,
    lagging_change_pct REAL,
    updated_at TEXT,
    PRIMARY KEY (code, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_industry_quotes_date ON industry_quotes(snapshot_date);

CREATE TABLE IF NOT EXISTS industry_indicators (
    code TEXT NOT NULL,
    date TEXT NOT NULL,
    period_days INTEGER NOT NULL,
    momentum_return REAL,
    momentum_rank INTEGER,
    has_momentum INTEGER,
    updated_at TEXT,
    PRIMARY KEY (code, date, period_days)
);

CREATE INDEX IF NOT EXISTS idx_industry_indicators_date ON industry_indicators(date, period_days);

CREATE TABLE IF NOT EXISTS stock_indicators (
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    date TEXT NOT NULL,
    indicator_name TEXT NOT NULL,
    indicator_value REAL,
    indicator_rank INTEGER,
    has_signal INTEGER,
    updated_at TEXT,
    PRIMARY KEY (code, market, date, indicator_name)
);

CREATE INDEX IF NOT EXISTS idx_stock_indicators_lookup
    ON stock_indicators(code, market, date, indicator_name);
CREATE INDEX IF NOT EXISTS idx_stock_indicators_name_date
    ON stock_indicators(indicator_name, date);

CREATE TABLE IF NOT EXISTS factor_ic (
    date TEXT NOT NULL,
    factor_name TEXT NOT NULL,
    ic_value REAL,
    sample_count INTEGER,
    updated_at TEXT,
    PRIMARY KEY (date, factor_name)
);

CREATE INDEX IF NOT EXISTS idx_factor_ic_lookup ON factor_ic(factor_name, date);

CREATE TABLE IF NOT EXISTS industry_synthetic_klines (
    code TEXT NOT NULL,
    standard TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL,
    constituent_count INTEGER,
    updated_at TEXT,
    PRIMARY KEY (code, standard, date)
);

CREATE INDEX IF NOT EXISTS idx_industry_synthetic_klines_lookup
    ON industry_synthetic_klines(code, standard, date);

CREATE TABLE IF NOT EXISTS stock_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_pool_items (
    pool_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    name TEXT,
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pool_id, code, market),
    FOREIGN KEY (pool_id) REFERENCES stock_pools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pool_items_pool ON stock_pool_items(pool_id);

CREATE TABLE IF NOT EXISTS adjust_factors (
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    date TEXT NOT NULL,
    qfq_factor REAL,
    hfq_factor REAL,
    updated_at TEXT,
    PRIMARY KEY (code, market, date)
);

CREATE INDEX IF NOT EXISTS idx_adjust_factors_date ON adjust_factors(code, market, date);

CREATE TABLE IF NOT EXISTS fundamental_indicators (
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    report_date TEXT NOT NULL,
    revenue_yoy REAL,
    revenue_qoq REAL,
    revenue_cagr_3y REAL,
    revenue_cagr_5y REAL,
    net_profit_yoy REAL,
    net_profit_qoq REAL,
    net_profit_cagr_3y REAL,
    net_profit_cagr_5y REAL,
    operate_cash_flow_yoy REAL,
    operate_cash_flow_qoq REAL,
    fcf REAL,
    fcf_yoy REAL,
    roe REAL,
    roe_change REAL,
    research_expense_yoy REAL,
    research_expense_ratio REAL,
    capex REAL,
    capex_yoy REAL,
    capex_ratio REAL,
    debt_ratio REAL,
    debt_ratio_change REAL,
    current_ratio REAL,
    quick_ratio REAL,
    interest_coverage REAL,
    cash_to_profit REAL,
    cash_to_debt REAL,
    equity_ratio REAL,
    interest_bearing_debt_ratio REAL,
    short_debt_ratio REAL,
    updated_at TEXT,
    PRIMARY KEY (code, market, report_date)
);

CREATE INDEX IF NOT EXISTS idx_fi_code_date ON fundamental_indicators(code, report_date);

CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    code TEXT,
    market INTEGER,
    affected_sectors TEXT,
    importance TEXT DEFAULT 'medium',
    source TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_date, title, code)
);

CREATE INDEX IF NOT EXISTS idx_calendar_date ON calendar_events(event_date);
CREATE INDEX IF NOT EXISTS idx_calendar_code ON calendar_events(code);
CREATE INDEX IF NOT EXISTS idx_calendar_category ON calendar_events(category);

CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    initial_cash REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portfolio_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('buy','sell')),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    price REAL NOT NULL,
    adjust TEXT NOT NULL DEFAULT 'bfq',
    commission REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    memo TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pt_portfolio ON portfolio_trades(portfolio_id, trade_date);
CREATE INDEX IF NOT EXISTS idx_pt_code ON portfolio_trades(code, market);
`;

const DYNAMIC_POOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS dynamic_pool_items (
    pool_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    market INTEGER NOT NULL,
    name TEXT,
    weight REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pool_id, date, code, market),
    FOREIGN KEY (pool_id) REFERENCES stock_pools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dynamic_pool_items_lookup
    ON dynamic_pool_items(pool_id, date);
`;

export class DataStore {
	private db: sqlite3.Database | null = null;
	private dbPath: string;
	private initialized = false;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	async init(): Promise<void> {
		if (this.initialized) return;

		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new sqlite3.Database(this.dbPath);

		await promisifyExec(this.db, "PRAGMA foreign_keys = ON;");
		await promisifyExec(this.db, SCHEMA_SQL);
		await this.runMigrations();
		this.initialized = true;
	}

	private async runMigrations(): Promise<void> {
		if (!this.db) return;

		// Add is_dynamic column to existing stock_pools tables
		const cols = (await promisifyQuery(this.db, "PRAGMA table_info(stock_pools)")) as Array<{ name: string }>;
		if (!cols.some((c) => c.name === "is_dynamic")) {
			await promisifyExec(this.db, "ALTER TABLE stock_pools ADD COLUMN is_dynamic INTEGER DEFAULT 0");
		}

		await promisifyExec(this.db, DYNAMIC_POOL_SCHEMA);

		// 统一 K 线周期命名：weekly/monthly -> week/month，并删除残留旧命名数据
		await promisifyExec(this.db, "UPDATE OR IGNORE klines SET period = 'week' WHERE period = 'weekly'");
		await promisifyExec(this.db, "UPDATE OR IGNORE klines SET period = 'month' WHERE period = 'monthly'");
		await promisifyExec(this.db, "DELETE FROM klines WHERE period = 'weekly' OR period = 'monthly'");
		await promisifyExec(this.db, "UPDATE OR IGNORE industry_klines SET period = 'week' WHERE period = 'weekly'");
		await promisifyExec(this.db, "UPDATE OR IGNORE industry_klines SET period = 'month' WHERE period = 'monthly'");
		await promisifyExec(this.db, "DELETE FROM industry_klines WHERE period = 'weekly' OR period = 'monthly'");
	}

	// ─── Stocks ─────────────────────────────────────────────────────

	async saveStocks(stocks: StockRow[]): Promise<void> {
		if (stocks.length === 0 || !this.db) return;
		const now = new Date().toISOString();
		for (const stock of stocks) {
			const concepts = stock.concepts ? JSON.stringify(stock.concepts) : null;
			const sql = `
				INSERT OR REPLACE INTO stocks (code, name, market, industry, concepts, list_date, updated_at)
				VALUES (${s(stock.code)}, ${s(stock.name)}, ${stock.market}, ${s(stock.industry)},
					${concepts ? s(concepts) : "NULL"}, ${s(stock.list_date)}, ${s(now)})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async getStock(code: string): Promise<StockRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(this.db, `SELECT * FROM stocks WHERE code = ${s(code)} LIMIT 1`);
		const row = rows[0];
		if (!row) return null;
		return {
			...row,
			concepts: row.concepts ? JSON.parse(row.concepts) : undefined,
		} as StockRow;
	}

	async getStocksByIndustry(industry: string): Promise<StockRow[]> {
		if (!this.db) return [];
		const rows = await promisifyQuery(this.db, `SELECT * FROM stocks WHERE industry = ${s(industry)}`);
		return rows.map((r) => ({ ...r, concepts: r.concepts ? JSON.parse(r.concepts) : undefined }));
	}

	async getStocksByConcept(concept: string): Promise<StockRow[]> {
		if (!this.db) return [];
		const rows = await promisifyQuery(
			this.db,
			`SELECT s.* FROM stocks s JOIN concept_stocks cs ON s.code = cs.code WHERE cs.concept = ${s(concept)}`,
		);
		return rows.map((r) => ({ ...r, concepts: r.concepts ? JSON.parse(r.concepts) : undefined }));
	}

	async getAllStocks(): Promise<StockRow[]> {
		if (!this.db) return [];
		const rows = await promisifyQuery(this.db, `SELECT * FROM stocks ORDER BY code`);
		return rows.map((r) => ({ ...r, concepts: r.concepts ? JSON.parse(r.concepts) : undefined }));
	}

	async searchStocks(query: string, limit = 10): Promise<StockRow[]> {
		if (!this.db || !query) return [];
		const q = s(query);
		const rows = await promisifyQuery(
			this.db,
			`SELECT * FROM stocks WHERE code LIKE ${q} || '%' OR name LIKE '%' || ${q} || '%' ORDER BY code LIMIT ${limit}`,
		);
		return rows.map((r) => ({ ...r, concepts: r.concepts ? JSON.parse(r.concepts) : undefined }));
	}

	// ─── Klines ─────────────────────────────────────────────────────

	async saveKlines(klines: KlineRow[]): Promise<void> {
		if (klines.length === 0 || !this.db) return;
		const values = klines
			.map((k) => {
				const f = (v: number | null) => (v == null ? "NULL" : String(v));
				return `(${s(k.code)}, ${k.market}, ${s(k.period)}, ${s(k.adjust)}, ${s(k.date)}, ${f(k.open)}, ${f(k.high)}, ${f(k.low)}, ${f(k.close)}, ${f(k.volume)}, ${f(k.turnover)}, ${f(k.change_pct)}, ${f(k.change_amount)}, ${f(k.amplitude)}, ${f(k.pre_close)})`;
			})
			.join(",\n");

		const sql = `
			INSERT OR REPLACE INTO klines
			(code, market, period, adjust, date, open, high, low, close, volume, turnover, change_pct, change_amount, amplitude, pre_close)
			VALUES ${values}
		`;
		await promisifyExec(this.db, sql);
	}

	async getKlines(filter: KlineFilter): Promise<KlineRow[]> {
		if (!this.db) return [];

		// Week/month klines are aggregated on-the-fly from daily data.
		// The background sync only fetches daily klines; storing weekly/monthly
		// would duplicate data and add sync complexity for no benefit.
		if (filter.period === "week" || filter.period === "month") {
			const dailyKlines = await this.queryKlines({
				...filter,
				period: "daily",
				// Fetch enough daily bars to satisfy the requested limit after aggregation
				limit: filter.limit ? filter.limit * (filter.period === "week" ? 7 : 22) : undefined,
			});
			return aggregateDailyKlines(dailyKlines, filter.period, filter.limit);
		}

		return this.queryKlines(filter);
	}

	private async queryKlines(filter: KlineFilter): Promise<KlineRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM klines WHERE code = ${s(filter.code)} AND open IS NOT NULL`;
		if (filter.market != null) sql += ` AND market = ${filter.market}`;
		if (filter.period) sql += ` AND period = ${s(filter.period)}`;
		if (filter.adjust) sql += ` AND adjust = ${s(filter.adjust)}`;
		if (filter.start) sql += ` AND date >= ${s(filter.start)}`;
		if (filter.end) sql += ` AND date <= ${s(filter.end)}`;
		sql += ` ORDER BY date`;
		if (filter.limit) sql += ` LIMIT ${filter.limit}`;
		return promisifyQuery(this.db, sql);
	}

	async getKlinesForCodes(
		codes: Array<{ code: string; market: number }>,
		period: string,
		adjust: string,
		start: string,
		end: string,
	): Promise<Map<string, KlineRow[]>> {
		const result = new Map<string, KlineRow[]>();
		if (!this.db || codes.length === 0) return result;

		const tuples = codes.map((c) => `(${s(c.code)}, ${c.market})`).join(",");
		const sql = `
			SELECT * FROM klines
			WHERE (code, market) IN (VALUES ${tuples})
			  AND period = ${s(period)}
			  AND adjust = ${s(adjust)}
			  AND date >= ${s(start)}
			  AND date <= ${s(end)}
			ORDER BY code, market, date
		`;
		const rows = (await promisifyQuery(this.db, sql)) as KlineRow[];
		for (const row of rows) {
			const key = `${row.code}_${row.market}`;
			if (!result.has(key)) result.set(key, []);
			result.get(key)!.push(row);
		}
		return result;
	}

	async getLatestKlineDate(code: string, market: number, period: string, adjust: string): Promise<string | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT MAX(date) as max_date FROM klines WHERE code = ${s(code)} AND market = ${market} AND period = ${s(period)} AND adjust = ${s(adjust)}`,
		);
		return rows[0]?.max_date ?? null;
	}

	// ─── Adjust Factors ─────────────────────────────────────────────

	async saveAdjustFactors(factors: AdjustFactorRow[]): Promise<void> {
		if (!this.db || factors.length === 0) return;
		const now = new Date().toISOString();
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const values = factors
			.map(
				(factor) =>
					`(${s(factor.code)}, ${factor.market}, ${s(factor.date)}, ${f(factor.qfq_factor)}, ${f(factor.hfq_factor)}, ${s(now)})`,
			)
			.join(",");
		const sql = `INSERT OR REPLACE INTO adjust_factors (code, market, date, qfq_factor, hfq_factor, updated_at) VALUES ${values}`;
		await promisifyExec(this.db, sql);
	}

	async getAdjustFactors(code: string, market: number, start?: string, end?: string): Promise<AdjustFactorRow[]> {
		if (!this.db) return [];
		let sql = `SELECT code, market, date, qfq_factor, hfq_factor FROM adjust_factors WHERE code = ${s(code)} AND market = ${market}`;
		if (start) sql += ` AND date >= ${s(start)}`;
		if (end) sql += ` AND date <= ${s(end)}`;
		sql += ` ORDER BY date`;
		return promisifyQuery(this.db, sql);
	}

	async getAdjustFactorsForCodes(
		codes: Array<{ code: string; market: number }>,
		start: string,
		end: string,
	): Promise<Map<string, AdjustFactorRow[]>> {
		const result = new Map<string, AdjustFactorRow[]>();
		if (!this.db || codes.length === 0) return result;

		const tuples = codes.map((c) => `(${s(c.code)}, ${c.market})`).join(",");
		const sql = `
			SELECT code, market, date, qfq_factor, hfq_factor FROM adjust_factors
			WHERE (code, market) IN (VALUES ${tuples})
			  AND date >= ${s(start)}
			  AND date <= ${s(end)}
			ORDER BY code, market, date
		`;
		const rows = (await promisifyQuery(this.db, sql)) as AdjustFactorRow[];
		for (const row of rows) {
			const key = `${row.code}_${row.market}`;
			if (!result.has(key)) result.set(key, []);
			result.get(key)!.push(row);
		}
		return result;
	}

	async getLatestFactorDate(code: string, market: number): Promise<string | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT MAX(date) as max_date FROM adjust_factors WHERE code = ${s(code)} AND market = ${market}`,
		);
		return rows[0]?.max_date ?? null;
	}

	// ─── Quotes ─────────────────────────────────────────────────────

	async saveQuote(quote: QuoteRow): Promise<void> {
		if (!this.db) return;
		const f = (v: number | string | null | undefined) => {
			if (v == null || Number.isNaN(v) || v === "" || v === "-" || v === "—") return "NULL";
			if (typeof v === "number") return String(v);
			const n = Number(v);
			return Number.isFinite(n) ? String(n) : "NULL";
		};
		const sql = `
			INSERT OR REPLACE INTO quotes
			(code, market, snapshot_date, name, latest, open, high, low, prev_close, volume, turnover, change_pct, pe, pb, total_cap, float_cap, high_52w, low_52w, updated_at)
			VALUES (${s(quote.code)}, ${quote.market}, ${s(quote.snapshot_date)}, ${s(quote.name)},
				${f(quote.latest)}, ${f(quote.open)}, ${f(quote.high)}, ${f(quote.low)}, ${f(quote.prev_close)},
				${f(quote.volume)}, ${f(quote.turnover)}, ${f(quote.change_pct)}, ${f(quote.pe)}, ${f(quote.pb)},
				${f(quote.total_cap)}, ${f(quote.float_cap)}, ${f(quote.high_52w)}, ${f(quote.low_52w)}, ${s(quote.updated_at ?? new Date().toISOString())})
		`;
		await promisifyExec(this.db, sql);
	}

	async getQuote(code: string, market: number, date: string): Promise<QuoteRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT * FROM quotes WHERE code = ${s(code)} AND market = ${market} AND snapshot_date = ${s(date)} LIMIT 1`,
		);
		return rows[0] ?? null;
	}

	async getLatestQuotes(codes?: string[], markets?: number[]): Promise<QuoteRow[]> {
		if (!this.db) return [];
		if (codes && codes.length > 0) {
			// When markets are provided alongside codes, filter by (code, market) pairs
			// to avoid collisions where the same code exists for different markets
			// (e.g., 000001 is both 平安银行 market=0 and 上证指数 market=1)
			if (markets && markets.length === codes.length) {
				const conditions = codes.map((c, i) => `(code = ${s(c)} AND market = ${markets[i]})`).join(" OR ");
				return promisifyQuery(
					this.db,
					`SELECT * FROM quotes WHERE (${conditions}) AND snapshot_date = (SELECT MAX(snapshot_date) FROM quotes)`,
				);
			}
			const codeList = codes.map((c) => s(c)).join(", ");
			return promisifyQuery(
				this.db,
				`SELECT * FROM quotes WHERE code IN (${codeList}) AND snapshot_date = (SELECT MAX(snapshot_date) FROM quotes)`,
			);
		}
		return promisifyQuery(
			this.db,
			`SELECT * FROM quotes WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM quotes)`,
		);
	}

	// ─── Fundamentals ───────────────────────────────────────────────

	async saveFundamentals(data: FundamentalsRow): Promise<void> {
		if (!this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const sql = `
			INSERT OR REPLACE INTO fundamentals
			(code, market, report_date, report_type, total_revenue, operate_revenue, operate_profit, total_profit, net_profit, parent_net_profit, eps,
			 total_assets, total_liabilities, total_equity, parent_equity, operate_cash_flow, invest_cash_flow, finance_cash_flow, net_cash_increase,
			 operate_cost, total_operate_cost, diluted_eps, research_expense, sale_expense, manage_expense, finance_expense, interest_expense, income_tax,
			 total_current_assets, total_current_liab, inventory, accounts_rece, fixed_asset, short_loan, long_loan, total_noncurrent_liab, monetary_funds,
			 construct_long_asset, credit_impairment, asset_impairment, non_operate_income, non_operate_expense, operate_tax_add, total_shares, updated_at)
			VALUES (${s(data.code)}, ${data.market}, ${s(data.report_date)}, ${s(data.report_type)},
				${f(data.total_revenue)}, ${f(data.operate_revenue)}, ${f(data.operate_profit)}, ${f(data.total_profit)}, ${f(data.net_profit)}, ${f(data.parent_net_profit)}, ${f(data.eps)},
				${f(data.total_assets)}, ${f(data.total_liabilities)}, ${f(data.total_equity)}, ${f(data.parent_equity)},
				${f(data.operate_cash_flow)}, ${f(data.invest_cash_flow)}, ${f(data.finance_cash_flow)}, ${f(data.net_cash_increase)},
				${f(data.operate_cost)}, ${f(data.total_operate_cost)}, ${f(data.diluted_eps)}, ${f(data.research_expense)}, ${f(data.sale_expense)}, ${f(data.manage_expense)}, ${f(data.finance_expense)}, ${f(data.interest_expense)}, ${f(data.income_tax)},
				${f(data.total_current_assets)}, ${f(data.total_current_liab)}, ${f(data.inventory)}, ${f(data.accounts_rece)}, ${f(data.fixed_asset)}, ${f(data.short_loan)}, ${f(data.long_loan)}, ${f(data.total_noncurrent_liab)}, ${f(data.monetary_funds)},
				${f(data.construct_long_asset)}, ${f(data.credit_impairment)}, ${f(data.asset_impairment)}, ${f(data.non_operate_income)}, ${f(data.non_operate_expense)}, ${f(data.operate_tax_add)}, ${f(data.total_shares)}, ${s(data.updated_at ?? new Date().toISOString())})
		`;
		await promisifyExec(this.db, sql);
	}

	async getFundamentals(code: string, market: number): Promise<FundamentalsRow[]> {
		if (!this.db) return [];
		return promisifyQuery(
			this.db,
			`SELECT * FROM fundamentals WHERE code = ${s(code)} AND market = ${market} ORDER BY report_date DESC`,
		);
	}

	async getLatestFundamentals(code: string, market: number): Promise<FundamentalsRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT * FROM fundamentals WHERE code = ${s(code)} AND market = ${market} ORDER BY report_date DESC LIMIT 1`,
		);
		return rows[0] ?? null;
	}

	// ─── Fundamental Indicators ─────────────────────────────────────

	async saveFundamentalIndicators(data: FundamentalIndicatorsRow): Promise<void> {
		if (!this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const sql = `
			INSERT OR REPLACE INTO fundamental_indicators
			(code, market, report_date, revenue_yoy, revenue_qoq, revenue_cagr_3y, revenue_cagr_5y,
			 net_profit_yoy, net_profit_qoq, net_profit_cagr_3y, net_profit_cagr_5y,
			 operate_cash_flow_yoy, operate_cash_flow_qoq, fcf, fcf_yoy, roe, roe_change,
			 research_expense_yoy, research_expense_ratio, capex, capex_yoy, capex_ratio,
			 debt_ratio, debt_ratio_change, current_ratio, quick_ratio, interest_coverage,
			 cash_to_profit, cash_to_debt, equity_ratio, interest_bearing_debt_ratio, short_debt_ratio, updated_at)
			VALUES (${s(data.code)}, ${data.market}, ${s(data.report_date)},
				${f(data.revenue_yoy)}, ${f(data.revenue_qoq)}, ${f(data.revenue_cagr_3y)}, ${f(data.revenue_cagr_5y)},
				${f(data.net_profit_yoy)}, ${f(data.net_profit_qoq)}, ${f(data.net_profit_cagr_3y)}, ${f(data.net_profit_cagr_5y)},
				${f(data.operate_cash_flow_yoy)}, ${f(data.operate_cash_flow_qoq)}, ${f(data.fcf)}, ${f(data.fcf_yoy)}, ${f(data.roe)}, ${f(data.roe_change)},
				${f(data.research_expense_yoy)}, ${f(data.research_expense_ratio)}, ${f(data.capex)}, ${f(data.capex_yoy)}, ${f(data.capex_ratio)},
				${f(data.debt_ratio)}, ${f(data.debt_ratio_change)}, ${f(data.current_ratio)}, ${f(data.quick_ratio)}, ${f(data.interest_coverage)},
				${f(data.cash_to_profit)}, ${f(data.cash_to_debt)}, ${f(data.equity_ratio)}, ${f(data.interest_bearing_debt_ratio)}, ${f(data.short_debt_ratio)},
				${s(data.updated_at ?? new Date().toISOString())})
		`;
		await promisifyExec(this.db, sql);
	}

	async getFundamentalIndicators(code: string, market: number): Promise<FundamentalIndicatorsRow[]> {
		if (!this.db) return [];
		return promisifyQuery(
			this.db,
			`SELECT * FROM fundamental_indicators WHERE code = ${s(code)} AND market = ${market} ORDER BY report_date DESC`,
		);
	}

	async getLatestFundamentalIndicators(code: string, market: number): Promise<FundamentalIndicatorsRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT * FROM fundamental_indicators WHERE code = ${s(code)} AND market = ${market} ORDER BY report_date DESC LIMIT 1`,
		);
		return rows[0] ?? null;
	}

	// ─── Sectors ────────────────────────────────────────────────────

	async saveSectors(sectors: SectorRow[]): Promise<void> {
		if (sectors.length === 0 || !this.db) return;
		for (const sector of sectors) {
			const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
			const sql = `
				INSERT OR REPLACE INTO sectors (name, change_pct, leading_stock, leading_stock_code, leading_change_pct, volume_ratio, snapshot_date, updated_at)
				VALUES (${s(sector.name)}, ${f(sector.change_pct)}, ${s(sector.leading_stock)}, ${s(sector.leading_stock_code)},
					${f(sector.leading_change_pct)}, ${f(sector.volume_ratio)}, ${s(sector.snapshot_date)}, ${s(sector.updated_at ?? new Date().toISOString())})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async getSectors(): Promise<SectorRow[]> {
		if (!this.db) return [];
		return promisifyQuery(this.db, `SELECT * FROM sectors ORDER BY change_pct DESC`);
	}

	// ─── Hot Stocks ─────────────────────────────────────────────────

	async saveHotStocks(rows: HotStockRow[]): Promise<void> {
		if (rows.length === 0 || !this.db) return;
		const now = new Date().toISOString();
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		for (const row of rows) {
			const sql = `
				INSERT OR REPLACE INTO hot_stocks
				(date, code, market, name, reason, price, change_pct, turnover_pct, amount, pe_ttm, pb, mcap_yi, updated_at)
				VALUES (${s(row.date)}, ${s(row.code)}, ${row.market}, ${s(row.name)}, ${s(row.reason)},
					${f(row.price)}, ${f(row.change_pct)}, ${f(row.turnover_pct)}, ${f(row.amount)},
					${f(row.pe_ttm)}, ${f(row.pb)}, ${f(row.mcap_yi)}, ${s(row.updated_at ?? now)})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async getHotStocks(date?: string): Promise<HotStockRow[]> {
		if (!this.db) return [];
		const targetDate = date ?? new Date().toISOString().slice(0, 10);
		return promisifyQuery(this.db, `SELECT * FROM hot_stocks WHERE date = ${s(targetDate)} ORDER BY change_pct DESC`);
	}

	// ─── Concept Stocks ─────────────────────────────────────────────

	async saveConceptStocks(items: ConceptStockRow[]): Promise<void> {
		if (items.length === 0 || !this.db) return;
		for (const item of items) {
			const sql = `
				INSERT OR REPLACE INTO concept_stocks (concept, code, name, updated_at)
				VALUES (${s(item.concept)}, ${s(item.code)}, ${s(item.name)}, ${s(item.updated_at ?? new Date().toISOString())})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async getConceptStocks(concept: string): Promise<ConceptStockRow[]> {
		if (!this.db) return [];
		return promisifyQuery(this.db, `SELECT * FROM concept_stocks WHERE concept = ${s(concept)}`);
	}

	async getAllConcepts(): Promise<string[]> {
		if (!this.db) return [];
		const rows = (await promisifyQuery(this.db, `SELECT DISTINCT concept FROM concept_stocks ORDER BY concept`)) as {
			concept: string;
		}[];
		return rows.map((r) => r.concept);
	}

	// ─── Business Composition ───────────────────────────────────────

	async saveBusinessComposition(items: BusinessCompositionRow[]): Promise<void> {
		if (items.length === 0 || !this.db) return;
		const now = new Date().toISOString();
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		for (const item of items) {
			const sql = `
				INSERT OR REPLACE INTO business_composition
				(code, report_date, classify_type, item_name, revenue, revenue_ratio, profit, profit_ratio, gross_margin, updated_at)
				VALUES (${s(item.code)}, ${s(item.report_date)}, ${s(item.classify_type)}, ${s(item.item_name)},
					${f(item.revenue)}, ${f(item.revenue_ratio)}, ${f(item.profit)}, ${f(item.profit_ratio)}, ${f(item.gross_margin)}, ${s(now)})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async getBusinessComposition(code: string): Promise<BusinessCompositionRow[]> {
		if (!this.db) return [];
		return promisifyQuery(
			this.db,
			`SELECT * FROM business_composition WHERE code = ${s(code)} ORDER BY report_date DESC, classify_type, item_name`,
		);
	}

	async getLatestBusinessCompositionDate(code: string): Promise<string | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT MAX(report_date) as max_date FROM business_composition WHERE code = ${s(code)}`,
		);
		return rows[0]?.max_date ?? null;
	}

	// ─── Industries ─────────────────────────────────────────────────

	async saveIndustries(items: IndustryRow[]): Promise<void> {
		if (items.length === 0 || !this.db) return;
		for (const item of items) {
			const sql = `
				INSERT OR REPLACE INTO industries (industry_code, name, standard, level, parent_code, start_date, updated_at)
				VALUES (${s(item.industry_code)}, ${s(item.name)}, ${s(item.standard)},
					${item.level ?? "NULL"}, ${s(item.parent_code)}, ${s(item.start_date)},
					${s(item.updated_at ?? new Date().toISOString())})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async saveStockIndustries(items: StockIndustryRow[]): Promise<void> {
		if (items.length === 0 || !this.db) return;
		for (const item of items) {
			const sql = `
				INSERT OR REPLACE INTO stock_industries (code, market, industry_code, standard, updated_at)
				VALUES (${s(item.code)}, ${item.market}, ${s(item.industry_code)}, ${s(item.standard)},
					${s(item.updated_at ?? new Date().toISOString())})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async getIndustryStocks(
		industryCode: string,
		standard?: string,
	): Promise<{ code: string; market: number; name?: string }[]> {
		if (!this.db) return [];
		let sql = `
			SELECT si.code, si.market, s.name
			FROM stock_industries si
			LEFT JOIN stocks s ON si.code = s.code AND si.market = s.market
			WHERE si.industry_code = ${s(industryCode)}
		`;
		if (standard) {
			sql += ` AND si.standard = ${s(standard)}`;
		}
		return promisifyQuery(this.db, sql);
	}

	async getStockIndustries(code: string, market: number): Promise<StockIndustryRow[]> {
		if (!this.db) return [];
		return promisifyQuery(
			this.db,
			`SELECT si.*, i.name as industry_name
			 FROM stock_industries si
			 JOIN industries i ON si.industry_code = i.industry_code AND si.standard = i.standard
			 WHERE si.code = ${s(code)} AND si.market = ${market}`,
		);
	}

	async getIndustries(standard?: string, level?: number): Promise<IndustryRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM industries WHERE 1=1`;
		if (standard) sql += ` AND standard = ${s(standard)}`;
		if (level != null) sql += ` AND level = ${level}`;
		sql += ` ORDER BY standard, level, industry_code`;
		return promisifyQuery(this.db, sql);
	}

	async findIndustryByName(name: string, standard?: string): Promise<IndustryRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM industries WHERE name LIKE '%' || ${s(name)} || '%'`;
		if (standard) sql += ` AND standard = ${s(standard)}`;
		const rows: IndustryRow[] = await promisifyQuery(this.db, sql);
		// Prefer exact matches, then prefix matches, then substring matches
		return rows.sort((a, b) => {
			const aExact = a.name === name ? 0 : a.name.startsWith(name) ? 1 : 2;
			const bExact = b.name === name ? 0 : b.name.startsWith(name) ? 1 : 2;
			return aExact - bExact;
		});
	}

	// ─── Industry Indices ───────────────────────────────────────────

	async saveIndustryList(items: IndustryIndexRow[]): Promise<void> {
		if (items.length === 0 || !this.db) return;
		const now = new Date().toISOString();
		for (const item of items) {
			const sql = `
				INSERT OR REPLACE INTO industry_indices (code, name, updated_at)
				VALUES (${s(item.code)}, ${s(item.name)}, ${s(item.updated_at ?? now)})
			`;
			await promisifyExec(this.db, sql);
		}
	}

	async getIndustryList(): Promise<IndustryIndexRow[]> {
		if (!this.db) return [];
		return promisifyQuery(this.db, `SELECT code, name, updated_at FROM industry_indices ORDER BY code`);
	}

	async saveIndustryKlines(klines: IndustryKlineRow[]): Promise<void> {
		if (klines.length === 0 || !this.db) return;
		const f = (v: number | null) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const values = klines
			.map(
				(k) =>
					`(${s(k.code)}, ${s(k.period)}, ${s(k.date)}, ${f(k.open)}, ${f(k.high)}, ${f(k.low)}, ${f(k.close)}, ${f(k.volume)}, ${f(k.turnover)}, ${f(k.change_pct)}, ${f(k.change_amount)}, ${f(k.amplitude)}, ${f(k.turnover_rate)})`,
			)
			.join(",\n");
		const sql = `
			INSERT OR REPLACE INTO industry_klines
			(code, period, date, open, high, low, close, volume, turnover, change_pct, change_amount, amplitude, turnover_rate)
			VALUES ${values}
		`;
		await promisifyExec(this.db, sql);
	}

	async getIndustryKlines(
		code: string,
		period: string,
		start?: string,
		end?: string,
		limit?: number,
	): Promise<IndustryKlineRow[]> {
		if (!this.db) return [];

		// Aggregate week/month from daily industry klines on the fly
		if (period === "week" || period === "month") {
			const dailyKlines = await this.queryIndustryKlines(
				code,
				"daily",
				start,
				end,
				limit ? limit * (period === "week" ? 7 : 22) : undefined,
			);
			return aggregateDailyIndustryKlines(dailyKlines, period, limit);
		}

		return this.queryIndustryKlines(code, period, start, end, limit);
	}

	private async queryIndustryKlines(
		code: string,
		period: string,
		start?: string,
		end?: string,
		limit?: number,
	): Promise<IndustryKlineRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM industry_klines WHERE code = ${s(code)} AND period = ${s(period)} AND open IS NOT NULL`;
		if (start) sql += ` AND date >= ${s(start)}`;
		if (end) sql += ` AND date <= ${s(end)}`;
		sql += ` ORDER BY date`;
		if (limit) sql += ` LIMIT ${limit}`;
		return promisifyQuery(this.db, sql);
	}

	async getLatestIndustryKlineDate(code: string, period: string): Promise<string | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT MAX(date) as max_date FROM industry_klines WHERE code = ${s(code)} AND period = ${s(period)}`,
		);
		return rows[0]?.max_date ?? null;
	}

	async saveIndustryQuote(quote: IndustryQuoteRow): Promise<void> {
		if (!this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const sql = `
			INSERT OR REPLACE INTO industry_quotes
			(code, snapshot_date, name, latest, open, high, low, prev_close, volume, turnover, change_pct, change_amount, amplitude, turnover_rate,
			 up_count, down_count, flat_count, leading_stock, leading_stock_code, leading_change_pct, lagging_stock, lagging_stock_code, lagging_change_pct, updated_at)
			VALUES (${s(quote.code)}, ${s(quote.snapshot_date)}, ${s(quote.name)},
				${f(quote.latest)}, ${f(quote.open)}, ${f(quote.high)}, ${f(quote.low)}, ${f(quote.prev_close)},
				${f(quote.volume)}, ${f(quote.turnover)}, ${f(quote.change_pct)}, ${f(quote.change_amount)}, ${f(quote.amplitude)}, ${f(quote.turnover_rate)},
				${f(quote.up_count)}, ${f(quote.down_count)}, ${f(quote.flat_count)},
				${s(quote.leading_stock)}, ${s(quote.leading_stock_code)}, ${f(quote.leading_change_pct)},
				${s(quote.lagging_stock)}, ${s(quote.lagging_stock_code)}, ${f(quote.lagging_change_pct)},
				${s(quote.updated_at ?? new Date().toISOString())})
		`;
		await promisifyExec(this.db, sql);
	}

	async getIndustryQuote(code: string, date: string): Promise<IndustryQuoteRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT * FROM industry_quotes WHERE code = ${s(code)} AND snapshot_date = ${s(date)} LIMIT 1`,
		);
		return rows[0] ?? null;
	}

	async getLatestIndustryQuotes(codes?: string[]): Promise<IndustryQuoteRow[]> {
		if (!this.db) return [];
		if (codes && codes.length > 0) {
			const codeList = codes.map((c) => s(c)).join(", ");
			return promisifyQuery(
				this.db,
				`SELECT * FROM industry_quotes WHERE code IN (${codeList}) AND snapshot_date = (SELECT MAX(snapshot_date) FROM industry_quotes)`,
			);
		}
		return promisifyQuery(
			this.db,
			`SELECT * FROM industry_quotes WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM industry_quotes)`,
		);
	}

	// ─── Industry Indicators ────────────────────────────────────────

	async saveIndustryIndicators(indicators: IndustryIndicatorRow[]): Promise<void> {
		if (indicators.length === 0 || !this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const now = new Date().toISOString();
		const values = indicators
			.map(
				(r) =>
					`(${s(r.code)}, ${s(r.date)}, ${r.period_days}, ${f(r.momentum_return)}, ${f(r.momentum_rank)}, ${f(r.has_momentum)}, ${s(now)})`,
			)
			.join(", ");
		const sql = `
			INSERT OR REPLACE INTO industry_indicators
			(code, date, period_days, momentum_return, momentum_rank, has_momentum, updated_at)
			VALUES ${values}
		`;
		await promisifyExec(this.db, sql);
	}

	async getIndustryIndicators(
		code: string,
		periodDays: number,
		start?: string,
		end?: string,
	): Promise<IndustryIndicatorRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM industry_indicators WHERE code = ${s(code)} AND period_days = ${periodDays}`;
		if (start) sql += ` AND date >= ${s(start)}`;
		if (end) sql += ` AND date <= ${s(end)}`;
		sql += ` ORDER BY date`;
		return promisifyQuery(this.db, sql);
	}

	async getLatestIndustryIndicatorDate(code: string, periodDays: number): Promise<string | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT MAX(date) as max_date FROM industry_indicators WHERE code = ${s(code)} AND period_days = ${periodDays}`,
		);
		return rows[0]?.max_date ?? null;
	}

	// ─── Stock Indicators ───────────────────────────────────────────

	async saveStockIndicators(rows: StockIndicatorRow[]): Promise<void> {
		if (rows.length === 0 || !this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const now = new Date().toISOString();
		const values = rows
			.map(
				(r) =>
					`(${s(r.code)}, ${r.market}, ${s(r.date)}, ${s(r.indicator_name)}, ${f(r.indicator_value)}, ${f(r.indicator_rank)}, ${f(r.has_signal)}, ${s(now)})`,
			)
			.join(", ");
		const sql = `
			INSERT OR REPLACE INTO stock_indicators
			(code, market, date, indicator_name, indicator_value, indicator_rank, has_signal, updated_at)
			VALUES ${values}
		`;
		await promisifyExec(this.db, sql);
	}

	async getStockIndicators(
		code: string,
		market: number,
		indicatorName: string,
		start?: string,
		end?: string,
	): Promise<StockIndicatorRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM stock_indicators WHERE code = ${s(code)} AND market = ${market} AND indicator_name = ${s(indicatorName)}`;
		if (start) sql += ` AND date >= ${s(start)}`;
		if (end) sql += ` AND date <= ${s(end)}`;
		sql += ` ORDER BY date`;
		return promisifyQuery(this.db, sql);
	}

	async saveFactorIc(rows: FactorIcRow[]): Promise<void> {
		if (rows.length === 0 || !this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const now = new Date().toISOString();
		const values = rows
			.map((r) => `(${s(r.date)}, ${s(r.factor_name)}, ${f(r.ic_value)}, ${f(r.sample_count)}, ${s(now)})`)
			.join(", ");
		const sql = `
			INSERT OR REPLACE INTO factor_ic
			(date, factor_name, ic_value, sample_count, updated_at)
			VALUES ${values}
		`;
		await promisifyExec(this.db, sql);
	}

	async getFactorIc(factorName: string, start?: string, end?: string): Promise<FactorIcRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM factor_ic WHERE factor_name = ${s(factorName)}`;
		if (start) sql += ` AND date >= ${s(start)}`;
		if (end) sql += ` AND date <= ${s(end)}`;
		sql += ` ORDER BY date`;
		return promisifyQuery(this.db, sql);
	}

	// ─── Synthetic Industry Klines ──────────────────────────────────

	async saveIndustrySyntheticKlines(klines: IndustrySyntheticKlineRow[]): Promise<void> {
		if (klines.length === 0 || !this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const now = new Date().toISOString();
		const values = klines
			.map(
				(r) =>
					`(${s(r.code)}, ${s(r.standard)}, ${s(r.date)}, ${f(r.close)}, ${f(r.constituent_count)}, ${s(now)})`,
			)
			.join(", ");
		const sql = `
			INSERT OR REPLACE INTO industry_synthetic_klines
			(code, standard, date, close, constituent_count, updated_at)
			VALUES ${values}
		`;
		await promisifyExec(this.db, sql);
	}

	async getIndustrySyntheticKlines(
		code: string,
		standard: string,
		start?: string,
		end?: string,
	): Promise<IndustrySyntheticKlineRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM industry_synthetic_klines WHERE code = ${s(code)} AND standard = ${s(standard)}`;
		if (start) sql += ` AND date >= ${s(start)}`;
		if (end) sql += ` AND date <= ${s(end)}`;
		sql += ` ORDER BY date`;
		return promisifyQuery(this.db, sql);
	}

	// ─── Macro ──────────────────────────────────────────────────────

	async saveMacro(data: MacroRow): Promise<void> {
		if (!this.db) return;
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const sql = `
			INSERT OR REPLACE INTO macro
			(snapshot_date, ndx_latest, ndx_change_pct, spx_latest, spx_change_pct, dji_latest, dji_change_pct,
			 a50_latest, a50_change_pct, usdcnh_latest, usdcnh_change_pct, updated_at)
			VALUES (${s(data.snapshot_date)}, ${f(data.ndx_latest)}, ${f(data.ndx_change_pct)}, ${f(data.spx_latest)}, ${f(data.spx_change_pct)},
				${f(data.dji_latest)}, ${f(data.dji_change_pct)}, ${f(data.a50_latest)}, ${f(data.a50_change_pct)},
				${f(data.usdcnh_latest)}, ${f(data.usdcnh_change_pct)}, ${s(data.updated_at ?? new Date().toISOString())})
		`;
		await promisifyExec(this.db, sql);
	}

	async getLatestMacro(): Promise<MacroRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(this.db, `SELECT * FROM macro ORDER BY snapshot_date DESC LIMIT 1`);
		return rows[0] ?? null;
	}

	// ─── Utility ────────────────────────────────────────────────────

	async query<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
		if (!this.db) return [];
		return promisifyQuery(this.db, sql, params);
	}

	async execute(sql: string): Promise<void> {
		if (!this.db) return;
		await promisifyExec(this.db, sql);
	}

	async getTableCounts(): Promise<Record<string, number>> {
		if (!this.db) return {};
		const tables = [
			"stocks",
			"klines",
			"quotes",
			"fundamentals",
			"fundamental_indicators",
			"sectors",
			"hot_stocks",
			"concept_stocks",
			"business_composition",
			"macro",
			"stock_pools",
			"stock_pool_items",
			"calendar_events",
			"portfolios",
			"portfolio_trades",
			"industry_indices",
			"industry_klines",
			"industry_quotes",
			"industry_indicators",
			"factor_ic",
			"industry_synthetic_klines",
		];
		const result: Record<string, number> = {};
		for (const t of tables) {
			const rows = await promisifyQuery(this.db, `SELECT COUNT(*) as cnt FROM ${t}`);
			result[t] = rows[0]?.cnt ?? 0;
		}
		return result;
	}

	// ─── Calendar Events ────────────────────────────────────────────

	async saveCalendarEvents(events: CalendarEventRow[]): Promise<void> {
		if (events.length === 0 || !this.db) return;
		const now = new Date().toISOString();

		// Build a set of existing keys to avoid duplicates
		const codeList = events.filter((e) => e.code).map((e) => s(e.code));
		const existingKeys = new Set<string>();
		if (codeList.length > 0) {
			const dateList = [...new Set(events.map((e) => s(e.event_date)))].join(",");
			const rows = await promisifyQuery(
				this.db,
				`SELECT event_date, title, code FROM calendar_events WHERE event_date IN (${dateList})`,
			);
			for (const r of rows) {
				existingKeys.add(`${r.event_date}|${r.title}|${r.code ?? ""}`);
			}
		}

		for (const ev of events) {
			const key = `${ev.event_date}|${ev.title}|${ev.code ?? ""}`;
			if (existingKeys.has(key)) continue;
			existingKeys.add(key);

			const sectors = ev.affected_sectors ? JSON.stringify(ev.affected_sectors) : null;
			const sql = `
				INSERT INTO calendar_events
				(event_date, title, category, description, code, market, affected_sectors, importance, source, updated_at)
				VALUES (${s(ev.event_date)}, ${s(ev.title)}, ${s(ev.category)}, ${s(ev.description)},
					${s(ev.code)}, ${ev.market ?? "NULL"}, ${sectors ? s(sectors) : "NULL"},
					${s(ev.importance ?? "medium")}, ${s(ev.source)}, ${s(now)})
			`;
			try {
				await promisifyExec(this.db, sql);
			} catch (err) {
				// Ignore unique constraint violations
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("UNIQUE constraint failed")) {
					console.warn("[saveCalendarEvents] Insert failed:", msg);
				}
			}
		}
	}

	async getCalendarEvents(startDate: string, endDate: string, code?: string): Promise<CalendarEventRow[]> {
		if (!this.db) return [];
		let sql = `SELECT * FROM calendar_events WHERE event_date >= ${s(startDate)} AND event_date <= ${s(endDate)}`;
		if (code) {
			sql += ` AND (code = ${s(code)} OR code IS NULL)`;
		}
		sql += ` ORDER BY event_date, importance DESC`;
		const rows = await promisifyQuery(this.db, sql);
		return rows.map((r) => ({
			...r,
			affected_sectors: r.affected_sectors ? JSON.parse(r.affected_sectors) : null,
		})) as CalendarEventRow[];
	}

	async deleteCalendarEventsByCategory(category: string, startDate?: string): Promise<void> {
		if (!this.db) return;
		let sql = `DELETE FROM calendar_events WHERE category = ${s(category)}`;
		if (startDate) {
			sql += ` AND event_date >= ${s(startDate)}`;
		}
		await promisifyExec(this.db, sql);
	}

	async deleteCalendarEventsInRange(startDate: string, endDate: string): Promise<void> {
		if (!this.db) return;
		const sql = `DELETE FROM calendar_events WHERE event_date >= ${s(startDate)} AND event_date <= ${s(endDate)}`;
		await promisifyExec(this.db, sql);
	}

	// ─── Stock Pools ────────────────────────────────────────────────

	async createStockPool(name: string, description?: string, isDynamic = false): Promise<number> {
		if (!this.db) throw new Error("DataStore not initialized");
		const now = new Date().toISOString();
		const sql = `INSERT INTO stock_pools (name, description, is_dynamic, created_at, updated_at) VALUES (${s(name)}, ${s(description) ?? "NULL"}, ${isDynamic ? 1 : 0}, ${s(now)}, ${s(now)})`;
		await promisifyExec(this.db, sql);
		const rows = await promisifyQuery(this.db, `SELECT id FROM stock_pools WHERE name = ${s(name)}`);
		return rows[0]?.id;
	}

	async deleteStockPool(id: number): Promise<void> {
		if (!this.db) return;
		await promisifyExec(this.db, `DELETE FROM stock_pools WHERE id = ${id}`);
	}

	async renameStockPool(id: number, newName: string): Promise<void> {
		if (!this.db) return;
		const now = new Date().toISOString();
		await promisifyExec(
			this.db,
			`UPDATE stock_pools SET name = ${s(newName)}, updated_at = ${s(now)} WHERE id = ${id}`,
		);
	}

	async getStockPools(): Promise<
		Array<{ id: number; name: string; description: string | null; item_count: number; created_at: string }>
	> {
		if (!this.db) return [];
		const sql = `
			SELECT p.id, p.name, p.description, p.created_at, COUNT(i.code) as item_count
			FROM stock_pools p
			LEFT JOIN stock_pool_items i ON p.id = i.pool_id
			GROUP BY p.id
			ORDER BY p.updated_at DESC
		`;
		return promisifyQuery(this.db, sql);
	}

	async getStockPoolByName(
		name: string,
	): Promise<{ id: number; name: string; description: string | null; created_at: string } | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT id, name, description, created_at FROM stock_pools WHERE name = ${s(name)}`,
		);
		return rows[0] ?? null;
	}

	async getStockPoolById(
		id: number,
	): Promise<{ id: number; name: string; description: string | null; created_at: string } | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT id, name, description, created_at FROM stock_pools WHERE id = ${id}`,
		);
		return rows[0] ?? null;
	}

	async addToStockPool(poolId: number, items: Array<{ code: string; market: number; name?: string }>): Promise<void> {
		if (!this.db || items.length === 0) return;
		const now = new Date().toISOString();
		const values = items
			.map((item) => `(${poolId}, ${s(item.code)}, ${item.market}, ${s(item.name) ?? "NULL"}, ${s(now)})`)
			.join(",");
		const sql = `INSERT OR IGNORE INTO stock_pool_items (pool_id, code, market, name, added_at) VALUES ${values}`;
		await promisifyExec(this.db, sql);
	}

	async removeFromStockPool(poolId: number, code: string, market: number): Promise<void> {
		if (!this.db) return;
		await promisifyExec(
			this.db,
			`DELETE FROM stock_pool_items WHERE pool_id = ${poolId} AND code = ${s(code)} AND market = ${market}`,
		);
	}

	async getStockPoolItems(
		poolId: number,
	): Promise<Array<{ code: string; market: number; name: string | null; added_at: string }>> {
		if (!this.db) return [];
		return promisifyQuery(
			this.db,
			`SELECT code, market, name, added_at FROM stock_pool_items WHERE pool_id = ${poolId} ORDER BY added_at`,
		);
	}

	async clearStockPool(poolId: number): Promise<void> {
		if (!this.db) return;
		await promisifyExec(this.db, `DELETE FROM stock_pool_items WHERE pool_id = ${poolId}`);
	}

	async markStockPoolDynamic(poolId: number, dynamic: boolean): Promise<void> {
		if (!this.db) return;
		await promisifyExec(this.db, `UPDATE stock_pools SET is_dynamic = ${dynamic ? 1 : 0} WHERE id = ${poolId}`);
	}

	async setDynamicPoolItems(
		poolId: number,
		date: string,
		items: Array<{ code: string; market: number; name?: string; weight?: number }>,
	): Promise<void> {
		if (!this.db || items.length === 0) return;
		const now = new Date().toISOString();
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const values = items
			.map(
				(item) =>
					`(${poolId}, ${s(date)}, ${s(item.code)}, ${item.market}, ${s(item.name) ?? "NULL"}, ${f(item.weight)}, ${s(now)})`,
			)
			.join(",");
		await promisifyExec(
			this.db,
			`INSERT OR REPLACE INTO dynamic_pool_items (pool_id, date, code, market, name, weight, created_at) VALUES ${values}`,
		);
	}

	async getDynamicPoolItems(
		poolId: number,
		date: string,
	): Promise<Array<{ code: string; market: number; name: string | null; weight: number | null }>> {
		if (!this.db) return [];
		return promisifyQuery(
			this.db,
			`SELECT code, market, name, weight FROM dynamic_pool_items WHERE pool_id = ${poolId} AND date = ${s(date)} ORDER BY code`,
		);
	}

	async getDynamicPoolDates(poolId: number): Promise<string[]> {
		if (!this.db) return [];
		const rows = await promisifyQuery(
			this.db,
			`SELECT DISTINCT date FROM dynamic_pool_items WHERE pool_id = ${poolId} ORDER BY date`,
		);
		return rows.map((r) => r.date as string);
	}

	async getDynamicPoolItemsInRange(
		poolId: number,
		startDate: string,
		endDate: string,
	): Promise<Map<string, Array<{ code: string; market: number; name?: string; weight?: number }>>> {
		if (!this.db) return new Map();
		const rows = (await promisifyQuery(
			this.db,
			`SELECT date, code, market, name, weight FROM dynamic_pool_items WHERE pool_id = ${poolId} AND date >= ${s(startDate)} AND date <= ${s(endDate)} ORDER BY date, code`,
		)) as DynamicPoolItemRow[];
		const map = new Map<string, Array<{ code: string; market: number; name?: string; weight?: number }>>();
		for (const r of rows) {
			const list = map.get(r.date) ?? [];
			list.push({ code: r.code, market: r.market, name: r.name ?? undefined, weight: r.weight ?? undefined });
			map.set(r.date, list);
		}
		return map;
	}

	async clearDynamicPoolDate(poolId: number, date: string): Promise<void> {
		if (!this.db) return;
		await promisifyExec(this.db, `DELETE FROM dynamic_pool_items WHERE pool_id = ${poolId} AND date = ${s(date)}`);
	}

	// ─── Portfolios ─────────────────────────────────────────────────

	async createPortfolio(name: string, initialCash: number, description?: string): Promise<number> {
		if (!this.db) throw new Error("DataStore not initialized");
		const now = new Date().toISOString();
		const sql = `INSERT INTO portfolios (name, description, initial_cash, created_at, updated_at) VALUES (${s(name)}, ${s(description) ?? "NULL"}, ${initialCash}, ${s(now)}, ${s(now)})`;
		await promisifyExec(this.db, sql);
		const rows = await promisifyQuery(this.db, `SELECT last_insert_rowid() as id`);
		return rows[0]?.id;
	}

	async deletePortfolio(id: number): Promise<void> {
		if (!this.db) return;
		await promisifyExec(this.db, `DELETE FROM portfolios WHERE id = ${id}`);
	}

	async getPortfolios(): Promise<PortfolioRow[]> {
		if (!this.db) return [];
		return promisifyQuery(
			this.db,
			`SELECT id, name, description, initial_cash, created_at, updated_at FROM portfolios ORDER BY updated_at DESC`,
		);
	}

	async getPortfolioById(id: number): Promise<PortfolioRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT id, name, description, initial_cash, created_at, updated_at FROM portfolios WHERE id = ${id}`,
		);
		return rows[0] ?? null;
	}

	async getPortfolioByName(name: string): Promise<PortfolioRow | null> {
		if (!this.db) return null;
		const rows = await promisifyQuery(
			this.db,
			`SELECT id, name, description, initial_cash, created_at, updated_at FROM portfolios WHERE name = ${s(name)}`,
		);
		return rows[0] ?? null;
	}

	async addPortfolioTrade(trade: Omit<PortfolioTradeRow, "id" | "created_at">): Promise<number> {
		if (!this.db) throw new Error("DataStore not initialized");
		const now = new Date().toISOString();
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
		const sql = `INSERT INTO portfolio_trades
			(portfolio_id, trade_date, code, market, direction, quantity, price, adjust, commission, tax, memo, created_at)
			VALUES (${trade.portfolio_id}, ${s(trade.trade_date)}, ${s(trade.code)}, ${trade.market}, ${s(trade.direction)}, ${trade.quantity}, ${trade.price}, ${s(trade.adjust ?? "bfq")}, ${f(trade.commission)}, ${f(trade.tax)}, ${s(trade.memo) ?? "NULL"}, ${s(now)})`;
		await promisifyExec(this.db, sql);
		const rows = await promisifyQuery(
			this.db,
			`SELECT id FROM portfolio_trades WHERE portfolio_id = ${trade.portfolio_id} AND trade_date = ${s(trade.trade_date)} AND code = ${s(trade.code)} ORDER BY id DESC LIMIT 1`,
		);
		return rows[0]?.id;
	}

	async getPortfolioTrades(portfolioId: number, startDate?: string, endDate?: string): Promise<PortfolioTradeRow[]> {
		if (!this.db) return [];
		let sql = `SELECT id, portfolio_id, trade_date, code, market, direction, quantity, price, adjust, commission, tax, memo, created_at FROM portfolio_trades WHERE portfolio_id = ${portfolioId}`;
		if (startDate) sql += ` AND trade_date >= ${s(startDate)}`;
		if (endDate) sql += ` AND trade_date <= ${s(endDate)}`;
		sql += ` ORDER BY trade_date, id`;
		return promisifyQuery(this.db, sql);
	}

	async deletePortfolioTrade(tradeId: number): Promise<void> {
		if (!this.db) return;
		await promisifyExec(this.db, `DELETE FROM portfolio_trades WHERE id = ${tradeId}`);
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
			this.initialized = false;
		}
	}
}

export function createDataStore(dataDir: string): DataStore {
	return new DataStore(join(dataDir, "market.db"));
}
