import argparse
import json
import sys
import io
import logging

import pandas as pd

logger = logging.getLogger(__name__)

AK_ADJUST_MAP = {
    "bfq": "",
    "qfq": "qfq",
    "hfq": "hfq",
}

# Map our period names to akshare period names
AK_PERIOD_MAP = {
    "daily": "daily",
    "week": "weekly",
    "month": "monthly",
    "quarter": "quarterly",
    "year": "yearly",
}

PERIOD_CHOICES = ["1m", "5m", "15m", "30m", "60m", "120m", "daily", "week", "month", "quarter", "year"]
ADJUST_CHOICES = ["bfq", "qfq", "hfq"]


def get_stock_kline(
    stock_code: str,
    market: int = 1,
    period: str = "daily",
    adjust: str = "bfq",
    start_date: str = "19700101",
    end_date: str = "20500101",
) -> dict:
    """
    Fetch K-line (OHLCV) data.
    Priority: mootdx (TCP direct) for bfq -> akshare for qfq/hfq or fallback.
    No JoinQuant dependency.

    - period: 1m,5m,15m,30m,60m,120m,daily,week,month,quarter,year
    - adjust: bfq (不复权), qfq (前复权), hfq (后复权)
    - start_date / end_date: YYYYMMDD
    """
    # 1. Primary: mootdx for bfq (TCP direct, ~77ms for daily)
    if adjust == "bfq":
        try:
            from mootdx_data import get_kline as mootdx_kline
            klines = mootdx_kline(
                stock_code, market, period=period,
                start=start_date, end=end_date
            )
            if klines:
                return {
                    "code": stock_code,
                    "market": "SH" if market == 1 else "SZ",
                    "period": period,
                    "adjust": adjust,
                    "start_date": start_date,
                    "end_date": end_date,
                    "count": len(klines),
                    "klines": klines,
                    "factors": [],
                    "_source": "mootdx",
                }
        except Exception:
            logger.warning(f"mootdx kline fetch failed for {stock_code}", exc_info=True)
            pass  # fallback to akshare

    # 2. Fallback: akshare (supports qfq/hfq via stock_zh_a_hist)
    try:
        import akshare as ak
        ak_start = f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}" if len(start_date) == 8 else start_date
        ak_end = f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:8]}" if len(end_date) == 8 else end_date
        ak_adjust = AK_ADJUST_MAP.get(adjust, "")
        ak_period = AK_PERIOD_MAP.get(period, "daily")
        df = ak.stock_zh_a_hist(symbol=stock_code, period=ak_period, start_date=ak_start, end_date=ak_end, adjust=ak_adjust)
        if df is not None and not df.empty:
            klines = []
            for _, row in df.iterrows():
                dt = str(row.get("日期", ""))
                open_p = float(row["开盘"]) if pd.notna(row.get("开盘")) else None
                close_p = float(row["收盘"]) if pd.notna(row.get("收盘")) else None
                low_p = float(row["最低"]) if pd.notna(row.get("最低")) else None
                high_p = float(row["最高"]) if pd.notna(row.get("最高")) else None
                volume = float(row["成交量"]) if pd.notna(row.get("成交量")) else None
                money = float(row["成交额"]) if pd.notna(row.get("成交额")) else None
                change_pct = float(row["涨跌幅"]) if pd.notna(row.get("涨跌幅")) else None
                change_amount = float(row["涨跌额"]) if pd.notna(row.get("涨跌额")) else None
                amplitude = float(row["振幅"]) if pd.notna(row.get("振幅")) else None
                klines.append({
                    "date": dt, "open": open_p, "close": close_p, "low": low_p, "high": high_p,
                    "volume": volume, "amount": money, "amplitude": amplitude,
                    "change_pct": change_pct, "change_amount": change_amount,
                    "turnover": None, "pre_close": None,
                })
            return {
                "code": stock_code, "market": "SH" if market == 1 else "SZ",
                "period": period, "adjust": adjust,
                "start_date": start_date, "end_date": end_date,
                "count": len(klines), "klines": klines, "factors": [],
                "_source": "akshare",
            }
    except Exception as e:
        logger.warning(f"akshare kline fetch failed for {stock_code}: {e}", exc_info=True)
        pass  # all sources failed

    return {
        "code": stock_code, "market": "SH" if market == 1 else "SZ",
        "period": period, "adjust": adjust,
        "start_date": start_date, "end_date": end_date,
        "count": 0, "klines": [], "factors": [],
        "error": "All data sources failed (mootdx/akshare)",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch A-share K-line data (mootdx/akshare, no JoinQuant)")
    parser.add_argument("stock_code", help="6-digit stock code, e.g. 600845")
    parser.add_argument("--market", type=int, default=1, choices=[0, 1], help="1=Shanghai (default), 0=Shenzhen")
    parser.add_argument("--period", default="daily", choices=PERIOD_CHOICES, help="K-line period")
    parser.add_argument("--adjust", default="bfq", choices=ADJUST_CHOICES, help="Adjustment type")
    parser.add_argument("--start", default="19700101", help="Start date YYYYMMDD")
    parser.add_argument("--end", default="20500101", help="End date YYYYMMDD")
    args = parser.parse_args()

    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except ValueError:
        pass
    result = get_stock_kline(
        args.stock_code,
        market=args.market,
        period=args.period,
        adjust=args.adjust,
        start_date=args.start,
        end_date=args.end,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
