export interface StockRow {
	code: string;
	name: string;
	market: number;
	industry?: string;
	concepts?: string[];
	list_date?: string;
	updated_at?: string;
}

export interface KlineRow {
	code: string;
	market: number;
	period: string;
	adjust: string;
	date: string;
	open: number | null;
	high: number | null;
	low: number | null;
	close: number | null;
	volume: number | null;
	turnover: number | null;
	change_pct: number | null;
	change_amount: number | null;
	amplitude: number | null;
	pre_close: number | null;
}

export interface QuoteRow {
	code: string;
	market: number;
	snapshot_date: string;
	name?: string;
	latest: number | null;
	open: number | null;
	high: number | null;
	low: number | null;
	prev_close: number | null;
	volume: number | null;
	turnover: number | null;
	change_pct: number | null;
	pe: number | null;
	pb: number | null;
	total_cap: number | null;
	float_cap: number | null;
	high_52w: number | null;
	low_52w: number | null;
	updated_at?: string;
}

export interface FundamentalsRow {
	code: string;
	market: number;
	report_date: string;
	report_type?: string;
	total_revenue?: number | null;
	operate_revenue?: number | null;
	operate_profit?: number | null;
	total_profit?: number | null;
	net_profit?: number | null;
	parent_net_profit?: number | null;
	eps?: number | null;
	total_assets?: number | null;
	total_liabilities?: number | null;
	total_equity?: number | null;
	parent_equity?: number | null;
	operate_cash_flow?: number | null;
	invest_cash_flow?: number | null;
	finance_cash_flow?: number | null;
	net_cash_increase?: number | null;
	// -- expanded fields for comprehensive analysis --
	operate_cost?: number | null;
	total_operate_cost?: number | null;
	diluted_eps?: number | null;
	research_expense?: number | null;
	sale_expense?: number | null;
	manage_expense?: number | null;
	finance_expense?: number | null;
	interest_expense?: number | null;
	income_tax?: number | null;
	total_current_assets?: number | null;
	total_current_liab?: number | null;
	inventory?: number | null;
	accounts_rece?: number | null;
	fixed_asset?: number | null;
	short_loan?: number | null;
	long_loan?: number | null;
	total_noncurrent_liab?: number | null;
	monetary_funds?: number | null;
	construct_long_asset?: number | null;
	credit_impairment?: number | null;
	asset_impairment?: number | null;
	non_operate_income?: number | null;
	non_operate_expense?: number | null;
	operate_tax_add?: number | null;
	total_shares?: number | null;
	updated_at?: string;
}

export interface SectorRow {
	name: string;
	change_pct?: number | null;
	leading_stock?: string | null;
	leading_stock_code?: string | null;
	leading_change_pct?: number | null;
	volume_ratio?: number | null;
	snapshot_date?: string | null;
	updated_at?: string;
}

export interface ConceptStockRow {
	concept: string;
	code: string;
	name?: string | null;
	updated_at?: string;
}

export interface IndustryRow {
	industry_code: string;
	name: string;
	standard: string;
	level?: number | null;
	parent_code?: string | null;
	start_date?: string | null;
	updated_at?: string;
}

export interface StockIndustryRow {
	code: string;
	market: number;
	industry_code: string;
	standard: string;
	updated_at?: string;
}

export interface MacroRow {
	snapshot_date: string;
	ndx_latest?: number | null;
	ndx_change_pct?: number | null;
	spx_latest?: number | null;
	spx_change_pct?: number | null;
	dji_latest?: number | null;
	dji_change_pct?: number | null;
	a50_latest?: number | null;
	a50_change_pct?: number | null;
	usdcnh_latest?: number | null;
	usdcnh_change_pct?: number | null;
	updated_at?: string;
}

export interface KlineFilter {
	code: string;
	market?: number;
	period?: string;
	adjust?: string;
	start?: string;
	end?: string;
	limit?: number;
}

export interface StockPoolRow {
	id?: number;
	name: string;
	description?: string;
	created_at?: string;
	updated_at?: string;
}

export interface StockPoolItemRow {
	pool_id: number;
	code: string;
	market: number;
	name?: string;
	added_at?: string;
}

export interface AdjustFactorRow {
	code: string;
	market: number;
	date: string;
	qfq_factor: number | null;
	hfq_factor: number | null;
	updated_at?: string;
}
