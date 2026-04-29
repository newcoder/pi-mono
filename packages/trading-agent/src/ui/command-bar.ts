import type { Component } from "@mariozechner/pi-tui";
import chalk from "chalk";

const COMMANDS = ["/pre-market", "/post-market", "/quit"];

export class CommandBar implements Component {
	private visible = true;

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const text = ` ${COMMANDS.map((c) => chalk.dim(c)).join("  ")}`;
		return [text.slice(0, width)];
	}

	handleInput?(_data: string): void {
		// No input handling
	}

	invalidate(): void {
		// No cached state
	}
}
