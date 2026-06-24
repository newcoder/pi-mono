---
name: a-share-analysis
description: A股价值投资分析工具，提供股票筛选、个股三档分析（基本面/技术面/深度）、行业对比和估值计算功能。优先使用 trading-agent 本地 SQLite 数据库（已同步的行情/财务/K线数据），缺失时 fallback 到东方财富 API 补全。适合低频交易的普通投资者。
tools:
  - get_quote
  - get_fundamentals
  - get_kline
  - screen_stocks
  - iwencai_screen
  - compare_stocks
  - backtest_strategy
  - discover_trading_ideas
  - get_stock_news
  - screen_by_news
  - get_market_news
  - refresh_calendar
---

# A-Share Analysis Skill

基于价值投资理论的中国A股分析工具，面向低频交易的普通投资者。

## 数据源架构（本地优先 + 网络 fallback）

本 skill 的 `data_fetcher.py` 优先从 trading-agent 本地 SQLite 数据库读取，本地缺失时自动 fallback 到东方财富 API：

| 数据类型 | 优先来源 | Fallback | 说明 |
|---------|---------|---------|------|
| **实时行情** | 本地 `quotes` 表 | 东方财富 API | PE/PB/市值/涨跌幅等 |
| **K线/价格数据** | 本地 `klines` 表 | 东方财富 API | 支持 daily/week/month，含复权 |
| **三大财务报表** | 本地 `fundamentals` 表 | 东方财富 F10 | 资产负债表、利润表、现金流量表 |
| **财务指标** | 本地 `fundamental_indicators` 表 | 本地计算（无需网络） | YoY/QoQ/CAGR、ROE、现金流、偿债能力等 30+ 指标 |
| **三大财务报表** | 本地 `fundamentals` 表 | 东方财富 F10 | 资产负债表、利润表、现金流量表 |
| **股东/分红数据** | — | `akshare` | 十大股东、分红历史（仅网络） |

本地数据库路径：`~/.trading-agent/data/market.db`

### 预计算财务指标表（fundamental_indicators）

`fundamentals` 表中的原始财务数据已通过 `calc_fundamental_indicators.py` 自动计算衍生指标，存入 `fundamental_indicators` 表。当基本面数据更新时，这些指标会自动重新计算。

**包含的指标维度（30+ 项）：**
- **成长性**：营收/净利润 YoY、QoQ、3年/5年 CAGR、经营现金流 YoY、FCF、FCF YoY、研发费用增速及占比、CAPEX 增速及占比
- **盈利能力**：ROE、ROE 变动
- **财务健康**：资产负债率及变动、流动比率、速动比率、利息保障倍数、现金利润比、现金债务比、权益比率
- **风险控制**：有息负债率、短债占比

**使用方式**：通过 `data_fetcher.py --data-type financial` 获取的数据中，`financial_data.indicators` 数组即为预计算指标，按 `REPORT_DATE` 降序排列。指标值为 `None` 表示该期数据无法计算（如历史不足、分母为零等）。

返回的 JSON 中可通过 `_source` 字段查看具体数据来源（`local_db` 或 `eastmoney` 或 `akshare`）。

## When to Use

当用户请求以下操作时调用此skill：
- 分析某只A股股票（含基本面、技术面、新闻资讯）
- 筛选符合条件的股票
- 基于新闻事件筛选股票（如"最近有减持的股票"）
- 查看个股最近新闻和重大事件
- 了解市场宏观新闻和行业影响
- 对比多只股票或行业内股票
- 计算股票估值或内在价值
- 查看股票的财务健康状况
- 检测财务异常风险

## Prerequisites

### Python环境要求
```bash
pip install akshare pandas numpy
```

### 依赖检查
在执行任何分析前，先检查akshare是否已安装：
```bash
python -c "import akshare; print(akshare.__version__)"
```

如果未安装，提示用户安装：
```bash
pip install akshare
```

## Core Modules

### 1. Stock Screener (股票筛选器)
筛选符合条件的股票

