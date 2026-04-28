import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import { EventEmitter } from "events";
import type { TradingEvent, TradingMode, TradingSessionConfig } from "./types.js";

export interface TradingSessionOptions {
	model: TradingSessionConfig["model"];
	baseSystemPrompt: string;
	tools: TradingSessionConfig["tools"];
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	streamFn?: StreamFn;
	beforeToolCall?: Agent["beforeToolCall"];
	afterToolCall?: Agent["afterToolCall"];
}

export interface PromptOptions {
	systemPromptSuffix?: string;
}

export class TradingSession extends EventEmitter {
	private agent: Agent;
	private mode: TradingMode = "research";
	private unsubAgent: (() => void) | undefined;
	private promptQueue: Array<{
		input: string;
		opts?: PromptOptions;
		resolve: () => void;
		reject: (err: Error) => void;
	}> = [];
	private isPrompting = false;

	constructor(private config: TradingSessionOptions) {
		super();

		this.agent = new Agent({
			initialState: {
				model: config.model,
				systemPrompt: config.baseSystemPrompt,
				tools: config.tools,
				thinkingLevel: "off",
			},
			getApiKey: config.getApiKey,
			streamFn: config.streamFn,
			beforeToolCall: config.beforeToolCall,
			afterToolCall: config.afterToolCall,
		});

		this.unsubAgent = this.agent.subscribe((event, signal) => {
			this.handleAgentEvent(event, signal);
		});
	}

	get currentMode(): TradingMode {
		return this.mode;
	}

	get model(): TradingSessionConfig["model"] {
		return this.config.model;
	}

	setMode(mode: TradingMode): void {
		this.mode = mode;
		const event: TradingEvent = { type: "mode_change", mode };
		this.emit("trading_event", event);
	}

	async prompt(input: string, opts?: PromptOptions): Promise<void> {
		return new Promise((resolve, reject) => {
			this.promptQueue.push({ input, opts, resolve, reject });
			this.processPromptQueue();
		});
	}

	private async processPromptQueue(): Promise<void> {
		if (this.isPrompting || this.promptQueue.length === 0) return;

		this.isPrompting = true;
		const { input, opts, resolve, reject } = this.promptQueue.shift()!;

		try {
			const suffix = opts?.systemPromptSuffix;
			if (suffix) {
				const original = this.agent.state.systemPrompt;
				this.agent.state.systemPrompt = `${original}\n\n${suffix}`;
				try {
					await this.agent.prompt(input);
				} finally {
					this.agent.state.systemPrompt = original;
				}
			} else {
				await this.agent.prompt(input);
			}
			resolve();
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		} finally {
			this.isPrompting = false;
			// Process next item in queue
			this.processPromptQueue();
		}
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
	}

	private async handleAgentEvent(event: AgentEvent, _signal: AbortSignal): Promise<void> {
		this.emit("agent_event", event);
	}

	dispose(): void {
		this.unsubAgent?.();
		this.removeAllListeners();
		this.promptQueue = [];
	}
}
