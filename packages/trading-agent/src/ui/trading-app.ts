import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Component } from "@mariozechner/pi-tui";
import { Input, Markdown, ProcessTerminal, Text, TUI } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { TradingSession } from "../core/trading-session.js";
import { CommandBar } from "./command-bar.js";
import { IndexQuotesBar } from "./index-quotes-bar.js";
import { tradingMarkdownTheme } from "./markdown-theme.js";
import { MarketStatusBar } from "./market-status-bar.js";
import { ScrollableContainer } from "./scrollable-container.js";
import { SentimentBar } from "./sentiment-bar.js";

type MessageRole = "user" | "assistant" | "system" | "tool";

interface ChatMessage {
	role: MessageRole;
	text: string;
	component: Component;
}

const MAX_MESSAGES = 100;
const INDEX_REFRESH_INTERVAL_MS = 60_000;
const MARKET_STATUS_REFRESH_INTERVAL_MS = 30_000;

export class TradingApp {
	private tui: TUI;
	private indexQuotesBar: IndexQuotesBar;
	private sentimentBar: SentimentBar;
	private marketStatusBar: MarketStatusBar;
	private messageContainer: ScrollableContainer;
	private commandBar: CommandBar;
	private input: Input;
	private streamingMsg: ChatMessage | undefined;
	private messages: ChatMessage[] = [];
	private timers: NodeJS.Timeout[] = [];
	private isShuttingDown = false;
	private inputListenerCleanup: (() => void) | null = null;

	constructor(
		private session: TradingSession,
		private onCommand?: (cmd: string) => Promise<boolean>,
	) {
		this.tui = new TUI(new ProcessTerminal());

		// ─── Top header bars ────────────────────────────────────────
		this.indexQuotesBar = new IndexQuotesBar();
		this.tui.addChild(this.indexQuotesBar);

		this.sentimentBar = new SentimentBar();
		this.tui.addChild(this.sentimentBar);

		this.marketStatusBar = new MarketStatusBar();
		this.marketStatusBar.setModelName(session.model?.id ?? "?");
		this.tui.addChild(this.marketStatusBar);

		// ─── Message area (scrollable) ──────────────────────────────
		// Reserve 5 lines for header bars (3) + footer bars (2)
		this.messageContainer = new ScrollableContainer(this.tui, 5);
		this.tui.addChild(this.messageContainer);

		// ─── Bottom bars ────────────────────────────────────────────
		this.commandBar = new CommandBar();
		this.tui.addChild(this.commandBar);

		this.input = new Input();
		this.input.onSubmit = (value) => this.handleSubmit(value);
		this.tui.addChild(this.input);
		this.tui.setFocus(this.input);

		// ─── Events ─────────────────────────────────────────────────
		session.on("agent_event", (ev: AgentEvent) => this.handleAgentEvent(ev));
		session.on("trading_event", (ev: any) => this.handleTradingEvent(ev));

		// ─── Global scroll keys ─────────────────────────────────────
		// PageUp/PageDown scroll the message area since Input is single-line
		this.inputListenerCleanup = this.tui.addInputListener((data) => {
			if (data === "\x1b[5~") {
				// PageUp
				this.messageContainer.pageUp();
				this.tui.requestRender();
				return { consume: true };
			}
			if (data === "\x1b[6~") {
				// PageDown
				this.messageContainer.pageDown();
				this.tui.requestRender();
				return { consume: true };
			}
			return undefined;
		});

		// ─── Timers ─────────────────────────────────────────────────
		// Refresh index quotes every 60s
		this.timers.push(
			setInterval(() => {
				this.indexQuotesBar.refresh().then(() => this.tui.requestRender());
			}, INDEX_REFRESH_INTERVAL_MS),
		);

		// Refresh market status countdown every 30s
		this.timers.push(
			setInterval(() => {
				this.tui.requestRender();
			}, MARKET_STATUS_REFRESH_INTERVAL_MS),
		);

		// Initial data fetch
		this.indexQuotesBar.refresh().then(() => this.tui.requestRender());
	}

	async start(): Promise<void> {
		this.tui.start();
	}

