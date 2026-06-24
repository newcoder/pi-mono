import type { StrategyType } from "../backtest/types.js";
import type { MultiFactorContext } from "./multifactor.js";
import type { MarketRegime, TradingIdea } from "./types.js";

const CLASSIC_STRATEGIES: StrategyType[] = [
	"ma_cross",
	"macd_cross",
	"rsi_reversal",
	"bollinger_breakout",
	"supertrend",
];

function makeId(): string {
	return Math.random().toString(36).slice(2, 10);
}

function confidenceScore(base: number, regime: MarketRegime, supportingFactors: string[]): number {
	let score = base;
	for (const factor of supportingFactors) {
		if (factor.startsWith("ic_")) {
			const snap = regime.factorIcSnapshot[factor.slice(3)];
			if (snap?.direction === "positive") score += 15;
			if (snap?.direction === "negative") score -= 10;
			// Reward statistically robust IC: IR > 0.5 or hit rate > 55%
			if (snap && snap.ir > 0.5) score += 10;
			if (snap && snap.hitRate > 0.55) score += 5;
		}
		if (factor === "sentiment_bullish" && (regime.sentimentIndex ?? 50) > 60) score += 10;
		if (factor === "sentiment_bearish" && (regime.sentimentIndex ?? 50) < 40) score += 10;
		if (factor === "high_volatility" && (regime.volatilityProxy ?? 0) > 3) score += 10;
		if (factor === "momentum_aligned" && regime.subRegimes.includes("strong_momentum")) score += 10;
		if (factor === "sample_large" && regime.topIndustries.length >= 3) score += 10;
	}
	return Math.min(100, Math.max(0, score));
}

function buildSnapshot(regime: MarketRegime, sampleSize: number): TradingIdea["dataSnapshot"] {
	const factorIcDirection: Record<string, number> = {};
	for (const [name, snap] of Object.entries(regime.factorIcSnapshot)) {
		factorIcDirection[name] = snap.avg20d;
	}
	return {
		lookbackDays: 0, // filled by caller
		latestDate: regime.latestDate,
		topIndustries: regime.topIndustries.map((i) => i.name),
		factorIcDirection,
		sentimentIndex: regime.sentimentIndex,
		sectorRotationHot: regime.subRegimes.includes("strong_momentum") ? regime.topIndustries.map((i) => i.name) : [],
		sampleSize,
	};
}

