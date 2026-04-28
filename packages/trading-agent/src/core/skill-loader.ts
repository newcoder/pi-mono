import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Skill, SkillFrontmatter } from "./skill.js";

const EXTERNAL_SKILLS_DIR = join(process.env.HOME || process.env.USERPROFILE || ".", ".agents/skills");

// Resolve bundled skills directory relative to this file's location
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROMPTS_DIR = join(__dirname, "../../prompts");
const BUNDLED_SKILLS_DIR = join(__dirname, "../../skills");

function parseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) {
		return { frontmatter: {} as T, body: normalized };
	}
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {} as T, body: normalized };
	}
	const yamlString = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();
	try {
		const parsed = parse(yamlString);
		return { frontmatter: (parsed ?? {}) as T, body };
	} catch {
		return { frontmatter: {} as T, body: normalized };
	}
}

/** Load the base system prompt from the bundled prompts directory. */
export function loadSystemPromptFromFile(): string {
	try {
		return readFileSync(join(PROMPTS_DIR, "system-prompt.md"), "utf-8");
	} catch (err) {
		console.warn("[skill-loader] Failed to load system-prompt.md, falling back to built-in:", (err as Error).message);
		return buildFallbackSystemPrompt();
	}
}

/** Load a single skill from a SKILL.md file path. */
export function loadSkillFromFile(filePath: string): Skill | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		const name = frontmatter.name || parentDirName;
		const description = frontmatter.description || "";
		if (!description) {
			console.warn(`[skill-loader] Skill "${name}" missing description in frontmatter: ${filePath}`);
			return null;
		}

		return {
			name,
			description,
			filePath,
			baseDir: skillDir,
			frontmatter,
			content: body,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		};
	} catch (err) {
		console.warn(`[skill-loader] Failed to load skill from "${filePath}":`, (err as Error).message);
		return null;
	}
}

/**
 * Discover skill directories by scanning for SKILL.md files.
 *
 * Rules (aligned with coding-agent):
 * - If a directory contains SKILL.md, it is a skill root (do not recurse further)
 * - Otherwise, recurse into subdirectories
 */
export function discoverSkillDirs(rootDir: string): string[] {
	const result: string[] = [];
	if (!existsSync(rootDir)) return result;

	function scan(dir: string): void {
		const skillFile = join(dir, "SKILL.md");
		if (existsSync(skillFile)) {
			result.push(dir);
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				if (!entry.isDirectory()) continue;
				scan(join(dir, entry.name));
			}
		} catch {
			// ignore permission errors
		}
	}

	scan(rootDir);
	return result;
}

/** Discover all skill directories: bundled first, then external.
 *  Bundled skills (in package) override external skills with the same name.
 */
export function discoverAllSkillDirs(): string[] {
	const externalDirs = discoverSkillDirs(EXTERNAL_SKILLS_DIR);
	const bundledDirs = discoverSkillDirs(BUNDLED_SKILLS_DIR);

	// Build a map of skill name -> directory, bundled takes priority
	const skillMap = new Map<string, string>();

	for (const dir of externalDirs) {
		const name = basename(dir);
		skillMap.set(name, dir);
	}

	for (const dir of bundledDirs) {
		const name = basename(dir);
		skillMap.set(name, dir); // override external
	}

	return Array.from(skillMap.values());
}

function buildFallbackSystemPrompt(): string {
	return `你是一位专业的A股价值投资分析师。

## 可用工具
- get_quote: 获取A股实时行情
- get_fundamentals: 获取三大财务报表
- get_kline: 获取历史K线（默认最近60天）
- screen_stocks: 基本面选股（默认只搜沪深300，全A股需传scope:"all"）
- advanced_screen: 技术指标+基本面组合选股
- backtest_strategy: 策略回测（默认qfq、最近一年）
- compare_stocks: 股票对比
- get_sector_rotation: 板块轮动
- get_concept_stocks: 概念股
- list_concepts: 列出所有概念
- list_industries: 列出行业分类（sw_l1/sw_l2/sw_l3/zjw/jq_l1/jq_l2）
- get_industry_stocks: 按行业查股票
- get_stock_industries: 查股票的行业归属
- get_macro: 宏观数据
- manage_stock_pool: 股票池管理
`;
}
