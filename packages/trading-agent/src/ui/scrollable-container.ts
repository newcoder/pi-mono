import type { Component, TUI } from "@mariozechner/pi-tui";

/**
 * A container that renders only a visible subset of its children,
 * enabling scrolling when content exceeds available height.
 *
 * This is used for the message area so that header bars remain
 * fixed at the top while chat content scrolls independently.
 */
export class ScrollableContainer implements Component {
	children: Component[] = [];
	private scrollOffset = 0;
	private autoScroll = true;

	constructor(
		private tui: TUI,
		private reservedHeight: number,
	) {}

	addChild(child: Component): void {
		this.children.push(child);
		this.autoScroll = true;
	}

	removeChild(child: Component): void {
		const index = this.children.indexOf(child);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	scrollUp(lines = 1): void {
		this.autoScroll = false;
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
	}

	scrollDown(lines = 1): void {
		this.autoScroll = false;
		this.scrollOffset += lines;
	}

	pageUp(): void {
		this.scrollUp(Math.max(3, this.tui.terminal.rows - this.reservedHeight));
	}

	pageDown(): void {
		this.scrollDown(Math.max(3, this.tui.terminal.rows - this.reservedHeight));
	}

	scrollToBottom(): void {
		this.autoScroll = true;
	}

	render(width: number): string[] {
		const allLines: string[] = [];
		for (const child of this.children) {
			allLines.push(...child.render(width));
		}

		const maxHeight = Math.max(3, this.tui.terminal.rows - this.reservedHeight);

		if (this.autoScroll) {
			this.scrollOffset = Math.max(0, allLines.length - maxHeight);
		} else {
			this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, allLines.length - maxHeight));
		}

		if (allLines.length <= maxHeight) {
			return allLines;
		}

		return allLines.slice(this.scrollOffset, this.scrollOffset + maxHeight);
	}

	handleInput?(_data: string): void {
		// Scrolling is handled by an input listener on the TUI
	}

	invalidate(): void {
		// No cached state
	}
}
