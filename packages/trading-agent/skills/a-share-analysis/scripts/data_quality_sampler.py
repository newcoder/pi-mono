#!/usr/bin/env python3
"""
数据质量随机抽样验证器
======================
随机抽取股票和日期，提取 K 线、行情、财务数据，生成报告供 LLM 审核。

用法:
  python data_quality_sampler.py [--stocks 5] [--dates 3] [--output report.json]

输出:
  1. JSON 格式的抽样数据报告
  2. 可直接复制给 LLM 的验证提示文本
"""

import argparse
import json
import os
import sqlite3
import sys
import io
from datetime import datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def random_sample_stocks(conn, n=5):
    """随机抽取 n 只普通 A 股（排除指数、ETF、北交所）."""
    # 使用 LIKE 过滤普通 A 股代码前缀
    stocks = conn.execute("""
        SELECT code, market, name FROM stocks
        WHERE (
            code LIKE '600%' OR code LIKE '601%' OR code LIKE '603%' OR
            code LIKE '605%' OR code LIKE '000%' OR code LIKE '002%' OR
            code LIKE '003%' OR code LIKE '300%' OR code LIKE '301%' OR
            code LIKE '688%'
        )
        AND code NOT LIKE '920%'
        ORDER BY RANDOM()
        LIMIT ?
    """, (n,)).fetchall()
    return [dict(s) for s in stocks]


def get_kline_data(conn, code, market, date):
    """获取某只股票某日的 K 线数据."""
    rows = conn.execute("""
        SELECT date, open, high, low, close, volume, turnover,
               change_pct, change_amount, amplitude, pre_close
        FROM klines
        WHERE code = ? AND market = ? AND date = ?
          AND period = 'daily' AND adjust = 'bfq'
    """, (code, market, date)).fetchall()
    return [dict(r) for r in rows]


def get_quote_data(conn, code, market, date):
    """获取某只股票某日的行情快照."""
    rows = conn.execute("""
        SELECT snapshot_date, name, latest, open, high, low, prev_close,
               volume, turnover, change_pct, pe, pb,
               total_cap, float_cap, high_52w, low_52w
        FROM quotes
        WHERE code = ? AND market = ? AND snapshot_date = ?
    """, (code, market, date)).fetchall()
    return [dict(r) for r in rows]


def get_fundamentals_data(conn, code, market, limit=4):
    """获取最近几期财务数据."""
    rows = conn.execute("""
        SELECT report_date, report_type,
               total_revenue, operate_revenue, operate_cost,
               operate_profit, total_profit, net_profit, parent_net_profit,
               eps, total_assets, total_liabilities, total_equity,
               parent_equity, total_current_assets, total_current_liab,
               inventory, accounts_rece, fixed_asset,
               short_loan, long_loan, monetary_funds,
               operate_cash_flow, invest_cash_flow, finance_cash_flow
        FROM fundamentals
        WHERE code = ? AND market = ?
        ORDER BY report_date DESC
        LIMIT ?
    """, (code, market, limit)).fetchall()
    return [dict(r) for r in rows]


def get_random_dates(conn, code, market, n=3):
    """随机抽取该股票有 K 线数据的 n 个日期."""
    rows = conn.execute("""
        SELECT date FROM klines
        WHERE code = ? AND market = ? AND period = 'daily' AND adjust = 'bfq'
        ORDER BY RANDOM()
        LIMIT ?
    """, (code, market, n)).fetchall()
    return [r['date'] for r in rows]