export function generateIdeas(
	regime: MarketRegime,
	categories: string[],
	maxIdeas: number,
	multiFactorContext?: MultiFactorContext | null,
): TradingIdea[] {
	const candidates: TradingIdea[] = [];

	// ─── Market style / industry momentum ─────────────────────────────
	if (categories.includes("market_style")) {
		const industryMomentum = regime.factorIcSnapshot.industry_momentum_20d_forward5d;
		if (
			regime.subRegimes.includes("strong_momentum") &&
			regime.topIndustries.length > 0 &&
			industryMomentum?.avg20d > 0
		) {
			const topNames = regime.topIndustries.map((i) => i.name).join("、");
			candidates.push({
				id: makeId(),
				hypothesis: `申万一级动量行业（${topNames}）近期动量有效，跟随趋势持有至动量衰减`,
				rationale: `过去20日行业动量因子IC均值为${industryMomentum.avg20d.toFixed(3)}，动量效应显著。前5动量行业平均动量收益${(avg(regime.topIndustries.map((i) => i.momentumReturn)) * 100).toFixed(1)}%，适合趋势跟踪策略。`,
				category: "market_style",
				timeframe: "short_term",
				entryCriteria: "行业动量因子滚动IC > 0.05，且个股所属行业进入前5动量行业",
				exitCriteria: "行业动量排名跌出前10或滚动IC回落至0以下",
				universeFilter: `申万一级行业排名前5的股票：${topNames}`,
				suggestedStrategy: {
					strategy: "supertrend",
					params: { atrPeriod: 10, multiplier: 3 },
					industryFilter: {
						standard: "sw_l1",
						periodDays: 20,
						topIndustryCount: 5,
						icPeriodDays: 20,
						icThreshold: 0.05,
					},
				},
				confidence: confidenceScore(50, regime, [
					"ic_industry_momentum_20d_forward5d",
					"momentum_aligned",
					"sample_large",
				]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["动量因子可能突然反转", "集中度较高导致回撤放大"],
				invalidationConditions: ["行业动量IC连续5日低于0", "前5行业大幅轮换"],
				dataSnapshot: buildSnapshot(regime, regime.topIndustries.length * 50),
			});
		}

		if (regime.subRegimes.includes("small_cap_favored")) {
			candidates.push({
				id: makeId(),
				hypothesis: "小市值因子近期有效，精选小市值股票做反弹",
				rationale: `size_forward5d 滚动IC为${(regime.factorIcSnapshot.size_forward5d?.avg20d ?? 0).toFixed(3)}，小市值风格占优。`,
				category: "market_style",
				timeframe: "short_term",
				entryCriteria: "总市值排名后30%，且技术形态出现超卖或金叉",
				exitCriteria: "size因子IC转正或持仓达到最大持有天数",
				universeFilter: "全A股中市值最小的前100只",
				suggestedStrategy: {
					strategy: "rsi_reversal",
					params: { period: 14, oversold: 30, overbought: 70 },
					sizeFilter: {
						forwardDays: 5,
						topStockCount: 100,
						icPeriodDays: 20,
						icThreshold: -0.03,
						direction: "small",
					},
				},
				confidence: confidenceScore(50, regime, ["ic_size_forward5d", "sample_large"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["小市值流动性差", "退市风险高于大盘股"],
				invalidationConditions: ["size_forward5d IC连续5日高于-0.01", "市场风格切换至大市值"],
				dataSnapshot: buildSnapshot(regime, 100),
			});
		}

		if (regime.subRegimes.includes("large_cap_favored")) {
			candidates.push({
				id: makeId(),
				hypothesis: "大市值蓝筹风格占优，趋势跟踪龙头",
				rationale: `size_forward5d 滚动IC为${(regime.factorIcSnapshot.size_forward5d?.avg20d ?? 0).toFixed(3)}，大盘风格明显。`,
				category: "market_style",
				timeframe: "medium_term",
				entryCriteria: "总市值排名前10%，且MA短期上穿长期均线",
				exitCriteria: "MA死叉或size因子IC转负",
				universeFilter: "全A股中市值最大的前100只",
				suggestedStrategy: {
					strategy: "ma_cross",
					params: { fast: 5, slow: 20 },
					sizeFilter: {
						forwardDays: 5,
						topStockCount: 100,
						icPeriodDays: 20,
						icThreshold: 0.03,
						direction: "large",
					},
				},
				confidence: confidenceScore(50, regime, ["ic_size_forward5d", "sample_large"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["大盘补涨后轮动风险", "波动率较低收益空间有限"],
				invalidationConditions: ["size_forward5d IC回落至0以下", "市场成交量萎缩"],
				dataSnapshot: buildSnapshot(regime, 100),
			});
		}
	}

	// ─── Technical ────────────────────────────────────────────────────
	if (categories.includes("technical")) {
		if (regime.subRegimes.includes("high_volatility")) {
			candidates.push({
				id: makeId(),
				hypothesis: "近期行业振幅扩大，高波动环境下布林带突破策略可能有效",
				rationale: `最新行业平均振幅${(regime.volatilityProxy ?? 0).toFixed(2)}%，波动率处于高位，价格偏离度加大，适合布林带突破/均值回归。`,
				category: "technical",
				timeframe: "short_term",
				entryCriteria: "收盘价跌破布林带下轨后反弹站上中轨",
				exitCriteria: "价格上触布林带上轨或跌破下轨止损",
				universeFilter: "全A股中近20日振幅排名前20%的股票",
				suggestedStrategy: {
					strategy: "bollinger_breakout",
					params: { period: 20, stdDev: 2 },
				},
				confidence: confidenceScore(50, regime, ["high_volatility", "sample_large"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["高波动可能伴随假突破", "单边行情中布林带失效"],
				invalidationConditions: ["平均振幅回落至1.5%以下", "突破信号胜率连续低于40%"],
				dataSnapshot: buildSnapshot(regime, 1000),
			});
		}

		if (regime.subRegimes.includes("bearish_sentiment")) {
			candidates.push({
				id: makeId(),
				hypothesis: "市场情绪偏悲观，超卖反弹机会",
				rationale: `上涨个股比例${regime.sentimentIndex ?? 50}%，情绪指数低于40，短期存在超卖反弹机会。`,
				category: "technical",
				timeframe: "short_term",
				entryCriteria: "RSI(14)低于30且出现阳线反弹",
				exitCriteria: "RSI回升至50以上或亏损3%止损",
				universeFilter: "近5日跌幅居前且RSI进入超卖区的股票",
				suggestedStrategy: {
					strategy: "rsi_reversal",
					params: { period: 14, oversold: 30, overbought: 50 },
				},
				confidence: confidenceScore(50, regime, ["sentiment_bearish", "sample_large"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["情绪可能继续恶化", "抄底风险"],
				invalidationConditions: [" sentimentIndex 连续3日低于20", "市场出现恐慌性下跌"],
				dataSnapshot: buildSnapshot(regime, 500),
			});
		}

		if (regime.subRegimes.includes("bullish_sentiment")) {
			candidates.push({
				id: makeId(),
				hypothesis: "市场情绪积极，趋势跟踪顺势交易",
				rationale: `上涨个股比例${regime.sentimentIndex ?? 50}%，情绪指数高于60，适合顺势交易。`,
				category: "technical",
				timeframe: "short_term",
				entryCriteria: "短期MA上穿长期MA且成交量放大",
				exitCriteria: "MA死叉或情绪指数回落至50以下",
				universeFilter: "近5日涨幅居前且成交量放大的股票",
				suggestedStrategy: {
					strategy: "ma_cross",
					params: { fast: 5, slow: 20 },
				},
				confidence: confidenceScore(50, regime, ["sentiment_bullish", "sample_large"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["情绪过热后回调", "追涨风险"],
				invalidationConditions: ["sentimentIndex 连续3日低于55", "领涨板块大幅回调"],
				dataSnapshot: buildSnapshot(regime, 500),
			});
		}
	}

	// ─── Fundamental / valuation ──────────────────────────────────────
	if (categories.includes("fundamental")) {
		candidates.push({
			id: makeId(),
			hypothesis: "低估值、高现金流的健康公司存在均值回归机会",
			rationale: "市场震荡期基本面稳健的低估标的更易获得防御性收益，适合RSI超卖买入。",
			category: "fundamental",
			timeframe: "medium_term",
			entryCriteria: "PE < 行业均值30%，PB < 2，经营现金流为正，RSI(14) < 40",
			exitCriteria: "估值修复至行业均值或RSI > 65",
			universeFilter: "全A股中PE、PB双低且现金流健康的股票",
			suggestedStrategy: {
				strategy: "rsi_reversal",
				params: { period: 14, oversold: 40, overbought: 65 },
			},
			confidence: confidenceScore(50, regime, ["sample_large"]),
			feasibility: { pass: true, reason: "待检查" },
			risks: ["价值陷阱", "估值中枢下移"],
			invalidationConditions: ["所选标的盈利预期下调", "行业景气度持续恶化"],
			dataSnapshot: buildSnapshot(regime, 200),
		});

		candidates.push({
			id: makeId(),
			hypothesis: "高成长公司（营收/净利润3年CAGR高）趋势延续",
			rationale: "成长因子在景气向上阶段通常有正反馈，适合均线趋势跟踪。",
			category: "fundamental",
			timeframe: "medium_term",
			entryCriteria: "净利润3年CAGR > 20%，ROE > 10%，短期均线上穿长期均线",
			exitCriteria: "MA死叉或季度业绩增速显著放缓",
			universeFilter: "全A股中营收/净利润CAGR排名前10%的成长股",
			suggestedStrategy: {
				strategy: "ma_cross",
				params: { fast: 10, slow: 30 },
			},
			confidence: confidenceScore(50, regime, ["sample_large"]),
			feasibility: { pass: true, reason: "待检查" },
			risks: ["成长股估值波动大", "业绩不及预期风险"],
			invalidationConditions: ["最新季度净利润同比下滑", "行业景气度指标转负"],
			dataSnapshot: buildSnapshot(regime, 200),
		});
	}

	// ─── Event / sentiment ────────────────────────────────────────────
	if (categories.includes("event")) {
		candidates.push({
			id: makeId(),
			hypothesis: "政策/行业利好事件驱动下，热点板块短期脉冲",
			rationale: "事件驱动策略依赖新闻情绪和板块联动，适合在市场情绪积极时跟随热点。",
			category: "event",
			timeframe: "short_term",
			entryCriteria: "近3日有相关利好新闻，板块涨幅前5，MACD金叉",
			exitCriteria: "新闻热度消退或MACD死叉",
			universeFilter: "近期有政策/行业利好新闻的概念板块成分股",
			suggestedStrategy: {
				strategy: "macd_cross",
				params: { fast: 12, slow: 26, signal: 9 },
			},
			confidence: confidenceScore(45, regime, ["sentiment_bullish", "sample_large"]),
			feasibility: { pass: true, reason: "待检查" },
			risks: ["事件热度难以量化", "利好兑现后回调"],
			invalidationConditions: ["相关板块成交量萎缩", "市场情绪指数回落至50以下"],
			dataSnapshot: buildSnapshot(regime, 300),
		});
	}

	// ─── Multi-factor composite ───────────────────────────────────────
	if (categories.includes("multifactor") && multiFactorContext) {
		const topNames = multiFactorContext.topScores
			.slice(0, 10)
			.map((s) => s.name ?? s.code)
			.join("、");
		candidates.push({
			id: makeId(),
			hypothesis: "价值/动量/质量/低波动四因子综合评分最高的股票组合存在超额收益机会",
			rationale: `基于 ${multiFactorContext.latestDate} 数据，对全 A 股计算价值（1/PE、1/PB）、动量（${multiFactorContext.lookbackDays}日收益）、质量（ROE）、低波动（负年化波动率）四因子，Z-score 等权合成后排名前 ${multiFactorContext.topScores.length} 的股票构成选股池。`,
			category: "market_style",
			timeframe: "medium_term",
			entryCriteria: "多因子综合评分排名前10%，且短期均线呈多头排列",
			exitCriteria: "综合评分跌出前30%或均线死叉",
			universeFilter: `多因子综合评分前 ${multiFactorContext.topScores.length} 的股票：${topNames} 等`,
			suggestedStrategy: {
				strategy: "ma_cross",
				params: { fast: 10, slow: 30 },
			},
			confidence: confidenceScore(55, regime, ["ic_industry_momentum_20d_forward5d", "sample_large"]),
			feasibility: { pass: true, reason: "待检查" },
			risks: ["多因子组合可能暴露于共同的宏观风险", "因子轮动导致某阶段失效"],
			invalidationConditions: ["价值/动量/质量因子IC同时转负", "组合回撤超过15%"],
			dataSnapshot: buildSnapshot(regime, multiFactorContext.scores.length),
		});
	}

	// ─── Classic strategies ───────────────────────────────────────────
	if (categories.includes("classic")) {
		for (const strategy of CLASSIC_STRATEGIES) {
			const idea = classicIdea(strategy, regime);
			if (idea) candidates.push(idea);
		}
	}

	// Fill lookbackDays in snapshot from a placeholder (caller will override)
	for (const idea of candidates) {
		idea.dataSnapshot.lookbackDays = 0;
	}

	return candidates.slice(0, maxIdeas * 2);
}

function classicIdea(strategy: StrategyType, regime: MarketRegime): TradingIdea | null {
	const industryMomentum = regime.factorIcSnapshot.industry_momentum_20d_forward5d;
	const size5d = regime.factorIcSnapshot.size_forward5d;

	switch (strategy) {
		case "ma_cross": {
			const bullish = regime.subRegimes.includes("bullish_sentiment") || industryMomentum?.direction === "positive";
			if (!bullish) return null;
			return {
				id: makeId(),
				hypothesis: "经典双均线金叉策略：短期均线上穿长期均线买入",
				rationale: "当前市场情绪或行业动量偏正面，趋势跟踪胜率较高。",
				category: "classic",
				timeframe: "short_term",
				entryCriteria: "MA5上穿MA20",
				exitCriteria: "MA5下穿MA20",
				universeFilter: "全A股",
				suggestedStrategy: { strategy: "ma_cross", params: { fast: 5, slow: 20 } },
				confidence: confidenceScore(55, regime, ["ic_industry_momentum_20d_forward5d", "sentiment_bullish"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["震荡市产生频繁假信号", "滞后性"],
				invalidationConditions: ["市场进入高波动区间", "动量IC转负"],
				dataSnapshot: buildSnapshot(regime, 5000),
			};
		}
		case "macd_cross": {
			const bullish = regime.subRegimes.includes("bullish_sentiment") || size5d?.direction === "negative";
			if (!bullish) return null;
			return {
				id: makeId(),
				hypothesis: "经典MACD金叉策略：DIF上穿DEA买入",
				rationale: "市场情绪积极或小市值风格活跃时，MACD金叉对短期动能敏感。",
				category: "classic",
				timeframe: "short_term",
				entryCriteria: "DIF上穿DEA且MACD柱由负转正",
				exitCriteria: "DIF下穿DEA",
				universeFilter: "全A股",
				suggestedStrategy: { strategy: "macd_cross", params: { fast: 12, slow: 26, signal: 9 } },
				confidence: confidenceScore(55, regime, ["sentiment_bullish", "ic_size_forward5d"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["震荡市频繁交叉", "信号滞后"],
				invalidationConditions: ["市场情绪指数回落至50以下", "size IC转正"],
				dataSnapshot: buildSnapshot(regime, 5000),
			};
		}
		case "rsi_reversal": {
			const oversoldEnv =
				regime.subRegimes.includes("bearish_sentiment") || regime.subRegimes.includes("high_volatility");
			if (!oversoldEnv) return null;
			return {
				id: makeId(),
				hypothesis: "经典RSI超卖反转策略：RSI低于阈值后买入",
				rationale: "当前情绪悲观或波动率高，超卖反转概率提升。",
				category: "classic",
				timeframe: "short_term",
				entryCriteria: "RSI(14) < 30后出现阳线",
				exitCriteria: "RSI > 50或亏损3%止损",
				universeFilter: "全A股",
				suggestedStrategy: { strategy: "rsi_reversal", params: { period: 14, oversold: 30, overbought: 50 } },
				confidence: confidenceScore(55, regime, ["sentiment_bearish", "high_volatility"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["下跌趋势中抄底风险", "假反弹"],
				invalidationConditions: ["市场出现系统性下跌", "情绪指数持续低于20"],
				dataSnapshot: buildSnapshot(regime, 5000),
			};
		}
		case "bollinger_breakout": {
			if (!regime.subRegimes.includes("high_volatility")) return null;
			return {
				id: makeId(),
				hypothesis: "经典布林带突破策略：价格触及下轨后反弹",
				rationale: "高波动环境下价格围绕布林带上下轨运动，突破/回归信号更明确。",
				category: "classic",
				timeframe: "short_term",
				entryCriteria: "收盘价跌破布林带下轨后重新站上中轨",
				exitCriteria: "价格上触上轨或重新跌破下轨止损",
				universeFilter: "全A股",
				suggestedStrategy: { strategy: "bollinger_breakout", params: { period: 20, stdDev: 2 } },
				confidence: confidenceScore(55, regime, ["high_volatility"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["假突破", "波动率突然下降"],
				invalidationConditions: ["平均振幅回落至1.5%以下", "布林带宽度收窄"],
				dataSnapshot: buildSnapshot(regime, 5000),
			};
		}
		case "supertrend": {
			if (industryMomentum?.direction !== "positive" && !regime.subRegimes.includes("bullish_sentiment"))
				return null;
			return {
				id: makeId(),
				hypothesis: "经典Supertrend趋势跟踪：转多买入，转空卖出",
				rationale: "市场存在明确趋势时，Supertrend能有效过滤噪音。",
				category: "classic",
				timeframe: "short_term",
				entryCriteria: "Supertrend由空头转为多头",
				exitCriteria: "Supertrend由多头转为空头",
				universeFilter: "全A股",
				suggestedStrategy: { strategy: "supertrend", params: { atrPeriod: 10, multiplier: 3 } },
				confidence: confidenceScore(55, regime, ["ic_industry_momentum_20d_forward5d", "sentiment_bullish"]),
				feasibility: { pass: true, reason: "待检查" },
				risks: ["震荡市频繁止损", "参数敏感"],
				invalidationConditions: ["行业动量IC转负", "市场进入横盘震荡"],
				dataSnapshot: buildSnapshot(regime, 5000),
			};
		}
		default:
			return null;
	}
}

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}
