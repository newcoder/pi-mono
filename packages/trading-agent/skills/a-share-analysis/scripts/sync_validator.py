#!/usr/bin/env python3
"""
A-Share Analysis 数据库完整性验证模块
========================================
被 daily_sync.py 调用，也可独立运行验证当前数据库状态。
用法: python sync_validator.py [--output report.json]
"""

import argparse
import json
import os
import sqlite3
import sys
import io
from datetime import datetime, timedelta

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _is_trade_day(date_str: str) -> bool:
    """Heuristic: check if date is a weekday (not perfect but good enough for validation)."""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return dt.weekday() < 5  # Mon-Fri
    except ValueError:
        return False


def _latest_trade_date() -> str:
    """Return the most recent possible trade date."""
    dt = datetime.now()
    # If before market open (09:30), use previous day
    if dt.hour < 9 or (dt.hour == 9 and dt.minute < 30):
        dt = dt - timedelta(days=1)
    # Skip weekends
    while dt.weekday() >= 5:
        dt = dt - timedelta(days=1)
    return dt.strftime("%Y-%m-%d")


# ── Individual Validators ──────────────────────────────────────────────────

def validate_stocks() -> dict:
    """Validate stocks table."""
    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM stocks")
        count = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM stocks WHERE name IS NULL OR name = ''")
        missing_name = cur.fetchone()[0]

        cur.execute("SELECT COUNT(DISTINCT market) FROM stocks")
        markets = cur.fetchone()[0]

        status = "PASS"
        message = f"{count} stocks"
        if count < 4500:
            status = "FAIL"
            message = f"Too few stocks: {count} (expected 5000+)"
        elif missing_name > count * 0.1:
            status = "WARN"
            message = f"{missing_name} stocks missing names"

        return {
            "status": status,
            "count": count,
            "missing_name": missing_name,
            "markets": markets,
            "message": message,
        }
    finally:
        conn.close()


def validate_quotes() -> dict:
    """Validate quotes table has today's data."""
    conn = get_db()
    try:
        cur = conn.cursor()
        today = datetime.now().strftime("%Y-%m-%d")
        latest_trade = _latest_trade_date()

        cur.execute("SELECT COUNT(*) FROM quotes WHERE snapshot_date = ?", (today,))
        today_count = cur.fetchone()[0]

        cur.execute("SELECT COUNT(DISTINCT code) FROM quotes WHERE snapshot_date = ?", (today,))
        today_stocks = cur.fetchone()[0]

        # Also check latest available
        cur.execute("SELECT MAX(snapshot_date) FROM quotes")
        max_date_row = cur.fetchone()
        max_date = max_date_row[0] if max_date_row else None

        status = "PASS"
        message = f"{today_count} quotes for {today}, {today_stocks} distinct stocks"

        if today_count == 0 and max_date != today:
            # Maybe today is weekend/holiday, check latest trade date
            cur.execute("SELECT COUNT(*) FROM quotes WHERE snapshot_date = ?", (latest_trade,))
            trade_count = cur.fetchone()[0]
            if trade_count == 0:
                status = "FAIL"
                message = f"No quotes for {today} or latest trade day {latest_trade}"
            else:
                status = "WARN"
                message = f"No quotes for {today} (maybe holiday), but {trade_count} for {latest_trade}"
        elif today_count < 4000:
            status = "WARN"
            message = f"Only {today_count} quotes for {today}, expected 5000+"

        return {
            "status": status,
            "today_count": today_count,
            "today_stocks": today_stocks,
            "max_date": max_date,
            "message": message,
        }
    finally:
        conn.close()