### 2. Financial Analyzer (财务分析器)
个股深度财务分析

### 3. Industry Comparator (行业对比)
同行业横向对比分析

### 4. News Analyzer (新闻分析器)
个股新闻事件追踪、利空/利多分类、市场宏观新闻分析

### 5. Valuation Calculator (估值计算器)
内在价值测算与安全边际计算

---

## Workflow 1: Stock Screening (股票筛选)

用户请求筛选股票时使用。

### Step 1: Collect Screening Criteria

向用户询问筛选条件。提供以下选项供用户选择或自定义：

**估值指标：**
- PE (市盈率): 例如 PE < 15
- PB (市净率): 例如 PB < 2
- PS (市销率): 例如 PS < 3

**盈利能力：**
- ROE (净资产收益率): 例如 ROE > 15%
- ROA (总资产收益率): 例如 ROA > 8%
- 毛利率: 例如 > 30%
- 净利率: 例如 > 10%

**成长性：**
- 营收增长率: 例如 > 10%
- 净利润增长率: 例如 > 15%
- 连续增长年数: 例如 >= 3年

**股息：**
- 股息率: 例如 > 3%
- 连续分红年数: 例如 >= 5年

**财务安全：**
- 资产负债率: 例如 < 60%
- 流动比率: 例如 > 1.5
- 速动比率: 例如 > 1

**筛选范围：**
- 全A股
- 沪深300成分股
- 中证500成分股
- 创业板/科创板
- 用户自定义列表

### Step 2: Execute Screening

```bash
python scripts/stock_screener.py \
    --scope "hs300" \
    --pe-max 15 \
    --roe-min 15 \
    --debt-ratio-max 60 \
    --dividend-min 2 \
    --output screening_result.json
```

**参数说明：**
- `--scope`: 筛选范围 (all/hs300/zz500/cyb/kcb/custom:600519,000858,...)
- `--pe-max/--pe-min`: PE范围
- `--pb-max/--pb-min`: PB范围
- `--roe-min`: 最低ROE
- `--growth-min`: 最低增长率
- `--debt-ratio-max`: 最大资产负债率
- `--dividend-min`: 最低股息率
- `--output`: 输出文件路径

### Step 3: Present Results

读取 `screening_result.json` 并以表格形式呈现给用户：

| 代码 | 名称 | PE | PB | ROE | 股息率 | 评分 |
|------|------|----|----|-----|--------|------|
| 600519 | 贵州茅台 | 25.3 | 8.5 | 30.2% | 2.1% | 85 |

---

## Workflow 1.5: iWencai Natural Language Screening (问财自然语言选股)

当用户提出复杂的自然语言筛选条件时使用，例如：
- "MACD金叉且成交量放大的股票"
- "今日涨幅超5%的A股"
- "主力资金净流入前20的板块"
- "ROE大于15%且市盈率小于20的A股"

### Step 1: Choose Query Mode

**股票选股模式** (`mode: stock`)：
```bash
# 使用预设模板
python scripts/iwencai_screener.py --preset 强势股 --limit 20

# 自定义自然语言查询
python scripts/iwencai_screener.py --query "MACD金叉且KDJ金叉" --limit 50

# 获取所有结果（自动翻页）
python scripts/iwencai_screener.py --preset 主力流入 --all
```

**板块查询模式** (`mode: plate`)：
```bash
# 查询热门行业板块
python scripts/iwencai_screener.py --preset 热门行业 --mode plate --limit 15

# 查询热门概念板块（过滤超大板块）
python scripts/iwencai_screener.py --preset 热门概念 --mode plate --max-components 100 --limit 20

# 自定义板块查询
python scripts/iwencai_screener.py --query "今日涨幅前10的概念板块" --mode plate
```

**可用预设模板：**

