import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { generateReport, type ReportData } from "../report/generator.js";

// ─── generate_report tool ───────────────────────────────────────────────────

const reportParams = Type.Object({
	title: Type.String({ description: "报告标题" }),
	strategy: Type.Optional(Type.String({ description: "策略名称" })),
	code: Type.Optional(Type.String({ description: "股票代码" })),
	market: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(0)], { description: "1=上海, 0=深圳" })),
	start_date: Type.String({ description: "起始日期 YYYY-MM-DD" }),
	end_date: Type.String({ description: "结束日期 YYYY-MM-DD" }),
	initial_capital: Type.Number({ description: "初始资金" }),
	equity_curve: Type.Array(
		Type.Object({
			date: Type.String(),
			equity: Type.Number(),
		}),
		{ description: "权益曲线数据点数组" },
	),
	trades: Type.Array(
		Type.Object({
			date: Type.String(),
			code: Type.Optional(Type.String()),
			direction: Type.Union([Type.Literal("buy"), Type.Literal("sell")]),
			quantity: Type.Number(),
			price: Type.Number(),
			amount: Type.Optional(Type.Number()),
			holdingDays: Type.Optional(Type.Number()),
			pnl: Type.Optional(Type.Number()),
			pnlPct: Type.Optional(Type.Number()),
			memo: Type.Optional(Type.String()),
		}),
		{ description: "交易记录数组" },
	),
	metrics: Type.Object({
		totalReturn: Type.Number({ description: "总收益率 (%)" }),
		annualizedReturn: Type.Number({ description: "年化收益率 (%)" }),
		sharpeRatio: Type.Number({ description: "夏普比率" }),
		maxDrawdown: Type.Number({ description: "最大回撤 (%)" }),
		maxDrawdownDuration: Type.Optional(Type.Number({ description: "最大回撤天数" })),
		winRate: Type.Optional(Type.Number({ description: "胜率 (%)" })),
		profitFactor: Type.Optional(Type.Number({ description: "盈亏比" })),
		avgWin: Type.Optional(Type.Number({ description: "平均盈利" })),
		avgLoss: Type.Optional(Type.Number({ description: "平均亏损" })),
		avgHoldingDays: Type.Optional(Type.Number({ description: "平均持仓天数" })),
		totalTrades: Type.Optional(Type.Number({ description: "总交易次数" })),
	}),
});

export const generateReportTool: AgentTool<typeof reportParams, { filePath?: string; url?: string; error?: string }> = {
	name: "generate_report",
	label: "生成回测报告",
	description:
		"将回测结果生成独立的 HTML 报告文件。报告包含收益曲线图、回撤曲线、月度收益热力图、关键绩效指标卡片和调仓明细表。生成的报告为单文件 HTML，可下载分享。",
	parameters: reportParams,
	execute: async (_id, params) => {
		const reportData: ReportData = {
			title: params.title,
			strategy: params.strategy,
			code: params.code,
			market: params.market === 1 ? "SH" : params.market === 0 ? "SZ" : undefined,
			startDate: params.start_date,
			endDate: params.end_date,
			initialCapital: params.initial_capital,
			equityCurve: params.equity_curve,
			trades: params.trades,
			metrics: params.metrics,
		};

		const outputDir = join(homedir(), ".trading-agent", "reports");
		const baseUrl = "http://localhost:3000";

		try {
			const result = await generateReport(reportData, outputDir, baseUrl);
			return {
				content: [
					{
						type: "text",
						text: `报告已生成：[${params.title}](${result.url})`,
					},
				],
				details: result,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text", text: `生成报告失败：${msg}` }],
				details: { error: msg },
			};
		}
	},
};