def generate_llm_prompt(report):
    """生成供 LLM 验证的提示文本."""
    prompt = """你是一名数据质量审核专家。请对以下随机抽取的股票数据进行质量验证，检查数据的正确性、一致性和合理性。

请重点关注以下问题：

1. **K 线价格逻辑**：
   - high >= max(open, close) 且 low <= min(open, close)
   - high >= low
   - 所有价格为正数

2. **涨跌幅一致性**：
   - change_pct 是否约等于 (close - pre_close) / pre_close * 100
   - 允许 ±0.1% 的舍入误差

3. **成交量合理性**：
   - volume 是否为 0（停牌日除外）
   - volume 是否为异常大值（>100亿股）

4. **行情快照与 K 线一致性**：
   - quotes.latest 是否等于 klines.close（同一日期）
   - quotes.open/high/low 是否等于 klines.open/high/low

5. **财务数据合理性**：
   - 资产负债表平衡：total_assets ≈ total_liabilities + total_equity
   - 净利润为负数是否合理（亏损）
   - 营收、利润等数据量级是否合理

请逐只股票、逐日期检查，列出所有发现的问题。如果数据全部正确，请明确说明"未发现异常"。

---
"""

    for stock in report["sampled_stocks"]:
        code = stock["code"]
        name = stock["name"]
        prompt += f"\n{'='*60}\n"
        prompt += f"股票: {code} {name} (market={stock['market']})\n"
        prompt += f"{'='*60}\n"

        for date_data in stock["dates"]:
            date = date_data["date"]
            prompt += f"\n【日期: {date}】\n"

            if date_data["klines"]:
                k = date_data["klines"][0]
                prompt += (
                    f"  K 线: open={k.get('open')}, high={k.get('high')}, "
                    f"low={k.get('low')}, close={k.get('close')}, "
                    f"pre_close={k.get('pre_close')}, change_pct={k.get('change_pct')}, "
                    f"volume={k.get('volume')}, turnover={k.get('turnover')}, "
                    f"amplitude={k.get('amplitude')}\n"
                )
            else:
                prompt += "  K 线: 无数据\n"

            if date_data["quotes"]:
                q = date_data["quotes"][0]
                prompt += (
                    f"  行情: latest={q.get('latest')}, open={q.get('open')}, "
                    f"high={q.get('high')}, low={q.get('low')}, "
                    f"prev_close={q.get('prev_close')}, change_pct={q.get('change_pct')}, "
                    f"volume={q.get('volume')}, pe={q.get('pe')}, pb={q.get('pb')}\n"
                )
            else:
                prompt += "  行情: 无数据\n"

        if stock["fundamentals"]:
            prompt += f"\n【财务数据（最近 {len(stock['fundamentals'])} 期）】\n"
            for f in stock["fundamentals"]:
                revenue = f.get("total_revenue")
                profit = f.get("net_profit")
                assets = f.get("total_assets")
                liabilities = f.get("total_liabilities")
                equity = f.get("total_equity")
                check = ""
                if assets and liabilities and equity:
                    diff = abs(assets - (liabilities + equity))
                    diff_pct = diff / assets * 100 if assets else 0
                    if diff_pct > 1:
                        check = f" [不平衡: 差 {diff:.0f} ({diff_pct:.2f}%)]"
                    else:
                        check = " [平衡]"
                prompt += (
                    f"  报告期 {f.get('report_date')} ({f.get('report_type')}): "
                    f"营收={revenue}, 净利润={profit}, "
                    f"总资产={assets}, 总负债={liabilities}, 权益={equity}{check}\n"
                )
        else:
            prompt += "\n【财务数据】: 无数据\n"

    prompt += "\n" + "=" * 60 + "\n"
    prompt += "请逐只检查并给出审核结论。\n"
    return prompt


def main():
    parser = argparse.ArgumentParser(description="数据质量随机抽样验证")
    parser.add_argument("--stocks", type=int, default=5, help="随机抽取股票数量 (默认 5)")
    parser.add_argument("--dates", type=int, default=3, help="每只股票的随机日期数 (默认 3)")
    parser.add_argument("--output", help="JSON 报告输出路径")
    args = parser.parse_args()

    if not os.path.exists(DB_PATH):
        print(f"错误: 数据库不存在: {DB_PATH}")
        sys.exit(1)

    conn = get_db()

    print(f"[Sampler] 从 {DB_PATH} 随机抽样...")
    print(f"[Sampler] 抽取 {args.stocks} 只股票，每只 {args.dates} 个日期\n")

    # 随机抽取股票
    stocks = random_sample_stocks(conn, args.stocks)
    if not stocks:
        print("错误: 未找到符合条件的股票")
        conn.close()
        sys.exit(1)

    report = {
        "sample_time": datetime.now().isoformat(),
        "db_path": DB_PATH,
        "sample_config": {"stocks": args.stocks, "dates": args.dates},
        "sampled_stocks": [],
    }

    for stock in stocks:
        code = stock["code"]
        market = stock["market"]
        name = stock["name"]
        print(f"[Sampler] 处理: {code} {name}")

        # 随机抽取日期
        dates = get_random_dates(conn, code, market, args.dates)

        stock_report = {
            "code": code,
            "name": name,
            "market": market,
            "dates": [],
        }

        for date in dates:
            date_report = {
                "date": date,
                "klines": get_kline_data(conn, code, market, date),
                "quotes": get_quote_data(conn, code, market, date),
            }
            stock_report["dates"].append(date_report)

        # 财务数据
        stock_report["fundamentals"] = get_fundamentals_data(conn, code, market, limit=4)
        report["sampled_stocks"].append(stock_report)

    conn.close()

    # 输出 JSON 报告
    report_json = json.dumps(report, ensure_ascii=False, indent=2, default=str)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(report_json)
        print(f"\n[Sampler] JSON 报告已保存: {args.output}")
    else:
        print("\n" + "=" * 60)
        print("JSON 抽样报告:")
        print("=" * 60)
        print(report_json)

    # 生成并输出 LLM 提示
    prompt = generate_llm_prompt(report)
    print("\n" + "=" * 60)
    print("LLM 验证提示（可直接复制给 AI 审核）:")
    print("=" * 60)
    print(prompt)

    # 同时保存提示到文件
    prompt_path = args.output.replace(".json", "_prompt.txt") if args.output else None
    if prompt_path:
        with open(prompt_path, "w", encoding="utf-8") as f:
            f.write(prompt)
        print(f"\n[Sampler] LLM 提示已保存: {prompt_path}")


if __name__ == "__main__":
    main()
