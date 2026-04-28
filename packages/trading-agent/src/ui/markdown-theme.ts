import type { MarkdownTheme } from "@mariozechner/pi-tui";
import chalk from "chalk";

/**
 * Trading Agent Dark Theme for Markdown rendering.
 * Bloomberg-terminal inspired with cyan accents.
 */
export const tradingMarkdownTheme: MarkdownTheme = {
	heading: (text) => chalk.cyan.bold(text),
	link: (text) => chalk.blue.underline(text),
	linkUrl: (text) => chalk.blue.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.gray(text),
	codeBlockBorder: () => chalk.gray("│"),
	quote: (text) => chalk.dim.italic(text),
	quoteBorder: () => chalk.gray("┃"),
	hr: (text) => chalk.gray(text),
	listBullet: () => chalk.cyan("•"),
	bold: (text) => chalk.bold.white(text),
	italic: (text) => chalk.italic(text),
	underline: (text) => chalk.underline(text),
	strikethrough: (text) => chalk.strikethrough(text),
	highlightCode: (code: string, _lang?: string) => {
		// Simple code highlighting - just dim gray
		return code.split("\n").map((line) => chalk.gray(line));
	},
};
