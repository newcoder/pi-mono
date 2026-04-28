import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Routine } from "../scheduler/task-scheduler.js";
import type { Skill } from "./skill.js";

/**
 * Registry for managing skills and aggregating their contributions.
 *
 * Skills are loaded from external SKILL.md files and their tools, routines,
 * and prompt fragments are collected into unified collections for the session.
 */
export class SkillRegistry {
	private skills = new Map<string, Skill>();
	private toolIndex = new Map<string, AgentTool<any>>();

	/** Register a skill. Throws if a skill with the same name already exists. */
	register(skill: Skill): void {
		if (this.skills.has(skill.name)) {
			throw new Error(`Skill "${skill.name}" is already registered`);
		}
		this.skills.set(skill.name, skill);
		if (skill.tools) {
			for (const tool of skill.tools) {
				this.toolIndex.set(tool.name, tool);
			}
		}
		console.log(`[SkillRegistry] Registered skill: ${skill.name} — ${skill.description}`);
	}

	/** Unregister a skill by name. */
	unregister(name: string): void {
		const skill = this.skills.get(name);
		if (!skill) return;
		if (skill.tools) {
			for (const tool of skill.tools) {
				this.toolIndex.delete(tool.name);
			}
		}
		this.skills.delete(name);
	}

	/** Check if a skill is registered. */
	has(name: string): boolean {
		return this.skills.has(name);
	}

	/** Get a registered skill by name. */
	get(name: string): Skill | undefined {
		return this.skills.get(name);
	}

	/** Get all registered skills. */
	getAll(): Skill[] {
		return Array.from(this.skills.values());
	}

	/** Get all tools from all registered skills (deduplicated by name). */
	getAllTools(): AgentTool<any>[] {
		return Array.from(this.toolIndex.values());
	}

	/** Get a specific tool by name. */
	getTool(name: string): AgentTool<any> | undefined {
		return this.toolIndex.get(name);
	}

	/** Register tools directly (used for fallback when no external skills exist). */
	registerTools(tools: AgentTool<any>[]): void {
		for (const tool of tools) {
			this.toolIndex.set(tool.name, tool);
		}
	}

	/** Get all routines from all registered skills. */
	getRoutines(): Routine[] {
		const routines: Routine[] = [];
		for (const skill of this.skills.values()) {
			if (skill.routines) {
				routines.push(...skill.routines);
			}
		}
		return routines;
	}

	/**
	 * Build the system prompt by appending skill content.
	 *
	 * Skills with disableModelInvocation=true are excluded (they can only be
	 * invoked explicitly, not auto-loaded into the prompt).
	 */
	buildSystemPrompt(basePrompt: string): string {
		const visibleSkills = this.getAll().filter((s) => !s.disableModelInvocation);
		if (visibleSkills.length === 0) return basePrompt;

		const fragments = visibleSkills.map((skill) => `## ${skill.name}\n${skill.description}\n\n${skill.content}`);
		return `${basePrompt}\n\n${fragments.join("\n\n")}`;
	}
}