| 预设名 | 说明 | 模式 |
|--------|------|------|
| 涨停股 | 今日涨停的A股 | stock |
| 强势股 | 今日涨幅超5%且成交量放大的A股 | stock |
| 主力流入 | 今日主力净流入前20的A股 | stock |
| MACD金叉 | MACD金叉且成交量放大的A股 | stock |
| 低价股 | 股价低于10元且今日涨幅超3%的A股 | stock |
| 次新股 | 上市不足一年且今日涨幅超5%的A股 | stock |
| 高ROE | ROE大于15%且市盈率小于20的A股 | stock |
| 破净股 | 市净率小于1的A股 | stock |
| 热门行业 | 今日涨幅前10的行业板块 | plate |
| 行业资金 | 今日主力净流入前10的行业板块 | plate |
| 热门概念 | 今日涨幅前10的概念板块 | plate |
| 概念资金 | 今日主力净流入前10的概念板块 | plate |

### Step 2: Present Results

iWencai 返回的结果包含股票代码、名称、最新价、涨跌幅、主力净流入等字段，直接以表格形式呈现。

> **注意**: iWencai 需要 `IWENCAI_API_KEY` 环境变量。若未配置，工具会返回错误提示。

---

## Workflow 2: Stock Analysis (个股分析)

用户请求分析某只股票时使用。

### Step 1: Collect Stock Information

询问用户：
1. 股票代码或名称
2. 分析深度级别（三档，参见 `templates/financial_analyst_prompt.txt`）：
   - **基本面分析（档一）**：快速排雷 + 财务质量诊断 + 估值结论（5-10分钟）
   - **技术面分析（档二）**：趋势/形态/指标 + 资金面 + 买卖时机（5-10分钟）
   - **深度分析（档三）**：基本面 + 技术面 + 行业 + 估值 + 新闻全面融合（20-30分钟）

### Step 2: Fetch Stock Data

```bash
python scripts/data_fetcher.py \
    --code "600519" \
    --data-type all \
    --years 5 \
    --output stock-data.json
```

**参数说明：**
- `--code`: 股票代码
- `--data-type`: 数据类型 (basic/financial/valuation/holder/all)
  - `basic`: 基本信息（优先本地 quotes 表，fallback 东方财富 API）
  - `valuation`: 估值数据 + 价格/K线（优先本地 klines 表，fallback 东方财富 API）
  - `financial`: 三大报表 + 财务指标（优先本地 fundamentals + fundamental_indicators 表，fallback 东方财富 F10）
  - `holder`: 股东数据 + 分红数据（仅 akshare 网络，**可能较慢**）
  - `all`: 以上全部
- `--years`: 获取多少年的历史数据
- `--output`: 输出文件

> **提示**：`holder` 数据只能通过 akshare 网络获取。若只需行情和财务分析，本地数据库已足够。
>
> **三档分析对应数据类型**：
> - 档一（基本面分析）：`--data-type financial` — 仅需要财务数据
> - 档二（技术面分析）：`--data-type valuation` — 仅需要K线/估值数据
> - 档三（深度分析）：`--data-type all` — 全部数据（含新闻）

### Step 3: Fetch News Data (新闻资讯)

在财务分析之前，先获取个股最近的新闻资讯，用于模块六（新闻资讯多空解读）：

```bash
# 使用 get_stock_news 工具获取个股新闻（通过 trading-agent）
# 参数：code=股票代码, days=查询天数(默认7), eventTypes=可选事件筛选

# 示例输出包含：
# - 新闻标题、来源、发布时间
# - 自动分类的事件类型（回购/增持/减持/定增/业绩预增/业绩预亏等）
# - 情绪判断（positive/negative/neutral）
# - 影响程度（high/medium/low）
```

**新闻事件类型列表：**
- **利空事件**：减持、定增、业绩预亏、业绩亏损、业绩下滑、解禁、监管处罚、质押风险、诉讼仲裁
- **利多事件**：增持、业绩预增、业绩增长、回购、分红、重大合同、产品突破

> **注意**：数据来自本地数据库，需先通过 `news_sync.py` 同步。若返回空，提示用户新闻数据尚未同步。

### Step 4: Run Financial Analysis

```bash
python scripts/financial_analyzer.py \
    --input stock-data.json \
    --level standard \
    --output analysis_result.json
```

