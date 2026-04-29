import type { Component } from "@mariozechner/pi-tui";
import chalk from "chalk";

export type MarketPhase = "before-open" | "call-auction" | "morning" | "lunch" | "afternoon" | "after-close" | "closed";

interface MarketPhaseInfo {
	label: string;
	color: (text: string) => string;
}

const PHASE_INFO: Record<MarketPhase, MarketPhaseInfo> = {
	"before-open": { label: "盘前", color: chalk.gray },
	"call-auction": { label: "集合竞价", color: chalk.yellow },
	morning: { label: "早盘", color: chalk.green },
	lunch: { label: "午休", color: chalk.gray },
	afternoon: { label: "午盘", color: chalk.green },
	"after-close": { label: "收盘后", color: chalk.gray },
	closed: { label: "休市", color: chalk.gray },
};

function getShanghaiNow(): Date {
	return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}

function getMarketPhase(now: Date): MarketPhase {
	const day = now.getDay();
	// Weekend
	if (day === 0 || day === 6) return "closed";

	const hour = now.getHours();
	const minute = now.getMinutes();
	const time = hour * 60 + minute;

	// Before 9:15
	if (time < 9 * 60 + 15) return "before-open";
	// Call auction: 9:15 - 9:25
	if (time < 9 * 60 + 25) return "call-auction";
	// Morning: 9:30 - 11:30
	if (time < 11 * 60 + 30) return "morning";
	// Lunch: 11:30 - 13:00
	if (time < 13 * 60) return "lunch";
	// Afternoon: 13:00 - 15:00
	if (time < 15 * 60) return "afternoon";
	// After close
	return "after-close";
}

function getNextPhaseTime(now: Date, phase: MarketPhase): Date {
	const next = new Date(now);
	switch (phase) {
		case "before-open":
			next.setHours(9, 15, 0, 0);
			return next;
		case "call-auction":
			next.setHours(9, 25, 0, 0);
			return next;
		case "morning":
			next.setHours(11, 30, 0, 0);
			return next;
		case "lunch":
			next.setHours(13, 0, 0, 0);
			return next;
		case "afternoon":
			next.setHours(15, 0, 0, 0);
			return next;
		case "after-close":
		case "closed": {
			// Next trading day: skip to next day, then skip weekends
			next.setDate(next.getDate() + 1);
			next.setHours(9, 15, 0, 0);
			while (next.getDay() === 0 || next.getDay() === 6) {
				next.setDate(next.getDate() + 1);
			}
			return next;
		}
	}
}

function formatCountdown(ms: number): string {
	if (ms <= 0) return "";
	const totalMinutes = Math.ceil(ms / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) {
		return `${hours}h${minutes.toString().padStart(2, "0")}m`;
	}
	return `${minutes}m`;
}

function getCountdownLabel(phase: MarketPhase): string {
	switch (phase) {
		case "before-open":
			return "距开盘";
		case "call-auction":
			return "距连续竞价";
		case "morning":
			return "距午休";
		case "lunch":
			return "距午盘";
		case "afternoon":
			return "距收盘";
		case "after-close":
		case "closed":
			return "距开盘";
	}
}

export class MarketStatusBar implements Component {
	private mode = "research";
	private modelName = "?";

	setMode(mode: string): void {
		this.mode = mode;
	}

	setModelName(name: string): void {
		this.modelName = name;
	}

	render(width: number): string[] {
		const now = getShanghaiNow();
		const phase = getMarketPhase(now);
		const info = PHASE_INFO[phase];

		// Countdown
		const nextTime = getNextPhaseTime(now, phase);
		const msRemaining = nextTime.getTime() - now.getTime();
		const countdown = formatCountdown(msRemaining);
		const countdownLabel = getCountdownLabel(phase);

		// Build line segments
		const phaseStr = info.label;
		const countdownStr = countdown ? `${countdownLabel} ${countdown}` : "";
		const modeStr = this.mode;
		const modelStr = this.modelName;

		const left = info.color(` ${phaseStr}`);
		const mid = countdownStr ? chalk.dim(` │ ${countdownStr}`) : "";
		const right = chalk.dim(` │ ${modeStr} │ ${modelStr}`);

		const line = `${left}${mid}${right}`;
		return [line.slice(0, width)];
	}

	handleInput?(_data: string): void {
		// No input handling
	}

	invalidate(): void {
		// No cached state
	}
}
