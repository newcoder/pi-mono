---
name: local-data
description: A股本地数据基础设施技能。负责 trading-agent 本地 SQLite 数据库（market.db）的创建、日常同步、数据校验、复权因子维护、行业/概念/新闻数据同步，以及从本地数据库读取数据的统一接口。所有分析类技能（如 a-share-analysis）应通过本技能获取行情、财务、K线、新闻等本地数据。
tools:
  - get_quote
  - get_fundamentals
  - get_kline
  - get_stock_news
  - get_market_news
  - screen_stocks
  - discover_trading_ideas
  - analyze_market_theme
  - backtest_strategy
---

# Local Data Skill

A股本地数据基础设施。本 skill 不执行投资分析，只负责把远程数据沉淀到本地 SQLite，并提供统一的数据读取接口。

## 职责边界

- **本 skill**：数据同步、存储、校验、读取。
- **`a-share-analysis`**：基于本 skill 提供的数据进行分析、选股、估值、生成报告。

分析类任务应优先调用 `a-share-analysis`；数据缺失或需要同步时回到本 skill。

## 本地数据库

路径：`~/.trading-agent/data/market.db`

主要表：

| 表名 | 说明 |
|------|------|
| `stocks` | 股票基础信息 |
| `quotes` | 每日行情 / 实时行情快照 |
| `klines` | 日线/周线/月线 K 线 |
| `fundamentals` | 三大财务报表原始数据 |
| `fundamental_indicators` | 预计算财务指标（YoY/QoQ/CAGR/ROE 等） |
| `industries` / `stock_industries` | 行业分类 |
| `concept_stocks` | 概念成分股 |
| `industry_indicators` / `factor_ic` | 行业动量 / 因子 IC |
| `stock_indicators` | 个股衍生指标 |
| `adjust_factors` | 复权因子 |
| `stock_news` / `market_news` | 个股新闻 / 市场宏观新闻 |
| `hot_stocks` | 热股排行 |

## 核心脚本

### 数据读取

- `scripts/data_fetcher.py` — 统一数据读取接口。优先读本地 DB，缺失时 fallback 到东方财富 / akshare。

### 每日同步

- `scripts/daily_sync.py` — 同步编排入口。
- `scripts/batch_get_kline.py` — 批量 K 线下载（mootdx / akshare）。
- `scripts/get_kline.py` — 单只股票 K 线下载。
- `scripts/mootdx_data.py` — mootdx TCP 数据封装。
- `scripts/sync_industries.py` — 行业分类同步。
- `scripts/sync_concepts.py` / `sync_concept_stocks_ths.py` — 概念数据同步。
- `scripts/news_sync.py` / `scripts/market_news_sync.py` — 新闻同步。
- `scripts/backfill_hot_stocks.py` — 热股历史回填。

### 复权因子

- `scripts/batch_get_factors.py`
- `scripts/sync_adjust_factors.py`
- `scripts/sync_adjust_factors_mootdx.py`
- `scripts/forward_fill_factors.py`

### 指标计算

- `scripts/calc_fundamental_indicators.py`
- `scripts/calc_industry_momentum.py`
- `scripts/calc_size_ic.py`

### 校验与质检

- `scripts/sync_validator.py` — 同步后数据完整性校验。
- `scripts/data_quality_sampler.py` — 随机抽样生成 LLM 质检提示。

## When to Use

当用户或其它 skill 需要以下操作时调用本 skill：

- 同步 A 股行情、财务、K 线、新闻等数据到本地。
- 检查本地数据是否完整、最新。
- 直接从本地数据库读取原始数据（优先使用 `data_fetcher.py`）。
- 修复复权因子、行业分类、概念成分股等基础数据。

## Prerequisites

```bash
pip install akshare pandas numpy mootdx requests beautifulsoup4
```

## Workflow 1: Daily Sync

```bash
python scripts/daily_sync.py
```

常用参数：

- `--skip-phases`：跳过某些阶段，例如 `--skip-phases klines,fundamentals`
- `--only-phases`：只执行指定阶段，例如 `--only-phases klines`
- `--dry-run`：只打印计划执行内容，不写入数据库

## Workflow 2: Fetch Data from Local DB

```bash
python scripts/data_fetcher.py \
    --code 600519 \
    --data-type all \
    --years 5 \
    --output tmp/600519.json
```

`--data-type` 可选：`basic` / `valuation` / `financial` / `holder` / `all` / `complete`。

返回 JSON 包含 `_source` 字段，标明数据来自 `local_db` 还是网络 fallback。

## Workflow 3: Validate Local Data

```bash
python scripts/sync_validator.py
```

输出各表记录数、最新日期、缺失项等统计。

## Workflow 4: Sync Single Table

```bash
# 同步行业分类
python scripts/sync_industries.py

# 同步概念
python scripts/sync_concepts.py

# 同步个股新闻
python scripts/news_sync.py --days 7

# 同步市场新闻
python scripts/market_news_sync.py --days 3
```

## Important Notes

- 数据库路径固定为 `~/.trading-agent/data/market.db`，分析类 skill 不应自行修改。
- `data_fetcher.py` 是本 skill 对外提供数据的主入口；分析脚本应通过它读取数据，而不是直接 sqlite3 查询。
- 同步任务建议在交易日凌晨执行，避免与分析任务争抢数据库写入。
- 本 skill 只保证数据可获取、可同步；投资决策请交给 `a-share-analysis` 或其它分析 skill。
