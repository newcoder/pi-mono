import type { KnownProvider } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";

/** Default model IDs for each known provider — copied from coding-agent to avoid internal import */
const defaultModelPerProvider: Record<KnownProvider, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-opus-4-6",
	openai: "gpt-5.4",
	"azure-openai-responses": "gpt-5.2",
	"openai-codex": "gpt-5.4",
	google: "gemini-2.5-pro",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-vertex": "gemini-3-pro-preview",
	"github-copilot": "gpt-4o",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	groq: "openai/gpt-oss-120b",
	cerebras: "zai-glm-4.7",
	zai: "glm-5",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	huggingface: "moonshotai/Kimi-K2.5",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	"kimi-coding": "kimi-k2-thinking",
	deepseek: "deepseek-chat-v3-0324",
	fireworks: "accounts/fireworks/models/llama4-maverick-instruct-basic",
	"cloudflare-workers-ai": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

export function loadModelRegistry(): ModelRegistry {
	const agentDir = join(homedir(), ".pi", "agent");
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelsJsonPath = join(agentDir, "models.json");
	return ModelRegistry.create(authStorage, modelsJsonPath);
}

export function selectDefaultModel(registry: ModelRegistry) {
	const available = registry.getAvailable();
	if (available.length === 0) {
		return undefined;
	}

	const provider = process.env.TRADING_PROVIDER;
	const modelId = process.env.TRADING_MODEL;

	if (provider && modelId) {
		const explicit = registry.find(provider, modelId);
		if (explicit && registry.hasConfiguredAuth(explicit)) {
			return explicit;
		}
		console.warn(`Model ${provider}/${modelId} not found or has no auth, falling back to default selection`);
	}

	// Custom models from models.json are appended AFTER built-in models.
	// Detect custom models by checking if their API type differs from the
	// provider's default model (e.g. kimi-coding built-ins use
	// anthropic-messages, but custom models from models.json use
	// openai-completions with the correct baseUrl).
	function isCustomModel(model: (typeof available)[0]): boolean {
		const defaultId = defaultModelPerProvider[model.provider as KnownProvider];
		if (!defaultId) return false;
		const defaultModel = available.find((m) => m.provider === model.provider && m.id === defaultId);
		if (!defaultModel) return false;
		return model.api !== defaultModel.api;
	}

	for (const model of available) {
		if (isCustomModel(model)) {
			return model;
		}
	}

	// No custom models found — fall back to coding-agent behavior:
	// iterate providers in priority order, pick first available default.
	for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
		const defaultId = defaultModelPerProvider[provider];
		const match = available.find((m) => m.provider === provider && m.id === defaultId);
		if (match) {
			return match;
		}
	}

	return available[0];
}
