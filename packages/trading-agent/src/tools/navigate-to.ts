import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

/** Registry mapping symbolic targets to page URLs. Add new entries here to support new navigable pages. */
const PAGE_REGISTRY: Record<string, { url: string; label: string; newTab: boolean }> = {
	backtest: { url: "/public/backtest.html", label: "策略回测", newTab: true },
};

const VALID_TARGETS = Object.keys(PAGE_REGISTRY);

const navigateParams = Type.Object({
	target: Type.Union(
		VALID_TARGETS.map((t) =>
			Type.Literal(t, { description: `打开${PAGE_REGISTRY[t].label}页面` }),
		),
		{ description: "要导航到的目标页面" },
	),
});

interface NavigateDetails {
	action: "navigate";
	target: string;
	url: string;
	label: string;
	newTab: boolean;
}

export const navigateToTool: AgentTool<typeof navigateParams, NavigateDetails> = {
	name: "navigate_to",
	label: "页面导航",
	description: `打开指定的工具页面。可用目标: ${VALID_TARGETS.map((t) => `${t} (${PAGE_REGISTRY[t].label})`).join(", ")}。当用户要求打开回测、运行回测、使用某个工具页面时，使用此工具导航到对应页面。`,
	parameters: navigateParams,

	execute: async (_id, params) => {
		const cfg = PAGE_REGISTRY[params.target];
		if (!cfg) {
			return {
				content: [{ type: "text", text: `未知页面: ${params.target}。可用: ${VALID_TARGETS.join(", ")}` }],
				details: { action: "navigate" as const, target: params.target, url: "", label: "", newTab: false },
			};
		}
		return {
			content: [{ type: "text", text: `已打开${cfg.label}页面。` }],
			details: { action: "navigate" as const, target: params.target, url: cfg.url, label: cfg.label, newTab: cfg.newTab },
		};
	},
};
