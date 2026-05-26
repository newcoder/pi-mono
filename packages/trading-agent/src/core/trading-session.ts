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
	attachments?: Array<{ name: string; content: string; mimeType: string }>;
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

	/**
	 * Switch the LLM model at runtime. Recreates the Agent with the new model
	 * while preserving conversation history, system prompt, and tools.
	 */
	switchModel(newModel: TradingSessionConfig["model"]): void {
		if (this.isPrompting) {
			throw new Error("Cannot switch model while a prompt is being processed");
		}
		this.config.model = newModel;
		// Preserve current state
		const currentState = this.agent.state;
		this.unsubAgent?.();
		this.agent = new Agent({
			initialState: {
				model: newModel,
				systemPrompt: currentState.systemPrompt,
				tools: currentState.tools,
				thinkingLevel: currentState.thinkingLevel,
				messages: currentState.messages,
			},
			getApiKey: this.config.getApiKey,
			streamFn: this.config.streamFn,
			beforeToolCall: this.config.beforeToolCall,
			afterToolCall: this.config.afterToolCall,
		});
		this.unsubAgent = this.agent.subscribe((event, signal) => {
			this.handleAgentEvent(event, signal);
		});
		this.emit("trading_event", { type: "model_change", model: newModel } as TradingEvent);
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
			let promptText = input;
			const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

			// Process attachments
			const attachments = opts?.attachments;
			if (attachments && attachments.length > 0) {
				const textParts: string[] = [];
				for (const att of attachments) {
					if (att.mimeType.startsWith("image/")) {
						// Extract base64 data from data URL
						const base64Data = att.content.startsWith("data:") ? att.content.split(",")[1] : att.content;
						images.push({ type: "image" as const, data: base64Data, mimeType: att.mimeType });
					} else {
						// Text file: include content in prompt
						textParts.push(`--- File: ${att.name} ---\n${att.content}\n--- End of ${att.name} ---`);
					}
				}
				if (textParts.length > 0) {
					promptText = textParts.join("\n\n") + (promptText ? "\n\n" + promptText : "");
				}
			}

			const suffix = opts?.systemPromptSuffix;
			if (suffix) {
				const original = this.agent.state.systemPrompt;
				this.agent.state.systemPrompt = `${original}\n\n${suffix}`;
				try {
					await this.agent.prompt(promptText, images.length > 0 ? images : undefined);
				} finally {
					this.agent.state.systemPrompt = original;
				}
			} else {
				await this.agent.prompt(promptText, images.length > 0 ? images : undefined);
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
