import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { resolveNLScreenerScript, runPython } from "./_utils.js";

const advancedScreenParams = Type.Object({
	scope: Type.Optional(
		Type.String({
			description: "筛选范围: all/hs300/zz500/zz1000/cyb/kcb/custom:code1,code2/industry:行业名/concept:概念名",
			default: "all",
		}),
	),
	conditions: Type.Array(
		Type.Object({
			type: Type.Union([Type.Literal("technical"), Type.Literal("fundamental"), Type.Literal("quote")]),
			indicator: Type.Optional(Type.String()),
			field: Type.Optional(Type.String()),
			params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			operator: Type.Optional(Type.String()),
			value: Type.Optional(Type.Unknown()),
			periods: Type.Optional(Type.Array(Type.String())),
		}),
		{ description: "筛选条件数组" },
	),
	targetCount: Type.Optional(Type.Number({ description: "期望返回的股票数量，如20", default: 50 })),
	autoTune: Type.Optional(Type.Boolean({ description: "是否自动调整参数以接近target_count", default: true })),
	scoring: Type.Optional(
		Type.Object(
			{
				weights: Type.Record(Type.String(), Type.Number(), {
					description: "指标权重，如 {ma_cross: 30, macd_cross: 30}",
				}),
				minScore: Type.Optional(Type.Number({ description: "最低得分要求", default: 0 })),
			},
			{ description: "多指标共振评分配置（可选）。设置后，被weight的指标变为评分项而非硬性条件" },
		),
	),
});

interface AdvancedScreenDetails {
	total_checked: number;
	matched: number;
	screen_time: string;
	results: Array<{
		code: string;
		name?: string;
		signals: Record<string, { detail: string; score?: number }>;
	}>;
}

function formatScreeningResult(data: unknown): string {
	const d = data as AdvancedScreenDetails;
	if (!d.results || d.results.length === 0) return "未找到符合条件的股票。";
	const lines: string[] = [
		`【智能筛选结果】检查 ${d.total_checked} 只，匹配 ${d.matched} 只`,
		`筛选时间: ${d.screen_time}`,
		"",
	];
	for (const r of d.results) {
		const signals = Object.entries(r.signals)
			.map(([k, v]) => `${k}:${v.detail}`)
			.join(" | ");
		lines.push(`${r.code} ${r.name || ""} | ${signals}`);
	}
	return lines.join("\n");
}

