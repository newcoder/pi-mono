import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WatchlistItem {
	code: string;
	name: string;
	market: 0 | 1;
}

export interface UserConfig {
	watchlist: WatchlistItem[];
	preMarketSchedule: string;
	postMarketSchedule: string;
	timezone: string;
	preMarketPrompt: string;
}

const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || ".", ".trading-agent");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: UserConfig = {
	watchlist: [],
	preMarketSchedule: "45 7 * * 1-5",
	postMarketSchedule: "35 15 * * 1-5",
	timezone: "Asia/Shanghai",
	preMarketPrompt: "你是一个专业的盘前分析师。基于以下隔夜市场数据和用户关注股票，生成盘前简报。",
};

export function loadUserConfig(): UserConfig {
	if (!existsSync(CONFIG_PATH)) {
		if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
		return DEFAULT_CONFIG;
	}
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
	} catch {
		return DEFAULT_CONFIG;
	}
}

export function getConfigDir(): string {
	return CONFIG_DIR;
}