def validate_klines() -> dict:
    """Validate klines table freshness and coverage."""
    conn = get_db()
    try:
        cur = conn.cursor()
        latest_trade = _latest_trade_date()

        # Latest date for daily bfq
        cur.execute(
            "SELECT MAX(date) FROM klines WHERE period = 'daily' AND adjust = 'bfq'"
        )
        max_date_row = cur.fetchone()
        max_date = max_date_row[0] if max_date_row else None

        # Count of distinct stocks with klines
        cur.execute(
            "SELECT COUNT(DISTINCT code) FROM klines WHERE period = 'daily' AND adjust = 'bfq'"
        )
        stock_count = cur.fetchone()[0]

        # Count of stocks with latest date
        if max_date:
            cur.execute(
                "SELECT COUNT(DISTINCT code) FROM klines WHERE period = 'daily' AND adjust = 'bfq' AND date = ?",
                (max_date,)
            )
            latest_stocks = cur.fetchone()[0]
        else:
            latest_stocks = 0

        # Total rows
        cur.execute(
            "SELECT COUNT(*) FROM klines WHERE period = 'daily' AND adjust = 'bfq'"
        )
        total_rows = cur.fetchone()[0]

        status = "PASS"
        message = f"{stock_count} stocks, latest date {max_date}, {latest_stocks} stocks up-to-date"

        if max_date is None:
            status = "FAIL"
            message = "No kline data found"
        elif max_date < latest_trade:
            status = "WARN"
            message = f"Klines stale: max date {max_date}, expected {latest_trade}"
        elif latest_stocks < 4000:
            status = "WARN"
            message = f"Only {latest_stocks} stocks have latest klines (expected 5000+)"

        return {
            "status": status,
            "max_date": max_date,
            "stock_count": stock_count,
            "latest_stocks": latest_stocks,
            "total_rows": total_rows,
            "message": message,
        }
    finally:
        conn.close()


def validate_fundamentals() -> dict:
    """Validate fundamentals table coverage and recency."""
    conn = get_db()
    try:
        cur = conn.cursor()

        cur.execute("SELECT COUNT(*) FROM fundamentals")
        total = cur.fetchone()[0]

        cur.execute("SELECT COUNT(DISTINCT code) FROM fundamentals")
        stock_count = cur.fetchone()[0]

        cur.execute("SELECT MAX(report_date) FROM fundamentals")
        max_date_row = cur.fetchone()
        max_date = max_date_row[0] if max_date_row else None

        # Count records for latest report date
        if max_date:
            cur.execute("SELECT COUNT(*) FROM fundamentals WHERE report_date = ?", (max_date,))
            latest_count = cur.fetchone()[0]
        else:
            latest_count = 0

        status = "PASS"
        message = f"{total} records for {stock_count} stocks, latest report {max_date}"

        if total == 0:
            status = "FAIL"
            message = "No fundamentals data"
        elif stock_count < 3000:
            status = "WARN"
            message = f"Only {stock_count} stocks have fundamentals (expected 4000+)"
        elif latest_count < 3000 and max_date:
            status = "WARN"
            message = f"Latest report {max_date} only has {latest_count} records (expected 4000+)"

        return {
            "status": status,
            "total_records": total,
            "stock_count": stock_count,
            "max_report_date": max_date,
            "latest_count": latest_count,
            "message": message,
        }
    finally:
        conn.close()


def validate_industries() -> dict:
    """Validate industry tables."""
    conn = get_db()
    try:
        cur = conn.cursor()

        cur.execute("SELECT COUNT(*) FROM industries")
        ind_count = cur.fetchone()[0]

        cur.execute("SELECT COUNT(DISTINCT standard) FROM industries")
        standards = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM stock_industries")
        mapping_count = cur.fetchone()[0]

        cur.execute("SELECT COUNT(DISTINCT code) FROM stock_industries")
        stock_count = cur.fetchone()[0]

        status = "PASS"
        message = f"{ind_count} industries ({standards} standards), {mapping_count} mappings for {stock_count} stocks"

        if ind_count == 0:
            status = "FAIL"
            message = "No industry data"
        elif standards < 3:
            status = "WARN"
            message = f"Only {standards} standards (expected 6)"
        elif stock_count < 4000:
            status = "WARN"
            message = f"Only {stock_count} stocks have industry mappings (expected 5000+)"

        return {
            "status": status,
            "industry_count": ind_count,
            "standards": standards,
            "mapping_count": mapping_count,
            "stock_count": stock_count,
            "message": message,
        }
    finally:
        conn.close()


def validate_concepts() -> dict:
    """Validate concept_stocks table."""
    conn = get_db()
    try:
        cur = conn.cursor()

        cur.execute("SELECT COUNT(DISTINCT concept) FROM concept_stocks")
        concept_count = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM concept_stocks")
        mapping_count = cur.fetchone()[0]

        cur.execute("SELECT COUNT(DISTINCT code) FROM concept_stocks")
        stock_count = cur.fetchone()[0]

        status = "PASS"
        message = f"{concept_count} concepts, {mapping_count} mappings for {stock_count} stocks"

        if concept_count == 0:
            status = "FAIL"
            message = "No concept data"
        elif concept_count < 100:
            status = "WARN"
            message = f"Only {concept_count} concepts (expected 200+)"

        return {
            "status": status,
            "concept_count": concept_count,
            "mapping_count": mapping_count,
            "stock_count": stock_count,
            "message": message,
        }
    finally:
        conn.close()


