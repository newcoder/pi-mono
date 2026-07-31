import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPORTS_DIR = join(homedir(), ".trading-agent", "reports");
const INDEX_PATH = join(REPORTS_DIR, "_index.json");

export interface ReportEntry {
	fileName: string;
	title: string;
	poolId: number;
	poolName: string;
	strategy: string;
	startDate: string;
	endDate: string;
	initialCapital: number;
	createdAt: string;
	/** Key backtest metrics for display in the report list */
	metrics: {
		totalReturn: number;
		annualizedReturn: number;
		maxDrawdown: number;
		winRate: number;
		totalTrades: number;
		sharpeRatio: number;
		profitFactor: number;
	};
	/** Full backtest config — restored on double-click for re-run */
	config: Record<string, unknown>;
}

function loadIndex(): ReportEntry[] {
	try {
		if (!existsSync(INDEX_PATH)) return [];
		const raw = readFileSync(INDEX_PATH, "utf-8");
		return JSON.parse(raw) as ReportEntry[];
	} catch {
		return [];
	}
}

function saveIndex(entries: ReportEntry[]): void {
	writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

export function listReports(): ReportEntry[] {
	return loadIndex().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addReport(entry: ReportEntry): void {
	const entries = loadIndex();
	entries.push(entry);
	saveIndex(entries);
}

export function removeReport(fileName: string): boolean {
	const entries = loadIndex();
	const idx = entries.findIndex((e) => e.fileName === fileName);
	if (idx === -1) return false;
	entries.splice(idx, 1);
	saveIndex(entries);

	// Delete the HTML file
	try {
		const filePath = join(REPORTS_DIR, fileName);
		if (existsSync(filePath)) unlinkSync(filePath);
	} catch {
		// File already gone or permission error — index is already updated
	}
	return true;
}
