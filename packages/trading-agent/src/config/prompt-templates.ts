import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./user-config.js";

const PROMPTS_DIR = join(getConfigDir(), "prompts");

function loadTemplate(name: string, fallback: string): string {
	const path = join(PROMPTS_DIR, `${name}.md`);
	if (existsSync(path)) {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			// fallback
		}
	}
	return fallback;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(vars)) {
		result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
	}
	return result;
}

const DEFAULT_PRE_MARKET = `今天是 {{date}}。

你是专业盘前分析师。请严格基于以下提供的数据生成简报，禁止编造任何未提供的数据。

## 隔夜外围市场数据
{{macro_data}}

## 市场宏观新闻（最近24小时）
{{market_news}}

## 市场情绪快照
{{market_sentiment}}

## 板块轮动热力
{{sector_rotation}}

## 关注股票行情
{{watchlist_data}}

## 近期交易记忆
{{memory_context}}

请输出以下内容（控制在800字以内）：

### 1. 隔夜外围市场回顾
基于上述数据，客观总结美股、A50、汇率等走势。

### 2. 重大资讯与市场情绪
分析宏观数据和新闻传递的情绪（偏暖/偏空/中性），不要编造未提及的资讯。

### 3. 板块与行业影响
基于隔夜数据、新闻和板块热力，判断哪些板块可能受益或承压。

### 4. A股开盘前瞻
结合外围走势、新闻面和板块轮动，给出今日A股走势判断（高开/低开/平开/震荡）。

### 5. 关注股票简析
对每只关注股票给出开盘预期，引用实际价格数据。

⚠️ 免责声明：以上分析仅基于公开数据，不构成投资建议。`;

const DEFAULT_POST_MARKET = `今天是 {{date}}。

你是专业交易复盘师。请严格基于以下提供的今日实际数据做复盘，禁止引用任何未提供的数据，禁止提及早于 {{date}} 的市场事件。

## 今日板块轮动
{{sector_rotation}}

## 市场情绪快照
{{market_sentiment}}

## 市场宏观新闻（最近24小时）
{{market_news}}

## 今日关注股票表现
{{watchlist_data}}

## 今日关键决策记录
{{key_decisions}}

## 近期交易记忆
{{memory_context}}

请输出以下内容（控制在800字以内）：

### 1. 今日市场回顾
基于板块数据和新闻，客观回顾主要指数和板块的涨跌情况，引用实际涨跌幅数字。分析领涨/领跌板块的驱动因素。

### 2. 重大资讯影响评估
回顾今日重要新闻对市场和板块的实际影响，验证盘前预判是否准确。

### 3. 关注股票今日表现
逐只分析 watchlist 中股票的涨跌原因，引用实际收盘价、涨跌幅、成交额。

### 4. 关键决策验证
如果今日有做出买卖/持有/观望建议，对照今日实际走势验证这些建议是否合理。

### 5. 问题与反思
今日分析中存在的偏差、遗漏或过度推断，以及模型自身的局限。

### 6. 明日关注计划
基于今日收盘数据和新闻面，列出明天需要跟踪的具体事项（价格点位、成交量、板块动向、潜在风险事件等）。

⚠️ 免责声明：以上复盘仅基于公开数据，不构成投资建议。

【重要约束】今天是 {{date}}，所有分析必须基于 {{date}} 及之前的数据，禁止引用春节、两会等已过时的事件。`;

export function loadPreMarketTemplate(): string {
	return loadTemplate("pre-market", DEFAULT_PRE_MARKET);
}

export function loadPostMarketTemplate(): string {
	return loadTemplate("post-market", DEFAULT_POST_MARKET);
}
