import type { Component } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { resolveAShareScript, runJsonScript } from "../tools/_utils.js";

export interface IndexQuote {
	code: string;
	name: string;
	price: number;
	change_pct: number;
}

export class IndexQuotesBar implements Component {
	private quotes: IndexQuote[] = [];
	private fetching = false;

	update(quotes: IndexQuote[]): void {
		this.quotes = quotes;
	}

	async refresh(): Promise<void> {
		if (this.fetching) return;
		this.fetching = true;
		try {
			const scriptPath = resolveAShareScript("index_quote_fetcher.py");
			const data: IndexQuote[] = await runJsonScript(scriptPath, [], 30000);
			if (Array.isArray(data) && data.length > 0) {
				this.quotes = data;
			}
		} catch (_e) {
			// Silently fail - keep previous quotes or empty
		} finally {
			this.fetching = false;
		}
	}

	render(width: number): string[] {
		if (this.quotes.length === 0) {
			return [chalk.gray("  指数行情: 加载中...".slice(0, width))];
		}

		const segments: string[] = [];
		for (const q of this.quotes) {
			const sign = q.change_pct >= 0 ? "▲" : "▼";
			// A-share convention: red for up, green for down
			const colorFn = q.change_pct > 0 ? chalk.red : q.change_pct < 0 ? chalk.green : chalk.gray;
			segments.push(colorFn(`${q.name} ${q.price.toFixed(2)} ${sign}${q.change_pct.toFixed(2)}%`));
		}

		const line = `  ${segments.join("  ")}`;
		return [line.slice(0, width)];
	}

	handleInput?(_data: string): void {
		// No input handling
	}

	invalidate(): void {
		// No cached state
	}
}
