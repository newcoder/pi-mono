import argparse
import json
import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}


def _create_session():
    """Create a requests session with retry logic for transient network failures."""
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=1.0,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


_SESSION = _create_session()


def _get_company_type(symbol_lower: str) -> str:
    url = "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index"
    params = {"type": "web", "code": symbol_lower}
    r = _SESSION.get(url, params=params, headers=HEADERS, timeout=30)
    r.encoding = "utf-8"
    soup = BeautifulSoup(r.text, features="lxml")
    ctype_input = soup.find(attrs={"id": "hidctype"})
    if ctype_input and ctype_input.get("value"):
        return ctype_input["value"]
    raise ValueError("Could not find companyType on Eastmoney F10 page.")


def _get_report_dates(endpoint: str, company_type: str, code: str) -> list:
    """Fetch all available report dates for a statement type."""
    url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
    params = {
        "companyType": company_type,
        "reportDateType": "0",
        "code": code,
    }
    r = _SESSION.get(url, params=params, headers=HEADERS, timeout=30)
    data = r.json()
    if "data" in data and data["data"]:
        return [item["REPORT_DATE"] for item in data["data"] if "REPORT_DATE" in item]
    return []


def _fetch_statement_batch(endpoint: str, company_type: str, code: str, report_dates: list, batch_size: int = 5) -> list:
    """Fetch multiple report periods in batches. API limits ~5 dates per request."""
    url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{endpoint}"
    all_records = []

    for i in range(0, len(report_dates), batch_size):
        chunk = report_dates[i:i + batch_size]
        params = {
            "companyType": company_type,
            "reportDateType": "0",
            "reportType": "1",
            "code": code,
            "dates": ",".join(chunk),
        }
        r = requests.get(url, params=params, headers=HEADERS, timeout=30)
        data = r.json()
        all_records.extend(data.get("data", []))

    return all_records


def _fmt(v):
    if v is None:
        return "-"
    if isinstance(v, (int, float)):
        return f"{v:,.2f}"
    return v


