import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Routine } from "../scheduler/task-scheduler.js";

/**
 * Skill metadata parsed from SKILL.md frontmatter.
 *
 * Trading-agent extends the standard Agent Skills format with optional
 * `tools` and `routines` fields that declare which built-in capabilities
 * the skill activates.
 */
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	/** Tool names this skill activates (must match built-in tool names) */
	tools?: string[];
	/** Routine names this skill activates (must match built-in routine names) */
	routines?: string[];
	/** If true, the skill content is not appended to the system prompt automatically */
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

/**
 * A Skill is a self-contained unit of capability loaded from an external
 * SKILL.md file. It may contribute:
 * - System prompt content (the markdown body)
 * - Tool activations (via frontmatter `tools` list)
 * - Routine registrations (via frontmatter `routines` list)
 */
export interface Skill {
	/** Unique machine-friendly identifier (from frontmatter or parent dir name) */
	name: string;
	/** Human-readable description (from frontmatter) */
	description: string;
	/** Absolute path to the SKILL.md file */
	filePath: string;
	/** Parent directory of the SKILL.md file */
	baseDir: string;
	/** Parsed frontmatter */
	frontmatter: SkillFrontmatter;
	/** Markdown body (used as system prompt fragment) */
	content: string;
	/** Whether to exclude from automatic system prompt */
	disableModelInvocation: boolean;
	/** Resolved tool objects */
	tools?: AgentTool<any>[];
	/** Resolved routine objects */
	routines?: Routine[];
}
