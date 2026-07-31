#!/usr/bin/env python3
"""
Fundamental Indicators Calculator
=================================
Reads from `fundamentals` table, computes indicators defined in
`fundamental_analysis_framework.json`, and writes to `fundamental_indicators`.

Supports:
  --all           Recalc all stocks (full)
  --code CODE     Recalc single stock (incremental)
  --since DATE    Only process report_dates >= YYYY-MM-DD

Integration:
  Called by daily_sync.py after fundamentals phase completes.
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import argparse
import json
import sqlite3
from local_data.db import get_db, get_db_path, db_exists
from local_data.schema import ensure_tables
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional, Tuple

def _safe_div(numerator, denominator):
    """Safe division: returns None if either operand is None or denominator is 0."""
    if numerator is None or denominator is None:
        return None
    try:
        d = float(denominator)
        if abs(d) < 1e-12:
            return None
        return float(numerator) / d
    except (ValueError, TypeError):
        return None


def _pct_change(current, previous):
    """Compute percentage change: (current - previous) / abs(previous) * 100."""
    if current is None or previous is None:
        return None
    try:
        p = float(previous)
        if abs(p) < 1e-12:
            return None
        return (float(current) - p) / abs(p) * 100
    except (ValueError, TypeError):
        return None


def _cagr(current, base, years):
    """Compute CAGR: (current/base)^(1/years) - 1."""
    if current is None or base is None or years is None or years <= 0:
        return None
    try:
        b = float(base)
        if abs(b) < 1e-12 or b < 0:
            return None
        c = float(current)
        if c < 0:
            return None
        return (c / b) ** (1.0 / years) - 1
    except (ValueError, TypeError):
        return None


def load_fundamentals(conn: sqlite3.Connection, code: Optional[str] = None,
                      since: Optional[str] = None) -> List[sqlite3.Row]:
    """Load fundamentals rows ordered by code, report_date."""
    sql = """
        SELECT code, market, report_date, report_type,
               total_revenue, operate_revenue, operate_cost, total_operate_cost,
               operate_profit, total_profit, net_profit, parent_net_profit,
               eps, diluted_eps, research_expense, sale_expense, manage_expense,
               finance_expense, interest_expense, income_tax,
               total_assets, total_liabilities, total_equity, parent_equity,
               total_current_assets, total_current_liab, inventory,
               accounts_rece, fixed_asset, short_loan, long_loan,
               total_noncurrent_liab, monetary_funds,
               operate_cash_flow, invest_cash_flow, finance_cash_flow,
               net_cash_increase, construct_long_asset,
               credit_impairment, asset_impairment,
               non_operate_income, non_operate_expense,
               operate_tax_add, total_shares
        FROM fundamentals
    """
    params = []
    conditions = []
    if code:
        conditions.append("code = ?")
        params.append(code)
    if since:
        conditions.append("report_date >= ?")
        params.append(since)
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY code, report_date"
    return conn.execute(sql, params).fetchall()


def group_by_stock(rows: List[sqlite3.Row]) -> Dict[Tuple[str, int], List[sqlite3.Row]]:
    """Group fundamentals rows by (code, market)."""
    groups = defaultdict(list)
    for row in rows:
        groups[(row["code"], row["market"])].append(row)
    return groups


def find_period(rows: List[sqlite3.Row], report_date: str, years_ago: int) -> Optional[sqlite3.Row]:
    """Find the row with same month-day as report_date but N years earlier."""
    target_year = int(report_date[:4]) - years_ago
    target = f"{target_year}{report_date[4:]}"
    for r in rows:
        if r["report_date"] == target:
            return r
    return None


def find_prev_period(rows: List[sqlite3.Row], idx: int) -> Optional[sqlite3.Row]:
    """Find the immediately preceding report period."""
    if idx > 0:
        return rows[idx - 1]
    return None


def calc_indicators_for_stock(rows: List[sqlite3.Row]) -> List[Dict]:
    """Compute indicators for all report periods of a single stock."""
    results = []
    for i, row in enumerate(rows):
        code = row["code"]
        market = row["market"]
        report_date = row["report_date"]

        # Raw values
        total_revenue = row["total_revenue"]
        net_profit = row["net_profit"]
        parent_net_profit = row["parent_net_profit"]
        operate_cash_flow = row["operate_cash_flow"]
        research_expense = row["research_expense"]
        construct_long_asset = row["construct_long_asset"]
        total_assets = row["total_assets"]
        total_liabilities = row["total_liabilities"]
        total_equity = row["total_equity"]
        parent_equity = row["parent_equity"]
        total_current_assets = row["total_current_assets"]
        total_current_liab = row["total_current_liab"]
        inventory = row["inventory"]
        short_loan = row["short_loan"]
        long_loan = row["long_loan"]
        monetary_funds = row["monetary_funds"]
        interest_expense = row["interest_expense"]
        total_profit = row["total_profit"]

        # Use parent_equity if available, fallback to total_equity
        equity_for_roe = parent_equity if parent_equity is not None else total_equity
        profit_for_roe = parent_net_profit if parent_net_profit is not None else net_profit

        # -- Previous period for QoQ --
        prev_row = find_prev_period(rows, i)

        # -- Same period last year for YoY --
        yoy_row = find_period(rows, report_date, 1)

        # -- Same period N years ago for CAGR --
        cagr3_row = find_period(rows, report_date, 3)
        cagr5_row = find_period(rows, report_date, 5)

        # ── Growth ──────────────────────────────────────────────
        revenue_yoy = _pct_change(total_revenue, yoy_row["total_revenue"]) if yoy_row else None
        revenue_qoq = _pct_change(total_revenue, prev_row["total_revenue"]) if prev_row else None
        revenue_cagr_3y = _cagr(total_revenue, cagr3_row["total_revenue"], 3) if cagr3_row else None
        revenue_cagr_5y = _cagr(total_revenue, cagr5_row["total_revenue"], 5) if cagr5_row else None

        net_profit_yoy = _pct_change(net_profit, yoy_row["net_profit"]) if yoy_row else None
        net_profit_qoq = _pct_change(net_profit, prev_row["net_profit"]) if prev_row else None
        net_profit_cagr_3y = _cagr(net_profit, cagr3_row["net_profit"], 3) if cagr3_row else None
        net_profit_cagr_5y = _cagr(net_profit, cagr5_row["net_profit"], 5) if cagr5_row else None

        operate_cash_flow_yoy = _pct_change(operate_cash_flow, yoy_row["operate_cash_flow"]) if yoy_row else None
        operate_cash_flow_qoq = _pct_change(operate_cash_flow, prev_row["operate_cash_flow"]) if prev_row else None

        # FCF = 经营现金流 - 购建固定资产等支付的现金
        fcf = None
        if operate_cash_flow is not None and construct_long_asset is not None:
            fcf = operate_cash_flow - construct_long_asset

        fcf_yoy = None
        if fcf is not None and yoy_row:
            yoy_fcf = None
            yoy_ocf = yoy_row["operate_cash_flow"]
            yoy_capex = yoy_row["construct_long_asset"]
            if yoy_ocf is not None and yoy_capex is not None:
                yoy_fcf = yoy_ocf - yoy_capex
            if yoy_fcf is not None:
                fcf_yoy = _pct_change(fcf, yoy_fcf)

        # ROE = 净利润 / 净资产
        roe = _safe_div(profit_for_roe, equity_for_roe)
        roe_change = None
        if roe is not None and yoy_row:
            yoy_equity = yoy_row["parent_equity"] if yoy_row["parent_equity"] is not None else yoy_row["total_equity"]
            yoy_profit = yoy_row["parent_net_profit"] if yoy_row["parent_net_profit"] is not None else yoy_row["net_profit"]
            yoy_roe = _safe_div(yoy_profit, yoy_equity)
            if yoy_roe is not None:
                roe_change = roe - yoy_roe

        research_expense_yoy = _pct_change(research_expense, yoy_row["research_expense"]) if yoy_row else None
        research_expense_ratio = _safe_div(research_expense, total_revenue)

        capex = construct_long_asset
        capex_yoy = _pct_change(capex, yoy_row["construct_long_asset"]) if yoy_row else None
        capex_ratio = _safe_div(capex, total_revenue)

        # ── Financial Health ────────────────────────────────────
        debt_ratio = _safe_div(total_liabilities, total_assets)
        debt_ratio_change = None
        if debt_ratio is not None and yoy_row:
            yoy_debt_ratio = _safe_div(yoy_row["total_liabilities"], yoy_row["total_assets"])
            if yoy_debt_ratio is not None:
                debt_ratio_change = debt_ratio - yoy_debt_ratio

        current_ratio = _safe_div(total_current_assets, total_current_liab)

        quick_ratio = None
        if total_current_assets is not None and inventory is not None and total_current_liab is not None:
            quick_ratio = _safe_div(total_current_assets - inventory, total_current_liab)

        # 利息保障倍数 = (利润总额 + 利息费用) / 利息费用
        interest_coverage = None
        if total_profit is not None and interest_expense is not None:
            if interest_expense != 0:
                interest_coverage = (total_profit + interest_expense) / interest_expense

        cash_to_profit = _safe_div(operate_cash_flow, net_profit)

        # 货币资金 / 有息负债（短期借款+长期借款）
        cash_to_debt = None
        if monetary_funds is not None:
            interest_debt = 0
            has_debt = False
            if short_loan is not None:
                interest_debt += short_loan
                has_debt = True
            if long_loan is not None:
                interest_debt += long_loan
                has_debt = True
            if has_debt and interest_debt > 0:
                cash_to_debt = monetary_funds / interest_debt

        equity_ratio = _safe_div(total_equity, total_assets)

        # ── Risk Control ────────────────────────────────────────
        interest_bearing_debt_ratio = None
        if total_assets is not None and total_assets > 0:
            interest_debt = 0
            has_debt = False
            if short_loan is not None:
                interest_debt += short_loan
                has_debt = True
            if long_loan is not None:
                interest_debt += long_loan
                has_debt = True
            if has_debt:
                interest_bearing_debt_ratio = interest_debt / total_assets

        short_debt_ratio = None
        if short_loan is not None:
            total = 0
            has_long = False
            if long_loan is not None:
                total += long_loan
                has_long = True
            total += short_loan
            if total > 0:
                short_debt_ratio = short_loan / total

        results.append({
            "code": code,
            "market": market,
            "report_date": report_date,
            "revenue_yoy": revenue_yoy,
            "revenue_qoq": revenue_qoq,
            "revenue_cagr_3y": revenue_cagr_3y,
            "revenue_cagr_5y": revenue_cagr_5y,
            "net_profit_yoy": net_profit_yoy,
            "net_profit_qoq": net_profit_qoq,
            "net_profit_cagr_3y": net_profit_cagr_3y,
            "net_profit_cagr_5y": net_profit_cagr_5y,
            "operate_cash_flow_yoy": operate_cash_flow_yoy,
            "operate_cash_flow_qoq": operate_cash_flow_qoq,
            "fcf": fcf,
            "fcf_yoy": fcf_yoy,
            "roe": roe,
            "roe_change": roe_change,
            "research_expense_yoy": research_expense_yoy,
            "research_expense_ratio": research_expense_ratio,
            "capex": capex,
            "capex_yoy": capex_yoy,
            "capex_ratio": capex_ratio,
            "debt_ratio": debt_ratio,
            "debt_ratio_change": debt_ratio_change,
            "current_ratio": current_ratio,
            "quick_ratio": quick_ratio,
            "interest_coverage": interest_coverage,
            "cash_to_profit": cash_to_profit,
            "cash_to_debt": cash_to_debt,
            "equity_ratio": equity_ratio,
            "interest_bearing_debt_ratio": interest_bearing_debt_ratio,
            "short_debt_ratio": short_debt_ratio,
        })
    return results


def save_indicators(conn: sqlite3.Connection, indicators: List[Dict]):
    """Upsert indicator rows into fundamental_indicators table."""
    if not indicators:
        return 0

    now = datetime.now().isoformat()
    cols = list(indicators[0].keys()) + ["updated_at"]
    placeholders = ",".join(["?"] * len(cols))
    col_str = ",".join(cols)

    # Use INSERT OR REPLACE for upsert
    sql = f"""
        INSERT OR REPLACE INTO fundamental_indicators ({col_str})
        VALUES ({placeholders})
    """

    rows = []
    for ind in indicators:
        row = [ind.get(c) for c in cols[:-1]] + [now]
        rows.append(row)

    conn.executemany(sql, rows)
    conn.commit()
    return len(rows)


def calc_all(conn: sqlite3.Connection, since: Optional[str] = None,
             progress_interval: int = 50) -> Dict:
    """Recalc indicators for all stocks."""
    rows = load_fundamentals(conn, since=since)
    groups = group_by_stock(rows)
    total = len(groups)
    print(f"[calc_fundamental_indicators] Processing {total} stocks...", file=sys.stderr)

    total_inserted = 0
    for idx, ((code, market), stock_rows) in enumerate(sorted(groups.items()), 1):
        indicators = calc_indicators_for_stock(stock_rows)
        inserted = save_indicators(conn, indicators)
        total_inserted += inserted
        if idx % progress_interval == 0 or idx == total:
            print(f"  {idx}/{total} stocks done, {total_inserted} rows inserted",
                  file=sys.stderr)

    return {"total_stocks": total, "rows_inserted": total_inserted}


def calc_one(conn: sqlite3.Connection, code: str) -> Dict:
    """Recalc indicators for a single stock."""
    rows = load_fundamentals(conn, code=code)
    if not rows:
        return {"error": f"No fundamentals found for {code}"}
    indicators = calc_indicators_for_stock(rows)
    inserted = save_indicators(conn, indicators)
    return {"code": code, "periods": len(indicators), "rows_inserted": inserted}


def main():
    parser = argparse.ArgumentParser(description="Calculate fundamental indicators")
    parser.add_argument("--all", action="store_true", help="Recalc all stocks")
    parser.add_argument("--code", help="Recalc single stock")
    parser.add_argument("--since", help="Only process report_dates >= YYYY-MM-DD")
    parser.add_argument("--output", help="Output JSON file")
    args = parser.parse_args()

    conn = get_db()
    ensure_tables()

    if args.all:
        result = calc_all(conn, since=args.since)
    elif args.code:
        result = calc_one(conn, args.code)
    else:
        print("Error: specify --all or --code", file=sys.stderr)
        sys.exit(1)

    conn.close()

    result_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result_json)
        print(f"Result saved to: {args.output}", file=sys.stderr)
    else:
        print(result_json)


if __name__ == "__main__":
    main()
