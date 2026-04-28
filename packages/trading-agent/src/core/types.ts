import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

export type TradingMode = "research" | "pre-market" | "market" | "post-market";

export interface TradingSessionConfig {
	model: Model<Api>;
	baseSystemPrompt: string;
	tools: AgentTool<any>[];
}

export type TradingEvent =
	| AgentEvent
	| { type: "mode_change"; mode: TradingMode }
	| { type: "routine_start"; name: string }
	| { type: "routine_end"; name: string; summary: string };
