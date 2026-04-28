import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Component } from "@mariozechner/pi-tui";
import { Container, Input, Markdown, ProcessTerminal, Text, TUI } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { TradingSession } from "../core/trading-session.js";
import type { TradingMode } from "../core/types.js";
import { tradingMarkdownTheme } from "./markdown-theme.js";

type MessageRole = "user" | "assistant" | "system" | "tool";

interface ChatMessage {
	role: MessageRole;
	text: string;
	component: Component;
}

const MAX_MESSAGES = 100;

export class TradingApp {
	private tui: TUI;
	private statusText: Text;
	private messageContainer: Container;
	private input: Input;
	private streamingMsg: ChatMessage | undefined;
	private messages: ChatMessage[] = [];
	private statusTimer: NodeJS.Timeout | undefined;
	private isShuttingDown = false;

	constructor(
		private session: TradingSession,
		private onCommand?: (cmd: string) => Promise<boolean>,
	) {
		this.tui = new TUI(new ProcessTerminal());

		// Status bar
		this.statusText = new Text(this.buildStatusText(), 1, 0);
		this.tui.addChild(this.statusText);

		// Message area
		this.messageContainer = new Container();
		this.tui.addChild(this.messageContainer);

		// Input
		this.input = new Input();
		this.input.onSubmit = (value) => this.handleSubmit(value);
		this.tui.addChild(this.input);
		this.tui.setFocus(this.input);

		// Events
		session.on("agent_event", (ev: AgentEvent) => this.handleAgentEvent(ev));
		session.on("trading_event", (ev: any) => {
			if (ev.type === "mode_change") this.updateStatus(ev.mode);
		});

		// Status bar clock
		this.statusTimer = setInterval(() => {
			this.statusText.setText(this.buildStatusText());
			this.tui.requestRender();
		}, 30000);
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

		if (this.statusTimer) {
			clearInterval(this.statusTimer);
			this.statusTimer = undefined;
		}

		this.session.dispose();
		this.tui.stop();
		process.exit(0);
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
				this.updateStatus(this.session.currentMode);
				break;
			}
		}
	}

	private addMessage(role: MessageRole, text: string): ChatMessage {
		const msg: ChatMessage = { role, text, component: new Text("") };
		this.renderMessageComponent(msg);
		this.messageContainer.addChild(msg.component);
		this.messages.push(msg);

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
				prefix = chalk.cyan.bold("> ");
				break;
			case "system":
				prefix = chalk.yellow.dim("[!] ");
				break;
			case "tool":
				prefix = chalk.gray.dim("[T] ");
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

	private updateStatus(mode: TradingMode): void {
		this.statusText.setText(this.buildStatusText(mode));
		this.tui.requestRender();
	}

	private buildStatusText(mode?: TradingMode): string {
		const m = mode || this.session.currentMode;
		const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		const modelName = this.session.model?.id ?? "?";
		return chalk.dim(`${now} │ Analysis │ ${m} │ ${modelName}`);
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
