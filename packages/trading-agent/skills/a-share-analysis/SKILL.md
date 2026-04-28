---
name: a-share-analysis
description: A股价值投资分析工具，提供股票筛选、个股深度分析、行业对比和估值计算功能。优先使用 trading-agent 本地 SQLite 数据库（已同步的行情/财务/K线数据），缺失时 fallback 到东方财富 API 补全。适合低频交易的普通投资者。
tools:
  - get_quote
  - get_fundamentals
  - get_kline
  - screen_stocks
  - compare_stocks
  - backtest_strategy
  - get_stock_news
  - screen_by_news
  - get_market_news
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
| **财务指标** | 本地 `fundamentals` 表计算 | 东方财富 API | ROE、毛利率等 |
| **股东/分红数据** | — | `akshare` | 十大股东、分红历史（仅网络） |

本地数据库路径：`~/.trading-agent/data/market.db`

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

## Workflow 2: Stock Analysis (个股分析)

用户请求分析某只股票时使用。

### Step 1: Collect Stock Information

询问用户：
1. 股票代码或名称
2. 分析深度级别：
   - **摘要级**：关键指标 + 投资结论（1页）
   - **标准级**：财务分析 + 估值 + 行业对比 + 风险提示
   - **深度级**：完整调研报告，包含历史数据追踪

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
  - `financial`: 三大报表 + 财务指标（优先本地 fundamentals 表，fallback 东方财富 F10）
  - `holder`: 股东数据 + 分红数据（仅 akshare 网络，**可能较慢**）
  - `all`: 以上全部
- `--years`: 获取多少年的历史数据
- `--output`: 输出文件

> **提示**：`holder` 数据只能通过 akshare 网络获取。若只需行情和财务分析，本地数据库已足够。

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
- `--level`: 分析深度 (summary/standard/deep)
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

### Step 6: Generate Report

读取分析结果，参考 `templates/analysis_framework.md` 模板生成中文分析报告。

该框架包含十大分析模块，**根据分析深度级别选择性使用**：

**摘要级**（1页）：模块一（基础信息）+ 模块三（基本面核心指标）+ 模块九（多空研判与投资建议）

**标准级**（3-5页）：模块一 + 模块二（行业与竞争格局）+ 模块三（基本面完整分析）+ 模块四（机构观点）+ 模块八（技术面）+ 模块九

**深度级**（完整报告）：全部十大模块，含模块五（一致性预期）、模块六（新闻资讯多空）、模块七（资金面）

十大模块速览：
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

## Important Notes

- 所有分析基于公开财务数据，不涉及任何内幕信息
- 估值模型的参数假设对结果影响较大，需向用户说明
- A股市场受政策影响较大，定量分析需结合定性判断