**参数说明：**
- `--input`: 输入的股票数据文件
- `--level`: 分析深度 (fundamental/technical/deep，对应三档分析的档一/档二/档三)
- `--output`: 输出文件

### Step 5: Calculate Valuation

```bash
python scripts/valuation_calculator.py \
    --input stock-data.json \
    --methods dcf,ddm,relative \
    --discount-rate 10 \
    --growth-rate 8 \
    --output valuation_result.json
```

**参数说明：**
- `--input`: 股票数据文件
- `--methods`: 估值方法 (dcf/ddm/relative/all)
- `--discount-rate`: 折现率(%)
- `--growth-rate`: 永续增长率(%)
- `--margin-of-safety`: 安全边际(%)
- `--output`: 输出文件

### Step 6: Generate Report（一体化分析）

**⚠️ 性能要求：必须使用一体化脚本 `deep_analyzer.py`，一次调用完成全部分析计算，禁止使用多个独立的 Python 子进程分别计算技术指标、杜邦分析等。**

```bash
# 一体化：一次调用完成所有技术指标+基本面+估值计算 → 输出 Markdown 报告
python scripts/deep_analyzer.py \
    --input stock-data.json \
    --level deep \
    --output analysis_report.md
```

**参数说明**：
- `--input`：data_fetcher.py 输出的 JSON 文件
- `--level`：分析档位（`fundamental`/`technical`/`deep`）
- `--output`：输出 Markdown 报告文件

**三档分析体系**（详见 `templates/financial_analyst_prompt.txt`）：

| 档位 | --level | 报告范围 | 适用场景 |
|------|---------|----------|----------|
| 🥇 档一 | `fundamental` | F1-F8：审计→资产负债表→利润表→现金流→排雷→杜邦→估值→结论 | 快速判断财务健康度 |
| 🥈 档二 | `technical` | T1-T6：趋势→形态→指标→成交量→资金面→操作建议 | 判断买卖时机 |
| 🥉 档三 | `deep` | D1-D11：基本面+技术面+行业格局+造假识别+新闻多空+估值+击球区 | 重大投资决策 |

**`analysis_framework.md` 十大模块参考**（深度分析时可按需裁剪）：

1. **基础信息分析**：公司概况、近期股价表现
2. **行业与竞争格局**：行业空间/景气度、竞争格局、护城河、市场份额
3. **基本面分析**：财务五维分析（盈利/成长/营运/偿债/现金流）、估值分析
4. **机构观点分析**：评级汇总、目标价预测、核心逻辑摘要
5. **一致性预期分析**：盈利预测汇总、预测区间、业绩确定性评估
6. **新闻资讯多空解读**：近期重大资讯分类、多空综合评级、关键资讯深度解析
7. **资金面分析**：主力动向、北向资金、融资融券、机构持仓、股东结构
8. **技术面分析**：趋势/形态/指标/成交量分析
9. **多空研判与投资建议**：多空因素汇总、综合评级、操作策略、目标价/止损价、风险提示
10. **附录**：数据来源与免责声明

> **数据可用性说明**：
> - 模块四（机构观点）、模块五（一致性预期）、模块七（资金面中的主力/北向/融资融券）依赖外部 API，本地数据库可能无数据
> - **模块六（新闻资讯）现已支持**：通过 `get_stock_news` 和 `get_market_news` 工具从本地数据库查询，数据需先通过 `news_sync.py` / `market_news_sync.py` 同步
> - **不可编造机构评级、目标价等内容**。如数据缺失，应在报告中如实标注"该模块数据暂缺"，仅基于有数据的模块给出分析结论。
>
> 模板使用原则：按需裁剪、数据时效、多空平衡、结论明确、风险充分。详见 `templates/analysis_framework.md` 使用说明部分。

---

## Workflow 3: Industry Comparison (行业对比)

### Step 1: Collect Comparison Targets

询问用户：
1. 目标股票代码（可多个）
2. 或者：行业分类 + 对比数量

### Step 2: Fetch Industry Data

