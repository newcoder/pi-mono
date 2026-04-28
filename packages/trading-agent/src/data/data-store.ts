import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import sqlite3 from "sqlite3";
import type {
	AdjustFactorRow,
	ConceptStockRow,
	FundamentalsRow,
	IndustryRow,
	KlineFilter,
	KlineRow,
	MacroRow,
	QuoteRow,
	SectorRow,
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

		await promisifyExec(this.db, SCHEMA_SQL);
		this.initialized = true;
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
		let sql = `SELECT * FROM klines WHERE code = ${s(filter.code)}`;
		if (filter.market != null) sql += ` AND market = ${filter.market}`;
		if (filter.period) sql += ` AND period = ${s(filter.period)}`;
		if (filter.adjust) sql += ` AND adjust = ${s(filter.adjust)}`;
		if (filter.start) sql += ` AND date >= ${s(filter.start)}`;
		if (filter.end) sql += ` AND date <= ${s(filter.end)}`;
		sql += ` ORDER BY date`;
		if (filter.limit) sql += ` LIMIT ${filter.limit}`;
		return promisifyQuery(this.db, sql);
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
		const f = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v));
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

	async getLatestQuotes(codes?: string[]): Promise<QuoteRow[]> {
		if (!this.db) return [];
		if (codes && codes.length > 0) {
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
		let sql = `SELECT * FROM industries WHERE name LIKE '%' || ${s(name).slice(1, -1)} || '%'`;
		if (standard) sql += ` AND standard = ${s(standard)}`;
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
			"sectors",
			"concept_stocks",
			"macro",
			"stock_pools",
			"stock_pool_items",
		];
		const result: Record<string, number> = {};
		for (const t of tables) {
			const rows = await promisifyQuery(this.db, `SELECT COUNT(*) as cnt FROM ${t}`);
			result[t] = rows[0]?.cnt ?? 0;
		}
		return result;
	}

	// ─── Stock Pools ────────────────────────────────────────────────

	async createStockPool(name: string, description?: string): Promise<number> {
		if (!this.db) throw new Error("DataStore not initialized");
		const now = new Date().toISOString();
		const sql = `INSERT INTO stock_pools (name, description, created_at, updated_at) VALUES (${s(name)}, ${s(description) ?? "NULL"}, ${s(now)}, ${s(now)})`;
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
