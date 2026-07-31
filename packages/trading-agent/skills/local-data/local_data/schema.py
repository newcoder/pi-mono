"""Canonical SQLite schema for the local-data market database.

All table creation and lightweight migrations live here so that
`daily_sync.py` and standalone scripts can share the same DDL.
"""

from local_data.db import get_db


def ensure_tables() -> None:
    """Ensure all required tables exist."""
    conn = get_db()
    cur = conn.cursor()

    # stocks
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stocks (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            name TEXT,
            industry TEXT,
            list_date TEXT,
            updated_at TEXT,
            PRIMARY KEY (code, market)
        )
    """)

    # quotes
    cur.execute("""
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
        )
    """)

    # klines
    cur.execute("""
        CREATE TABLE IF NOT EXISTS klines (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            period TEXT NOT NULL,
            adjust TEXT NOT NULL,
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
        )
    """)

    # fundamentals
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fundamentals (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            report_date TEXT NOT NULL,
            report_type TEXT,
            total_revenue REAL,
            operate_revenue REAL,
            operate_cost REAL,
            total_operate_cost REAL,
            operate_profit REAL,
            total_profit REAL,
            net_profit REAL,
            parent_net_profit REAL,
            eps REAL,
            diluted_eps REAL,
            research_expense REAL,
            sale_expense REAL,
            manage_expense REAL,
            finance_expense REAL,
            interest_expense REAL,
            income_tax REAL,
            total_assets REAL,
            total_liabilities REAL,
            total_equity REAL,
            parent_equity REAL,
            total_current_assets REAL,
            total_current_liab REAL,
            inventory REAL,
            accounts_rece REAL,
            fixed_asset REAL,
            short_loan REAL,
            long_loan REAL,
            total_noncurrent_liab REAL,
            monetary_funds REAL,
            operate_cash_flow REAL,
            invest_cash_flow REAL,
            finance_cash_flow REAL,
            net_cash_increase REAL,
            construct_long_asset REAL,
            credit_impairment REAL,
            asset_impairment REAL,
            non_operate_income REAL,
            non_operate_expense REAL,
            operate_tax_add REAL,
            total_shares REAL,
            updated_at TEXT,
            PRIMARY KEY (code, market, report_date)
        )
    """)

    # Idempotent migration: add missing fundamentals columns to existing DBs
    _fundamentals_new_cols = {
        "report_type": "TEXT",
        "total_shares": "REAL",
        "credit_impairment": "REAL",
        "asset_impairment": "REAL",
        "non_operate_income": "REAL",
        "non_operate_expense": "REAL",
        "operate_tax_add": "REAL",
    }
    cur.execute("PRAGMA table_info(fundamentals)")
    existing_cols = {row["name"] for row in cur.fetchall()}
    for col_name, col_type in _fundamentals_new_cols.items():
        if col_name not in existing_cols:
            cur.execute(f"ALTER TABLE fundamentals ADD COLUMN {col_name} {col_type}")

    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_fundamentals_code
        ON fundamentals(code, report_date)
    """)

    # industries
    cur.execute("""
        CREATE TABLE IF NOT EXISTS industries (
            industry_code TEXT NOT NULL,
            name TEXT,
            standard TEXT NOT NULL,
            level INTEGER,
            parent_code TEXT,
            start_date TEXT,
            updated_at TEXT,
            PRIMARY KEY (industry_code, standard)
        )
    """)

    # stock_industries
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_industries (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            industry_code TEXT NOT NULL,
            standard TEXT NOT NULL,
            updated_at TEXT,
            PRIMARY KEY (code, market, industry_code, standard)
        )
    """)

    # concept_stocks
    cur.execute("""
        CREATE TABLE IF NOT EXISTS concept_stocks (
            concept TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT,
            updated_at TEXT,
            PRIMARY KEY (concept, code)
        )
    """)

    # index_klines (benchmark indices for concept independence filter)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS index_klines (
            code TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL,
            PRIMARY KEY (code, date)
        )
    """)

    # concept_synthetic_klines
    cur.execute("""
        CREATE TABLE IF NOT EXISTS concept_synthetic_klines (
            concept TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL,
            constituent_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (concept, date)
        )
    """)

    # concept_filter_results
    cur.execute("""
        CREATE TABLE IF NOT EXISTS concept_filter_results (
            concept TEXT PRIMARY KEY,
            constituent_count INTEGER,
            dispersion REAL,
            max_benchmark_correlation REAL,
            size_pass INTEGER,
            dispersion_pass INTEGER,
            independence_pass INTEGER,
            rank_score REAL,
            rank INTEGER,
            updated_at TEXT
        )
    """)

    # concept_indicators
    cur.execute("""
        CREATE TABLE IF NOT EXISTS concept_indicators (
            concept TEXT NOT NULL,
            date TEXT NOT NULL,
            period_days INTEGER NOT NULL,
            momentum_return REAL,
            momentum_rank INTEGER,
            has_momentum INTEGER,
            updated_at TEXT,
            PRIMARY KEY (concept, date, period_days)
        )
    """)

    # tracked_themes
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tracked_themes (
            concept TEXT NOT NULL,
            master_theme TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'tracked',
            notes TEXT,
            updated_at TEXT,
            PRIMARY KEY (concept)
        )
    """)

    # industry_indicators
    cur.execute("""
        CREATE TABLE IF NOT EXISTS industry_indicators (
            code TEXT NOT NULL,
            date TEXT NOT NULL,
            period_days INTEGER NOT NULL,
            momentum_return REAL,
            momentum_rank INTEGER,
            has_momentum INTEGER,
            updated_at TEXT,
            PRIMARY KEY (code, date, period_days)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_indicators_date
        ON industry_indicators(date, period_days)
    """)

    # factor_ic (generic factor effectiveness)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS factor_ic (
            date TEXT NOT NULL,
            factor_name TEXT NOT NULL,
            ic_value REAL,
            sample_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (date, factor_name)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_factor_ic_lookup
        ON factor_ic(factor_name, date)
    """)

    # industry_synthetic_klines
    cur.execute("""
        CREATE TABLE IF NOT EXISTS industry_synthetic_klines (
            code TEXT NOT NULL,
            standard TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL,
            constituent_count INTEGER,
            updated_at TEXT,
            PRIMARY KEY (code, standard, date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_synthetic_klines_lookup
        ON industry_synthetic_klines(code, standard, date)
    """)

    # hot_stocks: daily snapshot of Tonghuashun hot strong stocks with reason tags
    cur.execute("""
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
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_hot_stocks_date ON hot_stocks(date)
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_hot_stocks_reason ON hot_stocks(reason)
    """)

    # adjust_factors (qfq/hfq adjustment factors)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS adjust_factors (
            code TEXT NOT NULL,
            market INTEGER NOT NULL,
            date TEXT NOT NULL,
            qfq_factor REAL,
            hfq_factor REAL,
            updated_at TEXT,
            PRIMARY KEY (code, market, date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_adjust_factors_date
        ON adjust_factors(code, market, date)
    """)

    # fundamental_indicators (pre-computed growth / quality metrics)
    cur.execute("""
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
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_fi_code_date
        ON fundamental_indicators(code, report_date)
    """)

    # stock_indicators (pre-computed per-stock derived indicators)
    cur.execute("""
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
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_stock_indicators_lookup
        ON stock_indicators(code, market, date, indicator_name)
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_stock_indicators_name_date
        ON stock_indicators(indicator_name, date)
    """)

    # industry_indices (canonical industry index list)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS industry_indices (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            updated_at TEXT
        )
    """)

    # industry_klines (industry-level OHLCV)
    cur.execute("""
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
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_klines_code_period
        ON industry_klines(code, period, date)
    """)

    # industry_quotes (industry snapshot quotes)
    cur.execute("""
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
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_industry_quotes_date
        ON industry_quotes(snapshot_date)
    """)

    # stock_news
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT,
            source TEXT NOT NULL,
            source_type TEXT,
            pub_time TEXT NOT NULL,
            url TEXT,
            event_type TEXT,
            sentiment TEXT,
            impact_level TEXT
        )
    """)
    _stock_news_new_cols = {
        "content": "TEXT",
        "source_type": "TEXT",
    }
    cur.execute("PRAGMA table_info(stock_news)")
    _stock_news_existing_cols = {row["name"] for row in cur.fetchall()}
    for col_name, col_type in _stock_news_new_cols.items():
        if col_name not in _stock_news_existing_cols:
            cur.execute(f"ALTER TABLE stock_news ADD COLUMN {col_name} {col_type}")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_news_code_time ON stock_news(code, pub_time)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_news_event_type ON stock_news(event_type)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_news_sentiment ON stock_news(sentiment)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_news_pub_time ON stock_news(pub_time)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_news_source_type ON stock_news(source_type)")

    # market_news
    cur.execute("""
        CREATE TABLE IF NOT EXISTS market_news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT,
            source TEXT NOT NULL,
            source_type TEXT,
            pub_time TEXT,
            url TEXT,
            news_type TEXT,
            sentiment TEXT,
            impact_scope TEXT,
            affected_sectors TEXT
        )
    """)
    _market_news_new_cols = {
        "content": "TEXT",
        "source_type": "TEXT",
    }
    cur.execute("PRAGMA table_info(market_news)")
    _market_news_existing_cols = {row["name"] for row in cur.fetchall()}
    for col_name, col_type in _market_news_new_cols.items():
        if col_name not in _market_news_existing_cols:
            cur.execute(f"ALTER TABLE market_news ADD COLUMN {col_name} {col_type}")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mnews_type ON market_news(news_type)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mnews_sentiment ON market_news(sentiment)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mnews_time ON market_news(pub_time)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mnews_source_type ON market_news(source_type)")

    conn.commit()
    conn.close()
