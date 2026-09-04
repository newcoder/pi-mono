import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import chalk from "chalk";

export interface SectorData {
	name: string;
	change_pct: number;
}

export interface SentimentData {
	advance: number;
	decline: number;
	flat: number;
	limitUp: number;
	limitDown: number;
	northboundFlow: number;
	sentimentIndex: number;
	topSectors?: SectorData[];
	bottomSectors?: SectorData[];
}

export class SentimentBar implements Component {
	private data: SentimentData | null = null;

	update(data: SentimentData): void {
		this.data = data;
	}

	render(width: number): string[] {
		if (!this.data) {
			return [truncateToWidth(chalk.gray("  市场情绪: 加载中..."), width)];
		}

		const { sentimentIndex, advance, decline, limitUp, limitDown, northboundFlow } = this.data;

		// A-share convention: red for up/bullish, green for down/bearish
		const colorFn = sentimentIndex >= 60 ? chalk.red : sentimentIndex <= 40 ? chalk.green : chalk.yellow;

		// Progress bar (max 20 chars)
		const barWidth = Math.min(20, Math.max(10, Math.floor(width / 4)));
		const filled = Math.round((sentimentIndex / 100) * barWidth);
		const empty = barWidth - filled;
		const bar = colorFn("█".repeat(filled)) + chalk.gray("░".repeat(empty));

		// Label
		const label =
			sentimentIndex >= 80
				? "强烈偏多"
				: sentimentIndex >= 60
					? "偏多"
					: sentimentIndex >= 40
						? "中性"
						: sentimentIndex >= 20
							? "偏空"
							: "强烈偏空";

		const nbSign = northboundFlow >= 0 ? "+" : "";

		// Build line with A-share colors: advance=red, decline=green
		const line1 =
			chalk.gray("  情绪 ") +
			colorFn(`${sentimentIndex}/100`) +
			chalk.gray(" [") +
			bar +
			chalk.gray("] ") +
			colorFn(label) +
			chalk.gray("  |  涨") +
			chalk.red(String(advance)) +
			chalk.gray(" 跌") +
			chalk.green(String(decline)) +
			chalk.gray("  |  涨停") +
			chalk.red(String(limitUp)) +
			chalk.gray(" 跌停") +
			chalk.green(String(limitDown)) +
			chalk.gray(`  |  北向 ${nbSign}${northboundFlow}亿`);

		const lines: string[] = [truncateToWidth(line1, width)];

		// Show top/bottom sectors if available
		if (this.data.topSectors && this.data.topSectors.length > 0) {
			const top = this.data.topSectors
				.slice(0, 2)
				.map((s) => `${s.name}+${s.change_pct}%`)
				.join(" ");
			const bottom = this.data.bottomSectors
				?.slice(0, 2)
				.map((s) => `${s.name}${s.change_pct}%`)
				.join(" ");
			const sectorLine =
				chalk.gray("  板块  强: ") + chalk.red(top) + (bottom ? chalk.gray("  弱: ") + chalk.green(bottom) : "");
			lines.push(truncateToWidth(sectorLine, width));
		}

		return lines;
	}

	handleInput?(_data: string): void {
		// No input handling
	}

	invalidate(): void {
		// No cached state to invalidate
	}
}
