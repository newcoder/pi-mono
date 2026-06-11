import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPORT_TEMPLATE } from "./template.js";

// ─── Report Types ─────────────────────────────────────────────────

export interface ReportTrade {
	date: string;
	code?: string;
	direction: "buy" | "sell";
	quantity: number;
	price: number;
	amount?: number;
	holdingDays?: number;
	pnl?: number;
	pnlPct?: number;
	memo?: string;
}

export interface ReportMetrics {
	totalReturn: number;
	annualizedReturn: number;
	sharpeRatio: number;
	maxDrawdown: number;
	maxDrawdownDuration?: number;
	winRate?: number;
	profitFactor?: number;
	avgWin?: number;
	avgLoss?: number;
	avgHoldingDays?: number;
	totalTrades?: number;
}

export interface ReportEquityPoint {
	date: string;
	equity: number;
}

export interface ReportData {
	title: string;
	strategy?: string;
	code?: string;
	market?: string;
	startDate: string;
	endDate: string;
	initialCapital: number;
	equityCurve: ReportEquityPoint[];
	trades: ReportTrade[];
	metrics: ReportMetrics;
}

// ─── Report Generator ─────────────────────────────────────────────

export interface GenerateReportResult {
	filePath: string;
	url: string;
}

export async function generateReport(
	data: ReportData,
	outputDir: string,
	baseUrl: string,
): Promise<GenerateReportResult> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const safeTitle = data.title.replace(/[^\w一-龥-]/g, "_").slice(0, 30);
	const fileName = `${timestamp}_${safeTitle}.html`;
	const filePath = join(outputDir, fileName);

	// Ensure output directory exists
	mkdirSync(outputDir, { recursive: true });

	// Build template
	const html = fillTemplate(REPORT_TEMPLATE, data);
	await writeFile(filePath, html, "utf-8");

	return {
		filePath,
		url: `${baseUrl}/reports/${fileName}`,
	};
}

function fillTemplate(template: string, data: ReportData): string {
	const reportData: ReportData & { generatedAt: string } = {
		...data,
		generatedAt: new Date().toLocaleString("zh-CN"),
	};

	return template
		.replace(/{{TITLE}}/g, escapeHtml(data.title))
		.replace(/{{DATE_RANGE}}/g, `${data.startDate} ~ ${data.endDate}`)
		.replace(/{{INITIAL_CAPITAL}}/g, data.initialCapital.toLocaleString("zh-CN"))
		.replace(/{{STRATEGY}}/g, escapeHtml(data.strategy || "策略回测"))
		.replace(/{{GENERATED_AT}}/g, reportData.generatedAt)
		.replace(/{{REPORT_DATA}}/g, JSON.stringify(reportData));
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