```bash
python scripts/data_fetcher.py \
    --codes "600519,000858,002304" \
    --data-type comparison \
    --output industry_data.json
```

或按行业获取：
```bash
python scripts/data_fetcher.py \
    --industry "白酒" \
    --top 10 \
    --output industry_data.json
```

### Step 3: Generate Comparison

```bash
python scripts/financial_analyzer.py \
    --input industry_data.json \
    --mode comparison \
    --output comparison_result.json
```

### Step 4: Present Comparison Table

| 指标 | 贵州茅台 | 五粮液 | 洋河股份 | 行业均值 |
|------|----------|--------|----------|----------|
| PE | 25.3 | 18.2 | 15.6 | 22.4 |
| ROE | 30.2% | 22.5% | 20.1% | 18.5% |
| 毛利率 | 91.5% | 75.2% | 72.3% | 65.4% |
| 评分 | 85 | 78 | 75 | - |

---

## Workflow 4: Valuation Calculator (估值计算)

### Step 1: Collect Valuation Parameters

询问用户估值参数（或使用默认值）：

**DCF模型参数：**
- 折现率 (WACC): 默认10%
- 预测期: 默认5年
- 永续增长率: 默认3%

**DDM模型参数：**
- 要求回报率: 默认10%
- 股息增长率: 使用历史数据推算

**相对估值参数：**
- 对比基准: 行业均值 / 历史均值

### Step 2: Run Valuation

```bash
python scripts/valuation_calculator.py \
    --code "600519" \
    --methods all \
    --discount-rate 10 \
    --terminal-growth 3 \
    --forecast-years 5 \
    --margin-of-safety 30 \
    --output valuation.json
```

### Step 3: Present Valuation Results

| 估值方法 | 内在价值 | 当前价格 | 安全边际价格 | 结论 |
|----------|----------|----------|--------------|------|
| DCF | ¥2,150 | ¥1,680 | ¥1,505 | 低估 |
| DDM | ¥1,980 | ¥1,680 | ¥1,386 | 低估 |
| 相对估值 | ¥1,850 | ¥1,680 | ¥1,295 | 合理 |

---

## Workflow 5: News Screening (新闻事件筛选)

用户请求基于新闻事件筛选股票时使用，例如"最近一周有高管减持的股票"。

### Step 1: 确定筛选条件

```bash
# 使用 screen_by_news 工具
# 参数：eventTypes, sentiment, impactLevel, days, limit
```

**常见筛选场景：**

| 用户意图 | eventTypes | sentiment | days |
|----------|-----------|-----------|------|
| 最近有减持的股票 | ["减持"] | negative | 7 |
| 最近发布业绩预增 | ["业绩预增","业绩增长"] | positive | 7 |
| 最近有利空消息 | — | negative | 7 |
| 最近有回购计划 | ["回购"] | positive | 30 |

### Step 2: 调用筛选

```bash
# 通过 trading-agent 的 screen_by_news 工具执行
# 返回：符合条件的股票列表（代码、名称、事件数、最新事件时间/标题）
```

### Step 3: 呈现结果

筛选完成后，将结果保存为股票池，供后续分析使用。

---

## Workflow 6: Market News (市场宏观新闻)

用户请求了解市场宏观新闻、财经要闻时使用。

### Step 1: 确定查询模式

- **query 模式**：获取新闻列表（按类型、情绪、影响范围筛选）
- **stats 模式**：获取统计概览（类型分布、受益/承压板块排行）

### Step 2: 调用查询

```bash
# 查询最近7天的政策类利好新闻
{"mode": "query", "newsTypes": ["政策"], "sentiment": "positive", "days": 7}

# 查看市场新闻统计概览
{"mode": "stats", "days": 7}
```

**新闻类型**：政策、宏观、行业、国际、监管、其他

**影响范围**：
- `market_wide` — 影响整个市场（如降准、加息）
- `sector_specific` — 影响特定行业（如新能源补贴政策）
- `mixed` — 混合影响

### Step 3: 分析呈现

