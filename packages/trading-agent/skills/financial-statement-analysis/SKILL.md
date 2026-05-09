---
name: financial-statement-analysis
description: Download China stock (A-share/HK) annual reports from cninfo and perform 4 local analyses - quick mine-sweeping check, cash flow portrait, valuation & buying zone, and 5-year profit quality. Analysis uses the "Financial Report Analyst" persona locally (no NotebookLM upload).
---

# Financial Statement Analysis

## Overview

Download annual and periodic reports for China A-share and Hong Kong stocks from cninfo.com.cn, then perform four targeted analyses **locally within the agent** using a specialized "Financial Report Analyst" persona — no NotebookLM required.

## When to Use

- User provides a China stock name or code
- User asks to "排雷" (mine-sweep) a stock
- User wants to know cash flow portrait (现金流肖像)
- User asks for valuation and buying zone (估值/击球区)
- User wants to assess profit quality over the years
- User requests any combination of the four analysis types

## Supported Markets

| Market | Code Pattern | Examples |
| :--- | :--- | :--- |
| A-share | 6-digit codes (0xxxxx, 3xxxxx, 6xxxxx) | 600519 (贵州茅台), 000001 (平安银行) |
| Hong Kong | 5-digit codes (00xxx, 01xxx, 02xxx, 09xxx) | 00700 (腾讯控股), 09988 (阿里巴巴) |

## Core Workflow

```
User provides stock name/code
        ↓
1. Download reports from cninfo (5yr annual + periodic)
        ↓
2. Convert all PDFs to Markdown via markitdown
        ↓
3. Read assets/financial_analyst_prompt.txt (analyst persona)
        ↓
4. Run 4 analyses in parallel via call_llm:
   a. 快速排雷检查 (Quick Mine-Sweeping)
   b. 现金流肖像分析 (Cash Flow Portrait)
   c. 合理估值与击球区 (Valuation & Buying Zone)
   d. 近5年利润质量 (5-Year Profit Quality)
        ↓
5. Synthesize and present report to user ✅
```

---

## Step-by-Step Instructions

### Step 0: Environment Check (First Run Only)

Before running, verify Python dependencies:

```bash
python -c "import httpx; print('httpx OK')"
```

If `httpx` is missing, install:
```bash
pip install httpx
```

### Step 1: Download Reports

Run the download script from the skill directory (**must use PYTHONIOENCODING on Windows**):

```bash
PYTHONIOENCODING=utf-8 python3 scripts/download_reports.py <stock_code_or_name>
```

Examples:
- `PYTHONIOENCODING=utf-8 python3 scripts/download_reports.py 600519` — A-share by code
- `PYTHONIOENCODING=utf-8 python3 scripts/download_reports.py 贵州茅台` — A-share by name
- `PYTHONIOENCODING=utf-8 python3 scripts/download_reports.py 00700` — Hong Kong stock

This outputs a JSON block between `---JSON_OUTPUT---` markers containing:
- `stock_code`, `stock_name`, `market`
- `output_dir`: temp directory with downloaded PDFs
- `files`: list of absolute PDF file paths

Parse this JSON to get all file paths.

### Step 2: Convert PDFs to Markdown

For each downloaded PDF, convert to markdown:

```bash
markitdown "<pdf_path>" -o "<output_md_path>"
```

Use the session data folder (`dataFolderPath` from session_state) as the output directory for markdown files. Name them consistently, e.g., `<stock_code>_annual_<year>.md`.

### Step 3: Read the Analyst Persona

Read the full analyst prompt:

```
Read: assets/financial_analyst_prompt.txt
```

This contains the complete analytical framework covering:
- Part 1: Audit opinion & report selection
- Part 2: Balance sheet analysis (asset quality, liability quality)
- Part 3: Income statement analysis (profit quality, YoY comparison)
- Part 4: Cash flow statement analysis (portrait classification, golden standards)
- Part 5: Fraud detection (red flag checklist)
- Part 6: Valuation & buying zone calculation
- Part 9: Quick mine-sweeping checklist

### Step 4: Run the Four Analyses

**IMPORTANT**: All four `call_llm` calls can run in **parallel** since they read the same converted reports.

For each analysis, use `call_llm` with these parameters:
- `systemPrompt`: The FULL content of `financial_analyst_prompt.txt`
- `attachments`: The converted markdown report files (focus on the latest annual report, plus all 5 annual reports for multi-year analysis)
- `model`: Use the default fast model for cost efficiency, or a reasoning model for the valuation analysis

---

#### Analysis A: 快速排雷检查 (Quick Mine-Sweeping)

**Prompt:**
```
请基于提供的年报，按照"第九部分：快速排雷清单"的方法，对该股票进行快速排雷检查。

逐项检查以下 8 项（每项输出 ✅ 通过 / ❌ 不通过）：
1. 审计意见是否为"标准无保留意见"？
2. 经营现金流是否连续3年为正？
3. 商誉/净资产是否 < 30%？
4. 是否存在"存贷双高"？
5. 应收账款增速是否 < 营收增速×2？
6. 资产负债率是否 < 70%（非金融）？
7. 是否为农林牧渔行业（生物资产风险）？
8. 近期是否更换会计师事务所？

最后给出：
- 通过数：X/8
- 结论：✅ 通过排雷，可继续深度分析 / ❌ 存在重大风险，建议排除
- 风险项详细说明
```