export const advancedScreenTool: AgentTool<typeof advancedScreenParams, AdvancedScreenDetails> = {
	name: "advanced_screen",
	label: "高级选股",
	description: `技术指标+基本面组合选股。支持MA/MACD金叉死叉、RSI超买超卖、布林带收缩放量、市值/PE/PB等条件组合。数据来自本地数据库，缺失时自动同步。

筛选条件JSON格式示例:
{
  "scope": "all",
  "conditions": [
    {"type": "technical", "indicator": "ma_cross", "params": {"fast": 5, "slow": 10, "cross_type": "golden"}, "periods": ["daily"]},
    {"type": "fundamental", "field": "market_cap", "operator": ">=", "value": 10000000000}
  ]
}

技术指标:
- ma_cross: MA均线交叉, params: {fast, slow, cross_type: "golden"|"death"}
- ma_trend: 均线多头排列/空头排列, params: {fast, mid, slow, trend: "bull"|"bear"}
- macd_cross: MACD交叉, params: {cross_type: "golden"|"death"}
- macd_status: MACD状态, params: {status: "near_golden"|"bullish_divergence", threshold}
- rsi: RSI指标, params: {period, operator: ">"|"<"|">="|"<=", value}
- bollinger_squeeze: 布林带收缩后放量突破, params: {bb_period, std_dev, squeeze_days, reference_days, squeeze_threshold, expansion_lookback, volume_period, volume_ratio}
- volume_price: 量价关系, params: {pattern: "volume_surge"|"volume_shrink", ma_period, ratio}
- bias: 均线乖离率, params: {ma_period, operator, value}
- candlestick: K线形态, params: {pattern: "hammer"|"bullish_engulfing"|"doji"}

行情字段 (quotes表):
- market_cap (总市值, 亿元), pe, pb, change_pct (涨跌幅%)
- turnover (换手率%), volume (成交量), latest (最新价)
- high_52w (52周最高), low_52w (52周最低)
- total_cap (总市值), float_cap (流通市值)

基本面字段 (fundamentals表, 最新财报期):
利润表: total_revenue (营业总收入), operate_revenue (营业收入), operate_cost (营业成本), total_operate_cost (营业总成本),
        operate_profit (营业利润), total_profit (利润总额), net_profit (净利润), parent_net_profit (归母净利润),
        eps (基本每股收益), diluted_eps (稀释每股收益), research_expense (研发费用), sale_expense (销售费用),
        manage_expense (管理费用), finance_expense (财务费用), interest_expense (利息费用), income_tax (所得税费用)
资产负债表: total_assets (资产总计), total_liabilities (负债合计), total_equity (所有者权益), parent_equity (归母权益),
            total_current_assets (流动资产), total_current_liab (流动负债), inventory (存货), accounts_rece (应收账款),
            fixed_asset (固定资产), short_loan (短期借款), long_loan (长期借款), total_noncurrent_liab (非流动负债),
            monetary_funds (货币资金)
现金流量表: operate_cash_flow (经营现金流), invest_cash_flow (投资现金流), finance_cash_flow (筹资现金流),
            net_cash_increase (现金净增加额), construct_long_asset (购建固定资产支付)

动态计算指标: roe (净资产收益率% = 归母净利润/归母权益), gross_margin (毛利率% = (营业收入-营业成本)/营业收入)

操作符: >, <, >=, <=, ==, between
周期: daily, weekly, monthly
范围: all, hs300, zz500, zz1000, cyb, kcb, custom:code1,code2, industry:行业名(如"食品饮料I"), concept:概念名(如"石墨烯")

结果数量控制:
- target_count: 期望返回的股票数量（如20）
- auto_tune: true时自动调整参数阈值以接近target_count；false时直接按评分截断

多指标共振评分 (scoring):
- weights: {"指标名": 权重值, ...} — 将指定指标从硬性条件转为评分项
- min_score: 最低总得分要求（默认0）
- 示例: scoring={weights:{ma_cross:30,macd_cross:30,rsi:20,volume_surge:20}, min_score:70}
- 评分模式下，未被weight的指标仍为硬性条件，被weight的指标通过则加对应分数，最终按总分截断`,
	parameters: advancedScreenParams,
	execute: async (_id, params) => {
		const config: Record<string, unknown> = {
			scope: params.scope || "all",
			conditions: params.conditions || [],
			target_count: params.targetCount,
			auto_tune: params.autoTune,
		};

		if (params.scoring) {
			config.scoring = {
				weights: params.scoring.weights,
				min_score: params.scoring.minScore ?? 0,
			};
		}

		const tmpDir = mkdtempSync(join(tmpdir(), "screen-"));
		const configPath = join(tmpDir, "config.json");
		const outputPath = join(tmpDir, "result.json");

		try {
			writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

			const timeoutMs = params.autoTune ? 120000 : 30000;
			await runPython(
				resolveNLScreenerScript("screen.py"),
				["--config", configPath, "--output", outputPath],
				timeoutMs,
			);

			const raw = readFileSync(outputPath, "utf-8");
			let result: unknown;
			try {
				result = JSON.parse(raw);
			} catch (e) {
				throw new Error(`Failed to parse screening result: ${e instanceof Error ? e.message : String(e)}`);
			}

			return {
				content: [{ type: "text", text: formatScreeningResult(result) }],
				details: result as AdvancedScreenDetails,
			};
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	},
};