- **query 模式**：按新闻类型分组展示，标注受益/承压板块
- **stats 模式**：展示类型分布柱状图 + 板块排行

> **注意**：市场新闻数据来自本地 `market_news` 表，需先通过 `market_news_sync.py` 同步。数据来源为财联社等财经媒体。

---

## Financial Anomaly Detection (财务异常检测)

在分析过程中自动检测以下异常信号：

### 检测项目

1. **应收账款异常**
   - 应收账款增速 > 营收增速 × 1.5
   - 应收账款周转天数大幅增加

2. **现金流背离**
   - 净利润持续增长但经营现金流下降
   - 现金收入比 < 80%

3. **存货异常**
   - 存货增速 > 营收增速 × 2
   - 存货周转天数大幅增加

4. **毛利率异常**
   - 毛利率波动 > 行业均值波动 × 2
   - 毛利率与同行严重偏离

5. **关联交易**
   - 关联交易占比过高（> 30%）

6. **股东减持**
   - 大股东近期减持公告
   - 高管集中减持

### 风险等级

- 🟢 **低风险**：无明显异常
- 🟡 **中风险**：1-2项轻微异常
- 🔴 **高风险**：多项异常或严重异常

---

## A-Share Specific Analysis (A股特色分析)

### 政策敏感度

根据行业分类提供政策相关提示：
- 房地产：房住不炒政策
- 新能源：补贴政策变化
- 医药：集采政策影响
- 互联网：反垄断、数据安全

### 股东结构分析

1. 控股股东类型（国企/民企/外资）
2. 股权集中度
3. 近期增减持情况
4. 质押比例

---

## Output Format

### JSON输出格式

所有脚本输出JSON格式，便于后续处理：

```json
{
  "code": "600519",
  "name": "贵州茅台",
  "analysis_date": "2025-01-25",
  "level": "standard",
  "summary": {
    "score": 85,
    "conclusion": "低估",
    "recommendation": "建议关注"
  },
  "financials": { ... },
  "valuation": { ... },
  "risks": [ ... ]
}
```

### Markdown报告

生成结构化的中文Markdown报告，参考 `templates/analysis_framework.md` 框架（按需裁剪模块）。

---

## Error Handling

### 网络错误
如果akshare数据获取失败，提示用户：
1. 检查网络连接
2. 稍后重试（可能是接口限流）
3. 尝试更换数据源

### 股票代码无效
提示用户检查股票代码是否正确，提供可能的匹配建议。

### 数据不完整
对于新上市股票或财务数据不完整的情况，说明数据限制并基于可用数据进行分析。

---

## Best Practices

1. **数据时效性**：财务数据以最新季报/年报为准，价格数据为当日收盘价
2. **投资建议**：所有分析仅供参考，不构成投资建议
3. **风险提示**：始终包含风险提示，特别是财务异常检测结果
4. **对比分析**：单只股票分析时，自动包含行业均值对比

---

## Workflow 7: Investment Calendar (投资日历)

用户询问未来市场事件、个股事件，或请求刷新投资日历时使用。

### 事件类型

| 类型 | 说明 | 数据来源 |
|------|------|----------|
| macro | 宏观数据发布、政策会议 | iWencai API + 硬编码 |
| industry | 行业展会、购物节、用电高峰 | 硬编码季节性事件 |
| conference | 科技展会（WWDC、CES、SNEC等） | 硬编码季节性事件 |
| earnings | 业绩预告、财报披露 | iWencai API + akshare |
| unlock | 限售解禁 | iWencai API + akshare |
| stock | 个股公告、股东大会 | iWencai API |
| other | 其他事件 | iWencai API |

### 硬编码季节性事件

包含以下固定时间事件（每年自动重复）：
- **1月**: CES消费电子展
- **2月**: MWC世界移动通信大会、中央一号文件
- **3月**: 全国两会
- **4月**: 中央政治局会议（季度部署）
- **6月**: 苹果WWDC、Computex台北电脑展、SNEC光伏展、618购物节、OPEC+产量会议、迎峰度夏
- **7月**: 中央政治局会议（半年度部署）
- **11月**: 双11购物节
- **12月**: 中央经济工作会议

