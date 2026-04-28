import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/user-config.js";
import type { TradingSession } from "./trading-session.js";

export interface DailySummary {
	date: string;
	messageCount: number;
	keyDecisions: string[];
	reflection: string;
}

const MEMORY_DIR = join(getConfigDir(), "memory");

function ensureDir() {
	if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function getSummaryPath(date: string): string {
	return join(MEMORY_DIR, `${date}.json`);
}

function isValidDailySummary(data: unknown): data is DailySummary {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.date === "string" &&
		typeof d.messageCount === "number" &&
		Array.isArray(d.keyDecisions) &&
		d.keyDecisions.every((k) => typeof k === "string") &&
		typeof d.reflection === "string"
	);
}

export class SessionMemory {
	private summaries: DailySummary[] = [];

	constructor() {
		this.loadFromDisk();
	}

	async dailyCompaction(session: TradingSession): Promise<DailySummary> {
		const date = new Date().toISOString().slice(0, 10);
		const messages = session.messages;

		// Extract key decisions: find assistant messages containing trading keywords
		const keyDecisions: string[] = [];
		for (const msg of messages) {
			const text = this.extractText(msg);
			if (text && /(分析|结论|筛选|选股|回测|策略|估值|风险|趋势|因子|板块|对比|评估)/.test(text)) {
				const snippet = text.replace(/\s+/g, " ").slice(0, 120);
				if (snippet.length > 10) keyDecisions.push(snippet);
			}
		}
		// Deduplicate, keep max 10
		const uniqueDecisions = [...new Set(keyDecisions)].slice(0, 10);

		// Reflection is filled by the caller (post-market routine)
		const summary: DailySummary = {
			date,
			messageCount: messages.length,
			keyDecisions: uniqueDecisions,
			reflection: "",
		};

		this.summaries.push(summary);
		this.saveSummary(summary);
		return summary;
	}

	updateReflection(date: string, reflection: string): void {
		const s = this.summaries.find((x) => x.date === date);
		if (s) {
			s.reflection = reflection;
			this.saveSummary(s);
		}
	}

	getRecentSummaries(days: number = 7): DailySummary[] {
		return this.summaries.slice(-days);
	}

	getContextString(days: number = 7): string {
		const recent = this.getRecentSummaries(days);
		if (recent.length === 0) return "";
		const parts = recent.map(
			(s) => `=== ${s.date} ===\n${s.reflection}\n关键决策: ${s.keyDecisions.join("; ") || "无"}`,
		);
		return `\n\n[近期分析记忆]\n${parts.join("\n\n")}`;
	}

	private saveSummary(summary: DailySummary): void {
		ensureDir();
		writeFileSync(getSummaryPath(summary.date), JSON.stringify(summary, null, 2), "utf-8");
	}

	private loadFromDisk(): void {
		if (!existsSync(MEMORY_DIR)) return;
		const files = readdirSync(MEMORY_DIR)
			.filter((f) => f.endsWith(".json"))
			.sort();
		for (const file of files) {
			try {
				const data = JSON.parse(readFileSync(join(MEMORY_DIR, file), "utf-8"));
				if (isValidDailySummary(data)) {
					this.summaries.push(data);
				} else {
					console.warn(`[SessionMemory] Skipping invalid summary file: ${file}`);
				}
			} catch {
				// ignore corrupt files
			}
		}
	}

	private extractText(msg: any): string {
		if (!msg.content) return "";
		return msg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
	}
}