**Output format:** Markdown with checklist and risk assessment.

---

#### Analysis B: 现金流肖像分析 (Cash Flow Portrait)

**Prompt:**
```
请基于提供的最近5年年报，按照"第四部分：现金流量表分析"的方法，分析该股票的现金流肖像类型。

要求：
1. 列出近5年每年的经营/投资/筹资三类现金流净额正负
2. 判定每年的现金流肖像类型（奶牛型/老母鸡型/蛮牛型/妖精型/失血型/赌徒型/衰退型/濒死型）
3. 用"五大黄金标准"检验最近一年：
   - 经营现金流净额 > 净利润 > 0
   - 销售商品收到现金 ≥ 营业收入
   - 投资现金流净额 < 0
   - 现金及等价物净增加额 > 0
   - 期末现金余额 ≥ 有息负债
4. 计算最近一年"净利润现金含量"（经营现金流净额/净利润）
5. 给出综合评价
```

**Output format:** Table showing 5-year portrait evolution + golden standard checklist + profit cash content.

---

#### Analysis C: 合理估值与击球区 (Valuation & Buying Zone)

**Prompt:**
```
请基于最新一期年报的归母净利润数据，按照"第六部分：估值与击球区判断"的方法，计算该股票的合理估值和击球区。

要求：
1. 从年报提取：归母净利润(亿元)、总股本(亿股)
2. 判断该股票所属行业及对应的合理PE范围（需要你根据行业知识判断）：
   - 高成长行业（科技、医药）: 25-40倍
   - 稳定成长行业（消费、品牌）: 15-25倍
   - 成熟行业（公用事业、银行）: 8-15倍
   - 周期行业：PE估值失效，需特别说明
3. 计算：
   - 悲观价格
   - 合理价格
   - 乐观价格
   - 理想买入价（合理价格×0.7）
   - 击球区价格区间
4. 输出估值结果表格

然后我会用 web_search 获取当前股价，补充在表格中，并给出击球区判断（🟢绝佳/🟡一般/🟠持有/🔴高估）。
```

**IMPORTANT**: After receiving the `call_llm` result, the agent MUST:
1. Use `web_search` to get the current real-time stock price
2. Compare current price against the calculated buying zone
3. Add the comparison row to the output table

**Output format:** Valuation calculation table + real-time price comparison + buying zone verdict.

---

#### Analysis D: 近5年利润质量 (5-Year Profit Quality)

**Prompt:**
```
请基于提供的最近5年年报，按照"第三部分：利润表分析"的方法，分析该股票近5年的利润质量。

要求：
1. 列出近5年每年的：
   - 营业收入
   - 归母净利润
   - 毛利率
   - 净利率
   - 扣非净利润
   - 期间费用率（销售+管理+财务费用/营收）
2. 分析趋势：
   - 毛利率是稳定/上升/下降？
   - 收入增长 vs 利润增长是否匹配？（有没有增收不增利）
   - 非经常性损益占比如何？（扣非净利润 vs 净利润差异）
   - 期间费用率变化趋势
3. 给出利润质量评级（优秀/良好/一般/差）
```

**Output format:** 5-year financial data table + trend analysis + quality rating.

---

### Step 5: Synthesize and Present Report

Combine all four analysis results into a unified report using the following structure:

```markdown
# 📊 [股票名称] ([股票代码]) 财务分析报告

> 分析日期：YYYY-MM-DD | 数据来源：cninfo.com.cn 年报

---

## 🔍 一、快速排雷检查

[Analysis A result]

---

## 💰 二、现金流肖像分析

[Analysis B result]

---

## 📈 三、近5年利润质量

[Analysis D result]

---

## 💎 四、合理估值与击球区

[Analysis C result + real-time price from web_search]

---

## 🏁 综合结论

[Summary of all findings, overall health score, investment recommendation caveat]
```

Present the report using clear markdown formatting with datatable blocks where appropriate for financial data tables.

---

## Report Type Categories (A-share)

| Report Type | Category Code | Period |
| :--- | :--- | :--- |
| Annual | `category_ndbg_szsh` | Previous 5 years |
| Semi-Annual | `category_bndbg_szsh` | Current year |
| Q1 Report | `category_yjdbg_szsh` | Current year |
| Q3 Report | `category_sjdbg_szsh` | Current year |

## Dependencies

- Python 3.8+
- `httpx` package
- `markitdown` (built-in — comes with Craft Agent)

## Error Handling

| Error | Solution |
| :--- | :--- |
| Stock not found | Check if code is valid A-share or Hong Kong stock |
| No reports downloaded | The stock may be newly listed or cninfo API may have changed |
| PDF conversion fails | Try running `markitdown` individually on problematic files |
| `call_llm` timeout | Reduce content by focusing on key sections of the report |
| cninfo API returns empty | Cookies may have expired; the script uses hardcoded session cookies |

## Important Notes

- **Not investment advice**: All analysis is for educational/research purposes only
- **Report lag**: Annual reports are published March-April of the following year — data may be 3-4 months stale
- **Real-time data**: The valuation analysis requires a `web_search` for current stock price
- **Cookie dependency**: The cninfo download script uses hardcoded session cookies which may expire