### 刷新投资日历

```bash
# 刷新市场整体事件
{"scope": "market"}

# 刷新特定股票事件
{"scope": "stock", "code": "600519"}
```

### 使用场景

- "未来两周有哪些重要事件？"
- "6月份有什么行业展会？"
- "刷新投资日历"
- "查看贵州茅台近期有哪些事件"

---

## Workflow 8: Trading Idea Discovery (交易策略发现)

自动生成可量化、可验证的交易策略想法，作为自动化策略创建流程的第1阶段。

### When to Use

当用户请求以下操作时使用 `discover_trading_ideas`：
- "发现交易想法"
- "生成交易策略"
- "当前市场风格下有什么可做的策略"
- "策略自动化创建"

### Input Parameters

```json
{
  "lookback_days": 20,
  "max_ideas": 5,
  "categories": ["market_style", "technical", "fundamental", "event", "classic", "multifactor"],
  "min_confidence": 50
}
```

- `lookback_days`: 回看天数，用于计算因子IC和行业动量的近期趋势。
- `max_ideas`: 返回的候选想法数量上限。
- `categories`: 想法来源类别，可多选。
  - `market_style`: 市场风格 / 行业动量 / 市值因子
  - `technical`: 技术形态信号
  - `fundamental`: 基本面 / 估值
  - `event`: 事件 / 情绪驱动
  - `classic`: 经典技术指标策略（MA/MACD/RSI/Bollinger/Supertrend）
- `multifactor`: 多因子综合选股（价值/动量/质量/低波动，Z-score 等权合成）
- `min_confidence`: 最低置信度过滤（0-100）。

### Output

返回结构化想法列表，每个想法包含：
- `hypothesis`: 一句话交易假设
- `rationale`: 逻辑依据
- `entryCriteria` / `exitCriteria`: 可量化的入场/出场条件
- `universeFilter`: 选股范围描述
- `suggestedStrategy`: 可直接用于 `backtest_strategy` 的策略类型和参数
- `confidence`: 置信度评分
- `feasibility`: 轻量可行性检查结果
- `risks` / `invalidationConditions`: 风险与失效条件

### Cross-Skill Idea Enrichment（可选增强）

`discover_trading_ideas` 返回的是基于本地 `market.db` 的量化候选。若要叠加市场结构、热点题材、因子有效性等视角，可按以下步骤增强：

1. **运行 `discover_trading_ideas` 获取数据基线**：
   - 关注 `regime`、`topIndustries`、`factorIcSnapshot`、`sentimentIndex` 等字段。

2. **调用 `a-share-primary-theme-identification` 获取市场结构视角**：
   - 输入当前市场概况、板块表现、`discover_trading_ideas` 提取的前 5 动量行业。
   - 获取：今日主线、次级热点、核心龙头/中军、情绪周期、主线持续性、明日观察重点。
   - 若其主线与本 skill 的 `topIndustries` 一致，可增强相关想法的置信度；若不一致，需标记为分歧并降低权重。

3. **调用 `longbridge-quant` 或 `quantitative-research` 做因子验证**：
   - 对核心因子（如 `industry_momentum_20d_forward5d`、`size_forward5d`）做 IC/IR 复核。
   - 参考 `longbridge-quant` 的 factor-research 流程：Spearman IC、信息比率 IR、分位组合回测、IC 衰减分析。
   - 参考 `quantitative-research` 的 alpha signal research：要求 IC > 0.02、t-stat > 2、IR > 0.5；多因子组合可做 Z-score 等权或 IC 加权。

4. **调用 `geek-skills-a-share-analyst` 做个股/板块深度检查**（针对筛选后的重点标的）：
   - 技术面评分、基本面评分、板块热点定位。
   - 用于细化 `universeFilter` 或排除高风险标的。