def validate_fundamental_indicators() -> dict:
    """Validate fundamental_indicators table."""
    conn = get_db()
    try:
        cur = conn.cursor()

        # Check if table exists
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='fundamental_indicators'"
        )
        if not cur.fetchone():
            return {
                "status": "WARN",
                "total_records": 0,
                "stock_count": 0,
                "max_report_date": None,
                "message": "fundamental_indicators table does not exist",
            }

        cur.execute("SELECT COUNT(*) FROM fundamental_indicators")
        total = cur.fetchone()[0]

        cur.execute("SELECT COUNT(DISTINCT code) FROM fundamental_indicators")
        stock_count = cur.fetchone()[0]

        cur.execute("SELECT MAX(report_date) FROM fundamental_indicators")
        max_date_row = cur.fetchone()
        max_date = max_date_row[0] if max_date_row else None

        # Compare with fundamentals latest date
        cur.execute("SELECT MAX(report_date) FROM fundamentals")
        fund_max_date = cur.fetchone()[0]

        status = "PASS"
        message = f"{total} records for {stock_count} stocks, latest report {max_date}"

        if total == 0:
            status = "WARN"
            message = "No fundamental indicators data"
        elif max_date != fund_max_date:
            status = "WARN"
            message = f"Indicators stale: max date {max_date}, fundamentals has {fund_max_date}"

        return {
            "status": status,
            "total_records": total,
            "stock_count": stock_count,
            "max_report_date": max_date,
            "message": message,
        }
    finally:
        conn.close()


def validate_news() -> dict:
    """Validate news tables."""
    conn = get_db()
    try:
        cur = conn.cursor()
        today = datetime.now().strftime("%Y-%m-%d")

        # Stock news
        cur.execute("SELECT COUNT(*) FROM stock_news WHERE pub_time >= ?", (today,))
        stock_news_today = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM stock_news")
        stock_news_total = cur.fetchone()[0]

        # Market news
        cur.execute("SELECT COUNT(*) FROM market_news WHERE pub_time >= ?", (today,))
        market_news_today = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM market_news")
        market_news_total = cur.fetchone()[0]

        status = "PASS"
        message = (
            f"stock_news: {stock_news_total} total ({stock_news_today} today), "
            f"market_news: {market_news_total} total ({market_news_today} today)"
        )

        # News is often optional; only warn if completely empty
        if stock_news_total == 0 and market_news_total == 0:
            status = "WARN"
            message = "No news data at all"

        return {
            "status": status,
            "stock_news_total": stock_news_total,
            "stock_news_today": stock_news_today,
            "market_news_total": market_news_total,
            "market_news_today": market_news_today,
            "message": message,
        }
    finally:
        conn.close()


# ── Aggregate Validator ────────────────────────────────────────────────────

def validate_all() -> dict:
    """Run all validations and return combined report."""
    if not os.path.exists(DB_PATH):
        return {"status": "FAIL", "message": f"Database not found: {DB_PATH}"}

    report = {
        "validation_time": datetime.now().isoformat(),
        "db_path": DB_PATH,
    }

    validators = [
        ("stocks", validate_stocks),
        ("quotes", validate_quotes),
        ("klines", validate_klines),
        ("fundamentals", validate_fundamentals),
        ("fundamental_indicators", validate_fundamental_indicators),
        ("industries", validate_industries),
        ("concepts", validate_concepts),
        ("news", validate_news),
    ]

    overall_status = "PASS"
    for name, validator in validators:
        try:
            result = validator()
            report[name] = result
            if result.get("status") == "FAIL":
                overall_status = "FAIL"
            elif result.get("status") == "WARN" and overall_status == "PASS":
                overall_status = "WARN"
        except Exception as e:
            report[name] = {"status": "FAIL", "message": str(e)}
            overall_status = "FAIL"

    report["overall_status"] = overall_status
    return report


def main():
    parser = argparse.ArgumentParser(description="Validate A-Share Analysis DB completeness")
    parser.add_argument("--output", help="Write JSON report to file")
    args = parser.parse_args()

    report = validate_all()
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2, default=str)
        print(f"\nReport saved to: {args.output}")

    # Exit code
    sys.exit(0 if report.get("overall_status") == "PASS" else 1)


if __name__ == "__main__":
    main()
