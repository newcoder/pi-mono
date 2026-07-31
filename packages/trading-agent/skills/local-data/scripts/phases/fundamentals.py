"""Auto-extracted from daily_sync.py."""

import logging
from datetime import datetime

from local_data.db import get_db
from local_data.market import market_prefix

from .base import _phase

logger = logging.getLogger('daily_sync')

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional
# ── Phase 4: Sync Fundamentals ─────────────────────────────────────────────

@_phase("fundamentals")
def sync_fundamentals() -> dict:
    """Sync latest quarterly fundamentals for all stocks from Eastmoney F10."""
    import requests
    from bs4 import BeautifulSoup

    conn = get_db()
    stocks = conn.execute("SELECT code, market FROM stocks ORDER BY code").fetchall()
    conn.close()

    total = len(stocks)
    logger.info(f"Syncing fundamentals for {total} stocks (this may take 30-60min)...")

    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://quote.eastmoney.com/",
    }

    def _market_prefix(code: str) -> str:
        return market_prefix(code, "lower") or "sz"

    def _get_company_type(symbol_lower: str) -> Optional[str]:
        try:
            url = "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index"
            r = requests.get(url, params={"type": "web", "code": symbol_lower},
                             headers=HEADERS, timeout=10)
            r.encoding = "utf-8"
            soup = BeautifulSoup(r.text, features="lxml")
            ctype_input = soup.find(attrs={"id": "hidctype"})
            if ctype_input and ctype_input.get("value"):
                return ctype_input["value"]
        except Exception:
            logger.warning(f"Failed to get company type for {symbol_lower}", exc_info=True)
        return None

    def _get_report_dates(endpoint: str, company_type: str, code: str) -> list:
        try:
            url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
            params = {"companyType": company_type, "reportDateType": "0", "code": code}
            r = requests.get(url, params=params, headers=HEADERS, timeout=10)
            data = r.json()
            if "data" in data and data["data"]:
                return [item["REPORT_DATE"] for item in data["data"] if "REPORT_DATE" in item]
        except Exception:
            logger.warning(f"Failed to get report dates for {code} via {endpoint}", exc_info=True)
        return []

    def _fetch_statement(endpoint: str, company_type: str, code: str, report_dates: list) -> list:
        try:
            url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
            all_records = []
            for i in range(0, len(report_dates), 5):
                chunk = report_dates[i:i + 5]
                params = {
                    "companyType": company_type,
                    "reportDateType": "0",
                    "reportType": "1",
                    "code": code,
                    "dates": ",".join(chunk),
                }
                r = requests.get(url, params=params, headers=HEADERS, timeout=15)
                data = r.json()
                all_records.extend(data.get("data", []))
            return all_records
        except Exception:
            logger.warning(f"Failed to fetch statement {endpoint} for {code}", exc_info=True)
            return []

    def _safe_float(v):
        if v is None or v == '' or v == '-':
            return None
        try:
            return float(v)
        except (ValueError, TypeError):
            return None

    statements_cfg = {
        "lrb": {
            "date_ep": "lrbDateAjaxNew",
            "data_ep": "lrbAjaxNew",
            "fields": {
                "TOTAL_OPERATE_INCOME": "total_revenue",
                "OPERATE_INCOME": "operate_revenue",
                "TOTAL_OPERATE_COST": "total_operate_cost",
                "OPERATE_COST": "operate_cost",
                "OPERATE_PROFIT": "operate_profit",
                "TOTAL_PROFIT": "total_profit",
                "NETPROFIT": "net_profit",
                "PARENT_NETPROFIT": "parent_net_profit",
                "BASIC_EPS": "eps",
                "DILUTED_EPS": "diluted_eps",
                "RESEARCH_EXPENSE": "research_expense",
                "SALE_EXPENSE": "sale_expense",
                "MANAGE_EXPENSE": "manage_expense",
                "FINANCE_EXPENSE": "finance_expense",
                "INTEREST_EXPENSE": "interest_expense",
                "INCOME_TAX": "income_tax",
            }
        },
        "zcfzb": {
            "date_ep": "zcfzbDateAjaxNew",
            "data_ep": "zcfzbAjaxNew",
            "fields": {
                "TOTAL_ASSETS": "total_assets",
                "TOTAL_LIABILITIES": "total_liabilities",
                "TOTAL_EQUITY": "total_equity",
                "PARENT_EQUITY": "parent_equity",
                "TOTAL_LIAB_EQUITY": "total_liab_equity",
                "TOTAL_CURRENT_ASSETS": "total_current_assets",
                "TOTAL_CURRENT_LIAB": "total_current_liab",
                "INVENTORY": "inventory",
                "ACCOUNTS_RECE": "accounts_rece",
                "FIXED_ASSET": "fixed_asset",
                "SHORT_LOAN": "short_loan",
                "LONG_LOAN": "long_loan",
                "TOTAL_NONCURRENT_LIAB": "total_noncurrent_liab",
                "MONETARYFUNDS": "monetary_funds",
            }
        },
        "xjllb": {
            "date_ep": "xjllbDateAjaxNew",
            "data_ep": "xjllbAjaxNew",
            "fields": {
                "NETCASH_OPERATE": "operate_cash_flow",
                "NETCASH_INVEST": "invest_cash_flow",
                "NETCASH_FINANCE": "finance_cash_flow",
                "CASH_EQU_INCREASE": "net_cash_increase",
                "CONSTRUCT_LONG_ASSET": "construct_long_asset",
            }
        },
    }

    def _report_type_from_date(report_date: str) -> Optional[str]:
        """Map a report date (YYYY-MM-DD) to the Chinese report type label."""
        if not report_date or len(report_date) < 10:
            return None
        month_day = report_date[5:10]
        return {
            "03-31": "一季报",
            "06-30": "半年报",
            "09-30": "三季报",
            "12-31": "年报",
        }.get(month_day)

    def _sync_one_stock(code: str, market: int) -> dict:
        prefix = _market_prefix(code)
        symbol_lower = f"{prefix}{code}"
        code_upper = f"{prefix.upper()}{code}"
        now = datetime.now().isoformat()

        company_type = _get_company_type(symbol_lower)
        if not company_type:
            return {"code": code, "status": "skip", "reason": "no_company_type"}

        # Get latest report dates for each statement
        report_dates_map = {}
        for key, cfg in statements_cfg.items():
            dates = _get_report_dates(cfg["date_ep"], company_type, code_upper)
            if dates:
                report_dates_map[key] = dates[:2]  # sync latest 2 periods

        if not report_dates_map:
            return {"code": code, "status": "skip", "reason": "no_report_dates"}

        records_map = {}
        for key, cfg in statements_cfg.items():
            if key not in report_dates_map:
                continue
            records = _fetch_statement(cfg["data_ep"], company_type, code_upper, report_dates_map[key])
            records_map[key] = records

        conn = get_db()
        inserted = 0
        for report_dates in report_dates_map.values():
            for rd in report_dates:
                rd_short = rd[:10]
                # Check if already exists
                existing = conn.execute(
                    "SELECT 1 FROM fundamentals WHERE code = ? AND market = ? AND report_date = ?",
                    (code, market, rd_short)
                ).fetchone()
                if existing:
                    continue

                # Build row data
                row_data = {
                    "code": code,
                    "market": market,
                    "report_date": rd_short,
                    "report_type": _report_type_from_date(rd_short),
                }
                for key, cfg in statements_cfg.items():
                    rec = None
                    for r in records_map.get(key, []):
                        if r.get("REPORT_DATE", "")[:10] == rd_short:
                            rec = r
                            break
                    if rec:
                        for api_key, db_col in cfg["fields"].items():
                            row_data[db_col] = _safe_float(rec.get(api_key))

                # Insert
                cols = list(row_data.keys()) + ["updated_at"]
                vals = list(row_data.values()) + [now]
                placeholders = ",".join(["?"] * len(vals))
                col_str = ",".join(cols)
                try:
                    conn.execute(
                        f"INSERT INTO fundamentals ({col_str}) VALUES ({placeholders})",
                        vals
                    )
                    inserted += 1
                except Exception as e:
                    logger.debug(f"  Insert failed for {code} {rd_short}: {e}")

        conn.commit()
        conn.close()
        return {"code": code, "status": "ok", "inserted": inserted}

    synced = 0
    failed = 0
    skipped = 0
    total_inserted = 0

    # Use ThreadPool for fundamentals (network I/O bound)
    max_workers = 8
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_sync_one_stock, s["code"], s["market"]): s for s in stocks}
        for idx, future in enumerate(as_completed(futures)):
            try:
                res = future.result(timeout=30)
                if res["status"] == "ok":
                    synced += 1
                    total_inserted += res.get("inserted", 0)
                elif res["status"] == "skip":
                    skipped += 1
                else:
                    failed += 1
            except Exception as e:
                failed += 1
                logger.debug(f"  Future error: {e}")

            if (idx + 1) % 200 == 0:
                logger.info(f"  Fundamentals progress: {idx+1}/{total} (ok={synced}, skip={skipped}, fail={failed}, inserted={total_inserted})")

    logger.info(f"Fundamentals done: {synced} ok, {skipped} skipped, {failed} failed, {total_inserted} records inserted.")
    return {"synced": synced, "skipped": skipped, "failed": failed, "inserted": total_inserted}
