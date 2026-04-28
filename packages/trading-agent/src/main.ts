#!/usr/bin/env node
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { loadUserConfig } from "./config/user-config.js";
import { loadModelRegistry, selectDefaultModel } from "./core/model-config.js";
import { SessionMemory } from "./core/session-memory.js";
import { discoverAllSkillDirs, loadSkillFromFile, loadSystemPromptFromFile } from "./core/skill-loader.js";
import { SkillRegistry } from "./core/skill-registry.js";
import { TradingSession } from "./core/trading-session.js";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "./data/index.js";
import { postMarketRoutine } from "./scheduler/routines/post-market.js";
import { preMarketRoutine } from "./scheduler/routines/pre-market.js";
import { TaskScheduler } from "./scheduler/task-scheduler.js";
import { advancedScreenTool } from "./tools/advanced-screening.js";
import { backtestStrategyTool } from "./tools/backtest.js";
import { compareStocksTool } from "./tools/compare-stocks.js";
import { getConceptStocksTool, listConceptsTool } from "./tools/concept-stocks.js";
import { syncFundamentalsTool, syncKlineTool, syncNewsTool } from "./tools/data-sync.js";
import { getIndustryStocksTool, getStockIndustriesTool, listIndustriesTool } from "./tools/industry-classification.js";
import { getMacroTool } from "./tools/macro-data.js";
import { getFundamentalsTool, getKlineTool, getQuoteTool } from "./tools/market-data.js";
import { getMarketNewsTool, getStockNewsTool, screenByNewsTool } from "./tools/news-analysis.js";
import { screenStocksTool } from "./tools/screening.js";
import { getSectorRotationTool } from "./tools/sector-rotation.js";
import { manageStockPoolTool } from "./tools/stock-pool.js";
import { TradingApp } from "./ui/trading-app.js";

let globalStore: ReturnType<typeof createDataStore> | null = null;

function cleanupStore() {
	if (globalStore) {
		globalStore.close();
		globalStore = null;
	}
}

process.on("exit", cleanupStore);
process.on("SIGINT", () => {
	cleanupStore();
	process.exit(0);
});
process.on("SIGTERM", () => {
	cleanupStore();
	process.exit(0);
});