def get_stock_fundamentals(stock_code: str, market: int = 1, history: bool = False, limit: int = 0) -> dict:
    """
    Fetch fundamental data from Eastmoney F10.
    market: 1 = Shanghai, 0 = Shenzhen
    history: if True, fetch all available historical reports; if False, only the latest
    limit: max number of historical reports to fetch (0 = no limit)
    """
    prefix = "sh" if market == 1 else "sz"
    symbol_lower = f"{prefix}{stock_code}"
    code_upper = f"{prefix.upper()}{stock_code}"

    company_type = _get_company_type(symbol_lower)

    statements = {
        "利润表": {
            "date_ep": "lrbDateAjaxNew",
            "data_ep": "lrbAjaxNew",
            "fields": {
                "TOTAL_OPERATE_INCOME": "营业总收入",
                "OPERATE_INCOME": "营业收入",
                "TOTAL_OPERATE_COST": "营业总成本",
                "OPERATE_COST": "营业成本",
                "OPERATE_PROFIT": "营业利润",
                "TOTAL_PROFIT": "利润总额",
                "NETPROFIT": "净利润",
                "PARENT_NETPROFIT": "归母净利润",
                "BASIC_EPS": "基本每股收益",
                "DILUTED_EPS": "稀释每股收益",
                "RESEARCH_EXPENSE": "研发费用",
                "SALE_EXPENSE": "销售费用",
                "MANAGE_EXPENSE": "管理费用",
                "FINANCE_EXPENSE": "财务费用",
                "INTEREST_EXPENSE": "利息费用",
                "INCOME_TAX": "所得税费用",
                "CREDIT_IMPAIRMENT_INCOME": "信用减值损失",
                "ASSET_IMPAIRMENT_INCOME": "资产减值损失",
                "NONBUSINESS_INCOME": "营业外收入",
                "NONBUSINESS_EXPENSE": "营业外支出",
                "OPERATE_TAX_ADD": "营业税金及附加",
            },
        },
        "资产负债表": {
            "date_ep": "zcfzbDateAjaxNew",
            "data_ep": "zcfzbAjaxNew",
            "fields": {
                "TOTAL_ASSETS": "资产总计",
                "TOTAL_LIABILITIES": "负债合计",
                "TOTAL_EQUITY": "所有者权益合计",
                "PARENT_EQUITY": "归母所有者权益",
                "TOTAL_LIAB_EQUITY": "负债和所有者权益总计",
                "TOTAL_CURRENT_ASSETS": "流动资产合计",
                "TOTAL_CURRENT_LIAB": "流动负债合计",
                "INVENTORY": "存货",
                "ACCOUNTS_RECE": "应收账款",
                "FIXED_ASSET": "固定资产",
                "SHORT_LOAN": "短期借款",
                "LONG_LOAN": "长期借款",
                "TOTAL_NONCURRENT_LIAB": "非流动负债合计",
                "MONETARYFUNDS": "货币资金",
                "SHARE_CAPITAL": "总股本",
            },
        },
        "现金流量表": {
            "date_ep": "xjllbDateAjaxNew",
            "data_ep": "xjllbAjaxNew",
            "fields": {
                "SALES_SERVICES": "销售商品、提供劳务收到的现金",
                "NETCASH_OPERATE": "经营活动产生的现金流量净额",
                "NETCASH_INVEST": "投资活动产生的现金流量净额",
                "NETCASH_FINANCE": "筹资活动产生的现金流量净额",
                "CASH_EQU_INCREASE": "现金及现金等价物净增加额",
                "CONSTRUCT_LONG_ASSET": "购建固定资产、无形资产和其他长期资产支付的现金",
            },
        },
    }

    results = {
        "stock_code": stock_code,
        "market": "SH" if market == 1 else "SZ",
        "company_type": company_type,
    }

    # Step 1: Fetch report dates for all statements concurrently
    def fetch_dates(stmt_name, cfg):
        dates = _get_report_dates(cfg["date_ep"], company_type, code_upper)
        return stmt_name, dates

    date_results = {}
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fetch_dates, name, cfg): name for name, cfg in statements.items()}
        for future in as_completed(futures):
            stmt_name, dates = future.result()
            date_results[stmt_name] = dates

    # Step 2: Determine dates to fetch
    max_dates = 0
    for stmt_name, cfg in statements.items():
        report_dates = date_results.get(stmt_name, [])
        if not report_dates:
            results[stmt_name] = {"error": "No report dates found"}
            continue

        dates_to_fetch = report_dates if history else [report_dates[0]]
        if history and limit > 0:
            dates_to_fetch = dates_to_fetch[:limit]

        max_dates = max(max_dates, len(dates_to_fetch))
        cfg["_dates_to_fetch"] = dates_to_fetch

    # Step 3: Fetch all statement data in batch requests concurrently
    def fetch_data(stmt_name, cfg):
        dates = cfg.get("_dates_to_fetch", [])
        if not dates:
            return stmt_name, []
        records = _fetch_statement_batch(cfg["data_ep"], company_type, code_upper, dates)
        return stmt_name, records

    data_results = {}
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fetch_data, name, cfg): name for name, cfg in statements.items() if "_dates_to_fetch" in cfg}
        for future in as_completed(futures):
            stmt_name, records = future.result()
            data_results[stmt_name] = records

    # Step 4: Build report map keyed by report_date
    report_map = {}
    for stmt_name, cfg in statements.items():
        if stmt_name not in data_results:
            continue

        records = data_results[stmt_name]
        fields = cfg["fields"]

        for rec in records:
            report_date = rec.get("REPORT_DATE", "")[:10]
            if not report_date:
                continue

            if report_date not in report_map:
                report_map[report_date] = {}

            parsed = {}
            for key, label in fields.items():
                parsed[label] = _fmt(rec.get(key))

            report_map[report_date][stmt_name] = {
                "report_date": report_date,
                "data": parsed,
            }

    # Step 5: Assemble results
    for stmt_name in statements.keys():
        reports = []
        for report_date in cfg.get("_dates_to_fetch", []):
            if report_date[:10] in report_map and stmt_name in report_map[report_date[:10]]:
                reports.append(report_map[report_date[:10]][stmt_name])

        if history:
            results[stmt_name] = {
                "reports": reports,
                "count": len(reports),
            }
        else:
            results[stmt_name] = reports[0] if reports else {"error": "No data found"}

    return results


if __name__ == "__main__":
    import sys
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    parser = argparse.ArgumentParser(description="Fetch A-share fundamentals from Eastmoney")
    parser.add_argument("stock_code", help="6-digit stock code, e.g. 600875")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1], help="1=Shanghai (default), 0=Shenzhen")
    parser.add_argument("--history", action="store_true", help="Fetch all available historical reports")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of historical reports (0 = no limit)")
    args = parser.parse_args()

    result = get_stock_fundamentals(args.stock_code, market=args.market, history=args.history, limit=args.limit)
    print(json.dumps(result, ensure_ascii=False, indent=2))