	private async handleSubmit(value: string): Promise<void> {
		if (this.isShuttingDown) return;
		const trimmed = value.trim();
		if (!trimmed) return;

		if (trimmed === "/quit") {
			await this.shutdown();
			return;
		}

		// Check if it's a command handled by the scheduler
		if (this.onCommand && (await this.onCommand(trimmed))) {
			this.addMessage("system", `执行命令: ${trimmed}`);
			this.input.setValue("");
			this.tui.requestRender();
			return;
		}

		this.addMessage("user", `> ${trimmed}`);
		this.input.setValue("");
		this.tui.requestRender();

		this.session.prompt(trimmed).catch((err) => {
			this.addMessage("system", chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
		});
	}

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		for (const timer of this.timers) {
			clearInterval(timer);
		}
		this.timers = [];

		if (this.inputListenerCleanup) {
			this.inputListenerCleanup();
		}

		this.session.dispose();
		this.tui.stop();
		process.exit(0);
	}

	private handleTradingEvent(ev: any): void {
		if (ev.type === "mode_change") {
			this.marketStatusBar.setMode(ev.mode);
			this.tui.requestRender();
		}
		if (ev.type === "sentiment_update" && ev.data) {
			this.sentimentBar.update(ev.data);
			this.tui.requestRender();
		}
	}

	private handleAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "assistant") {
					this.streamingMsg = this.addMessage("assistant", "");
				}
				break;
			}

			case "message_update": {
				const ev = event.assistantMessageEvent;
				if (ev.type === "text_delta" && this.streamingMsg) {
					this.streamingMsg.text += ev.delta;
					this.updateMessageComponent(this.streamingMsg);
					this.tui.requestRender();
				}
				break;
			}

			case "message_end": {
				if (event.message.role === "assistant" && this.streamingMsg) {
					const text = extractTextContent(event.message);
					this.streamingMsg.text = text;
					this.updateMessageComponent(this.streamingMsg);
					this.streamingMsg = undefined;
					this.tui.requestRender();
				}
				break;
			}

			case "tool_execution_start": {
				this.addMessage("tool", chalk.dim(`[Tool: ${event.toolName}]`));
				break;
			}

			case "tool_execution_end": {
				const resultText = extractToolResultText(event.result);
				this.addMessage("tool", chalk.dim(`[/Tool: ${event.toolName}] ${resultText}`));
				break;
			}

			case "agent_end": {
				this.marketStatusBar.setMode(this.session.currentMode);
				break;
			}
		}
	}

	private addMessage(role: MessageRole, text: string): ChatMessage {
		const msg: ChatMessage = { role, text, component: new Text("") };
		this.renderMessageComponent(msg);
		this.messageContainer.addChild(msg.component);
		this.messages.push(msg);
		this.messageContainer.scrollToBottom();

		// Trim old messages
		while (this.messages.length > MAX_MESSAGES) {
			const old = this.messages.shift()!;
			this.messageContainer.removeChild(old.component);
		}

		this.tui.requestRender();
		return msg;
	}

	private updateMessageComponent(msg: ChatMessage): void {
		const oldComponent = msg.component;
		this.renderMessageComponent(msg);
		// Replace in container: find index of old, replace with new
		const index = this.messageContainer.children.indexOf(oldComponent);
		if (index !== -1) {
			this.messageContainer.children.splice(index, 1, msg.component);
		}
	}

	private renderMessageComponent(msg: ChatMessage): void {
		let prefix = "";
		switch (msg.role) {
			case "user":
				prefix = "> ";
				break;
			case "system":
				prefix = "[!] ";
				break;
			case "tool":
				prefix = chalk.dim("[T] ");
				break;
			case "assistant":
				prefix = "";
				break;
		}

		const fullText = prefix + msg.text;

		if (msg.role === "assistant") {
			msg.component = new Markdown(fullText, 1, 0, tradingMarkdownTheme);
		} else {
			msg.component = new Text(fullText, 1, 0);
		}
	}
}

function extractTextContent(message: any): string {
	if (!message.content) return "";
	return message.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
}

function extractToolResultText(result: any): string {
	if (!result?.content) return "";
	return result.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("")
		.slice(0, 80);
}