function getDataDir(): string {
	return (
		process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`
	);
}

async function handleSyncCommands(): Promise<boolean> {
	const args = process.argv;
	const dataDir = getDataDir();
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);

	// --sync-kline <code> --period <period> --adjust <adjust> --start <start> --end <end>
	const klineIdx = args.indexOf("--sync-kline");
	if (klineIdx >= 0) {
		const code = args[klineIdx + 1];
		if (!code) {
			console.error(
				"Usage: --sync-kline <code> [--period daily] [--adjust bfq] [--start YYYYMMDD] [--end YYYYMMDD]",
			);
			process.exit(1);
		}
		const periodIdx = args.indexOf("--period");
		const period = periodIdx >= 0 ? args[periodIdx + 1] : "daily";
		const adjustIdx = args.indexOf("--adjust");
		const adjust = adjustIdx >= 0 ? args[adjustIdx + 1] : "bfq";
		const startIdx = args.indexOf("--start");
		const start = startIdx >= 0 ? args[startIdx + 1] : undefined;
		const endIdx = args.indexOf("--end");
		const end = endIdx >= 0 ? args[endIdx + 1] : undefined;
		const market = code.startsWith("6") ? 1 : 0;
		console.log(`Syncing kline for ${code} (market=${market}, period=${period}, adjust=${adjust})...`);
		const count = await sync.syncKline(code, market, period, adjust, start, end);
		console.log(`Synced ${count} kline rows.`);
		store.close();
		return true;
	}

	// --sync-fundamentals <code>
	const fundIdx = args.indexOf("--sync-fundamentals");
	if (fundIdx >= 0) {
		const code = args[fundIdx + 1];
		if (!code) {
			console.error("Usage: --sync-fundamentals <code>");
			process.exit(1);
		}
		const market = code.startsWith("6") ? 1 : 0;
		console.log(`Syncing fundamentals for ${code}...`);
		const rows = await sync.syncFundamentals(code, market);
		console.log(`Synced ${rows.length} fundamentals records.`);
		store.close();
		return true;
	}

	// --sync-quotes
	if (args.includes("--sync-quotes")) {
		console.log("Syncing all A-share quotes...");
		const count = await sync.syncStockList("all");
		console.log(`Synced ${count} stocks.`);
		store.close();
		return true;
	}

	// --sync-sectors
	if (args.includes("--sync-sectors")) {
		console.log("Syncing sectors...");
		const rows = await sync.syncSectors();
		console.log(`Synced ${rows.length} sectors.`);
		store.close();
		return true;
	}

	// --sync-concepts <concept>
	const conceptIdx = args.indexOf("--sync-concepts");
	if (conceptIdx >= 0) {
		const concept = args[conceptIdx + 1];
		if (!concept) {
			console.error("Usage: --sync-concepts <concept_name>");
			process.exit(1);
		}
		console.log(`Syncing concept stocks for "${concept}"...`);
		const rows = await sync.syncConceptStocks(concept);
		console.log(`Synced ${rows.length} concept stocks.`);
		store.close();
		return true;
	}

	// --sync-all-concepts
	if (args.includes("--sync-all-concepts")) {
		console.log("Syncing all concepts via JoinQuant...");
		const count = await sync.syncAllConcepts();
		console.log(`Synced ${count} concepts.`);
		store.close();
		return true;
	}

	// --sync-industries
	if (args.includes("--sync-industries")) {
		console.log("Syncing industry classifications via JoinQuant...");
		const result = await sync.syncIndustries();
		console.log(
			`Synced ${result.standards} standards, ${result.industries} industries, ${result.mappings} mappings.`,
		);
		if (result.errors.length > 0) {
			console.warn("Errors:", result.errors.join("; "));
		}
		store.close();
		return true;
	}

	// --sync-all-kline [--period <period>] [--adjust <adjust>] [--batch-size <n>] [--start YYYYMMDD]
	if (args.includes("--sync-all-kline")) {
		const periodIdx = args.indexOf("--period");
		const period = periodIdx >= 0 ? args[periodIdx + 1] : "daily";
		const adjustIdx = args.indexOf("--adjust");
		const adjust = adjustIdx >= 0 ? args[adjustIdx + 1] : "bfq";
		const batchSizeIdx = args.indexOf("--batch-size");
		const batchSizeStr = batchSizeIdx >= 0 ? args[batchSizeIdx + 1] : undefined;
		const batchSize = batchSizeStr ? parseInt(batchSizeStr, 10) : 500;
		const startIdx = args.indexOf("--start");
		const startDate = startIdx >= 0 ? args[startIdx + 1] : undefined;
		console.log(`Syncing all A-share klines (period=${period}, adjust=${adjust}, batch=${batchSize})...`);
		if (startDate) console.log(`  Explicit start date: ${startDate}`);
		else console.log("  Incremental mode: fetching only missing data");
		const count = await sync.syncAllKlines(period, adjust, batchSize, startDate);
		console.log(`Synced ${count} total kline rows.`);
		store.close();
		return true;
	}

	// --sync-all-fundamentals [--batch-size <n>]
	if (args.includes("--sync-all-fundamentals")) {
		const batchSizeIdx = args.indexOf("--batch-size");
		const batchSizeStr = batchSizeIdx >= 0 ? args[batchSizeIdx + 1] : undefined;
		const batchSize = batchSizeStr ? parseInt(batchSizeStr, 10) : 100;
		console.log(`Syncing all A-share fundamentals (batch=${batchSize})...`);
		const count = await sync.syncAllFundamentals(batchSize);
		console.log(`Synced ${count} total fundamentals records.`);
		store.close();
		return true;
	}

	// --db-stats
	if (args.includes("--db-stats")) {
		const counts = await store.getTableCounts();
		console.log("Database table counts:");
		for (const [table, count] of Object.entries(counts)) {
			console.log(`  ${table}: ${count}`);
		}
		store.close();
		return true;
	}

	// --db-query "SQL"
	const queryIdx = args.indexOf("--db-query");
	if (queryIdx >= 0) {
		const sql = args[queryIdx + 1];
		if (!sql) {
			console.error('Usage: --db-query "SELECT ..."');
			process.exit(1);
		}
		const rows = await store.query(sql);
		console.log(JSON.stringify(rows, null, 2));
		store.close();
		return true;
	}

	store.close();
	return false;
}

// ============================================================================
// Built-in capabilities — tool implementations and routine implementations.
// These are NOT skills; they are the raw capabilities that external skills
// reference by name in their SKILL.md frontmatter.
// ============================================================================

const BUILTIN_TOOLS = new Map<string, AgentTool<any>>([
	["get_quote", getQuoteTool],
	["get_fundamentals", getFundamentalsTool],
	["get_kline", getKlineTool],
	["get_macro", getMacroTool],
	["screen_stocks", screenStocksTool],
	["advanced_screen", advancedScreenTool],
	["compare_stocks", compareStocksTool],
	["get_sector_rotation", getSectorRotationTool],
	["get_concept_stocks", getConceptStocksTool],
	["list_concepts", listConceptsTool],
	["list_industries", listIndustriesTool],
	["get_industry_stocks", getIndustryStocksTool],
	["get_stock_industries", getStockIndustriesTool],
	["backtest_strategy", backtestStrategyTool],
	["manage_stock_pool", manageStockPoolTool],
	["get_stock_news", getStockNewsTool],
	["screen_by_news", screenByNewsTool],
	["get_market_news", getMarketNewsTool],
	["sync_kline", syncKlineTool],
	["sync_fundamentals", syncFundamentalsTool],
	["sync_news", syncNewsTool],
]);

const BUILTIN_ROUTINES = new Map([
	[
		"pre-market",
		{
			name: "pre-market",
			schedule: "0 9 * * 1-5",
			timezone: "Asia/Shanghai",
			fn: preMarketRoutine,
		},
	],
	[
		"post-market",
		{
			name: "post-market",
			schedule: "30 15 * * 1-5",
			timezone: "Asia/Shanghai",
			fn: postMarketRoutine,
		},
	],
]);

async function main() {
	// Handle sync commands before normal startup
	if (await handleSyncCommands()) return;

	// Initialize local database
	const dataDir = getDataDir();
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataStore(store);
	setDataSync(sync);
	globalStore = store;
	console.log(`[DataStore] Initialized at ${dataDir}/market.db`);
	const modelRegistry = loadModelRegistry();
	const error = modelRegistry.getError();
	if (error) {
		console.warn("Warning: failed to load models.json:", error);
	}

	const model = selectDefaultModel(modelRegistry);
	if (!model) {
		console.error("No models with configured auth found.");
		console.error("Please add a provider to ~/.pi/agent/models.json with a valid apiKey.");
		process.exit(1);
	}

	const config = loadUserConfig();
	const memory = new SessionMemory();

	// ─── Skill Registry ───────────────────────────────────────────
	// Skills are loaded from bundled (packages/trading-agent/skills/) first,
	// then external (~/.agents/skills/). Bundled skills override external
	// ones with the same name. Built-in tools are always available.
	const skillRegistry = new SkillRegistry();
	const skillDirs = discoverAllSkillDirs();

	// Always register built-in tools so they are available regardless of skills
	skillRegistry.registerTools(Array.from(BUILTIN_TOOLS.values()));

	if (skillDirs.length > 0) {
		for (const skillDir of skillDirs) {
			const skillFile = join(skillDir, "SKILL.md");
			const skill = loadSkillFromFile(skillFile);
			if (!skill) continue;

			// Resolve tool names from frontmatter to actual tool objects
			const tools = skill.frontmatter.tools
				?.map((name) => BUILTIN_TOOLS.get(name))
				.filter((t): t is NonNullable<typeof t> => t !== undefined);

			const unresolvedTools = skill.frontmatter.tools?.filter((name) => !BUILTIN_TOOLS.has(name));
			if (unresolvedTools?.length) {
				console.warn(`[Skill] "${skill.name}" references unknown tools: ${unresolvedTools.join(", ")}`);
			}

			// Resolve routine names from frontmatter to actual routine objects
			const routines = skill.frontmatter.routines
				?.map((name) => BUILTIN_ROUTINES.get(name))
				.filter((r): r is NonNullable<typeof r> => r !== undefined);

			const unresolvedRoutines = skill.frontmatter.routines?.filter((name) => !BUILTIN_ROUTINES.has(name));
			if (unresolvedRoutines?.length) {
				console.warn(`[Skill] "${skill.name}" references unknown routines: ${unresolvedRoutines.join(", ")}`);
			}

			skillRegistry.register({ ...skill, tools, routines });
		}
	} else {
		console.log("[Skill] No skills found in bundled or external dirs. All built-in tools are available.");
	}

	const basePrompt = loadSystemPromptFromFile();
	const systemPrompt = skillRegistry.buildSystemPrompt(basePrompt) + memory.getContextString(7);
	const tools = skillRegistry.getAllTools();

	const streamFn = async (model: any, context: any, options?: any) => {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(auth.error);
		}
		return streamSimple(model, context, {
			...options,
			apiKey: auth.apiKey,
			headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
		});
	};

	const session = new TradingSession({
		model,
		baseSystemPrompt: systemPrompt,
		tools,
		getApiKey: (provider) => modelRegistry.authStorage.getApiKey(provider, { includeFallback: true }),
		streamFn,
		beforeToolCall: (context) => {
			const { toolCall } = context;
			const timestamp = new Date().toISOString().slice(11, 23);
			console.log(`\n[${timestamp}] [ToolCall ] ${toolCall.name} args=${JSON.stringify(toolCall.arguments)}`);
			return Promise.resolve(undefined);
		},
		afterToolCall: (context) => {
			const { toolCall, result, isError } = context;
			const timestamp = new Date().toISOString().slice(11, 23);
			const status = isError ? "ERROR" : "OK";
			const firstContent = result.content?.[0];
			const text = firstContent && "text" in firstContent ? firstContent.text : "";
			const preview = text.slice(0, 120).replace(/\n/g, "\\n");
			console.log(
				`[${timestamp}] [ToolResult] ${toolCall.name} status=${status} preview=${preview}${text.length > 120 ? "..." : ""}`,
			);
			return Promise.resolve(undefined);
		},
	});

	// Setup scheduler with routines from skills
	const scheduler = new TaskScheduler();
	const skillRoutines = skillRegistry.getRoutines();
	for (const routine of skillRoutines) {
		// Allow user config to override default schedules
		let schedule = routine.schedule;
		if (routine.name === "pre-market" && config.preMarketSchedule) {
			schedule = config.preMarketSchedule;
		}
		if (routine.name === "post-market" && config.postMarketSchedule) {
			schedule = config.postMarketSchedule;
		}
		scheduler.register({
			...routine,
			schedule,
			timezone: routine.timezone || config.timezone || "Asia/Shanghai",
		});
	}
	scheduler.start(session, memory);

	// Manual trigger commands
	const manualTrigger = async (cmd: string) => {
		if (cmd === "/pre-market") {
			await scheduler.runNow("pre-market", session, memory);
			return true;
		}
		if (cmd === "/post-market") {
			await scheduler.runNow("post-market", session, memory);
			return true;
		}
		return false;
	};

	const useTui = !process.argv.includes("--repl");

	if (useTui) {
		const app = new TradingApp(session, manualTrigger);
		await app.start();
	} else {
		await runRepl(session, scheduler, manualTrigger, tools);
	}
}

async function runRepl(
	session: TradingSession,
	scheduler: TaskScheduler,
	manualTrigger: (cmd: string) => Promise<boolean>,
	tools: { name: string }[],
) {
	console.log(`Investment Analysis Agent — REPL mode`);
	console.log(`Model: ${session.model?.provider ?? "?"} / ${session.model?.id ?? "?"}`);
	console.log(`Tools: ${tools.map((t) => t.name).join(", ")}`);
	console.log(`Commands: /pre-market, /post-market, /quit\n`);

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "trading> ",
	});

	session.on("agent_event", (ev) => {
		if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(ev.assistantMessageEvent.delta);
		}
		if (ev.type === "agent_end") process.stdout.write("\n");
	});

	rl.on("line", async (line) => {
		const input = line.trim();
		if (!input) {
			rl.prompt();
			return;
		}
		if (input === "/quit") {
			scheduler.stop();
			session.dispose();
			rl.close();
			return;
		}

		// Check manual trigger commands
		if (await manualTrigger(input)) {
			rl.prompt();
			return;
		}

		try {
			await session.prompt(input);
			await session.waitForIdle();
		} catch (err) {
			console.error("\nError:", err instanceof Error ? err.message : String(err));
		}
		rl.prompt();
	});

	rl.on("close", () => {
		scheduler.stop();
		session.dispose();
		process.exit(0);
	});

	rl.prompt();
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