5. **综合输出**：
   - 保留 `discover_trading_ideas` 的结构化字段。
   - 在 `rationale` / `risks` 中补充外部 skill 的关键洞察（如情绪周期位置、IC 衰减方向、主线持续性评估）。
   - 如果外部 skill 认为某方向处于退潮期或 IC 连续衰减，即使本地数据置信度高，也应加入风险提示或列为 invalidation condition。

### Phase 1 → Phase 2 Handoff

`discover_trading_ideas` 只返回想法，不保存到数据库。下一步验证流程：

1. 用户或 agent 从返回的想法中选择 1-3 个。
2. 根据 `universeFilter` 使用 `screen_stocks` / `advanced_screen` / `iwencai_screen` 构建股票池。
3. 使用 `manage_stock_pool` 保存股票池。
4. 使用 `backtest_strategy` 对股票池进行长期历史回测（phase 2）。
   - 回测设计应吸收 `quantitative-research` 的严谨性： walk-forward 验证、样本外测试、显式交易成本、避免前视偏差和过拟合。
5. 回测表现优秀的策略进入 `manage_portfolio` 进行模拟跟踪（phase 3）。

### Example

```json
{
  "lookback_days": 20,
  "max_ideas": 3,
  "categories": ["market_style", "classic"]
}
```

---

## Related Skills for Market State & Quantitative Research

本 skill 的 `discover_trading_ideas` 已经可以从本地 `market.db` 提取市场风格、行业动量、size IC、情绪等数据并生成可量化的交易想法。以下外部 skill 可与本 skill 互补使用，或将其分析框架吸收进交易想法发现流程：

| Skill | 作用 | 使用时机 |
|---|---|---|
| `a-share-primary-theme-identification` | A 股主线识别：市场结构 / 题材周期 / 资金行为 / 情绪周期 | 需要理解当前真正的交易主线、龙头/中军/补涨、明日观察重点时 |
| `geek-skills-a-share-analyst` | A 股分析师：技术面 / 基本面 / 板块热点 / 量化因子 | 需要对单只个股或板块做更深入的技术/基本面分析时 |
| `longbridge-quant` | 量化框架：IC/IR 分析、多因子模型、波动率制度、配对交易、季节性等 | 需要验证因子有效性、构建多因子组合、评估 IC 衰减时 |
| `quantitative-research` | 系统化量化研究：alpha 生成、回测陷阱、walk-forward、成本控制 | 需要将想法推进到严格的历史回测和策略优化时 |

### 使用方式

1. **调用外部 skill 获取市场结构/因子视角**：在运行 `discover_trading_ideas` 之前或之后，调用上述 skill 获取对当前市场状态、热点、有效因子的定性/定量分析。
2. **与本 skill 的本地数据做交叉验证**：外部 skill 的结论必须与本地 `factor_ic`、`industry_indicators`、`industry_quotes`、`quotes` 中的最新 IC、动量、情绪数据做交叉验证。若出现冲突，优先以本地数据库为准，并在最终报告中标注分歧。
3. **吸收框架，不照搬结论**：例如 `longbridge-quant` 的 IC/IR 分析流程（Spearman IC、信息比率、分位组合回测、IC 衰减）和 multi-factor 框架（价值/动量/质量/低波动 Z-score 等权合成），已分别吸收进 `discover_trading_ideas` 的因子快照与 `multifactor` 类别；`quantitative-research` 的 walk-forward / 成本控制原则，可直接吸收进 Phase 2 的回测验证；`a-share-primary-theme-identification` 的“市场环境→主线→龙头→情绪周期→持续性”五步框架，可用于 enriched idea 的叙事和风险识别。

> 注意：部分外部 skill 依赖网络数据（如 Wind、AKShare、Longbridge）或 PromptScript 组件。当网络不可用或全局安装受限时，仍以本 skill 的本地工具和数据库为 fallback。

---

## Important Notes

- 所有分析基于公开财务数据，不涉及任何内幕信息
- 估值模型的参数假设对结果影响较大，需向用户说明
- A股市场受政策影响较大，定量分析需结合定性判断
