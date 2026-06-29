#!/usr/bin/env node
/**
 * backtest-baseline — 回测基线/回归测试套件
 *
 * 覆盖所有 18 种策略 × 9 种 rank_by，分别在 4 个股池上运行：
 *   自选股53号, 沪深300, 中证500, 中证1000
 *
 * 配置：初始资金 1亿，满仓等权，最大持仓 20 只，最近三年
 *
 * 用法:
 *   npx tsx scripts/backtest-baseline.ts                    # 运行全部，输出到 baseline-results/
 *   npx tsx scripts/backtest-baseline.ts --quick             # 仅 ZZ500 全矩阵 + 其他池单 rank_by
 *   npx tsx scripts/backtest-baseline.ts --verify            # 对比上次基线结果
 *   npx tsx scripts/backtest-baseline.ts --pool 53           # 仅指定池
 *
 * 输出:
 *   baseline-results/
 *   ├── summary.csv           # 汇总表
 *   ├── results.json          # 完整结构化结果
 *   └── run-YYYYMMDD-HHmmss.log  # 运行日志
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig, PoolBacktestResult, StrategyType } from "../src/backtest/types.js";
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";

// ─── Configuration ─────────────────────────────────────────────

const BASELINE_DIR = "baseline-results";
const OUTPUT_JSON = `${BASELINE_DIR}/results.json`;
const OUTPUT_CSV = `${BASELINE_DIR}/summary.csv`;

const SHARED_CONFIG: Partial<PoolBacktestConfig> = {
	initialCapital: 100_000_000, // 1亿
	maxPositions: 20,
	fullPosition: true,
	fullPositionMode: "equal_weight",
	maxPositionWeight: 0.1,
	slippage: 0.001,
	commission: 0.0003,
	taxRate: 0.0005, // 印花税 0.05% 卖出
	transferFee: 0.00002, // 过户费 0.002% 双向
	skipNoVolume: true,
	minLot: 100,
	period: "daily",
	adjust: "qfq",
};

// 最近三年
const THREE_YEARS_AGO = (() => {
	const d = new Date();
	d.setFullYear(d.getFullYear() - 3);
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
})();
const TODAY = (() => {
	const d = new Date();
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
})();

// ─── Pool definitions ──────────────────────────────────────────

interface PoolDef {
	name: string;
	/** Pool name in DB, or pool ID number */
	lookup: string | number;
}

const POOLS: PoolDef[] = [
	{ name: "自选53", lookup: 53 },
	{ name: "沪深300", lookup: "沪深300" },
	{ name: "中证500", lookup: "中证500" },
	{ name: "中证1000", lookup: "中证1000" },
];

// ─── Strategy matrix ───────────────────────────────────────────

/**
 * 策略分类：
 * - autonomous: 自身产生买卖信号（双向），直接用 strategy 字段
 * - buyOnly: 仅产生买入信号，需要 exitStrategy 来卖出
 * - sellOnly: 仅产生卖出信号，需要 strategy 来买入（配 always_buy）
 */
interface StrategyEntry {
	strategy: StrategyType;
	category: "autonomous" | "buyOnly" | "sellOnly" | "special";
	/** 对于 buyOnly: 配的卖出策略；对于 sellOnly: 必须配合 always_buy */
	exitStrategy?: StrategyType;
	exitParams?: Record<string, number>;
	/** 对于 sellOnly: 是否同时测试 asExitOf（作为 always_buy 的退出） */
	asExitOf?: StrategyType;
}

const STRATEGIES: StrategyEntry[] = [
	// ── Autonomous (dual-direction) ──
	{ strategy: "ma_cross", category: "autonomous" },
	{ strategy: "macd_cross", category: "autonomous" },
	{ strategy: "rsi_reversal", category: "autonomous" },
	{ strategy: "bollinger_breakout", category: "autonomous" },
	{ strategy: "supertrend", category: "autonomous" },
	{ strategy: "tech_composite", category: "autonomous" },

	// ── Buy-only patterns ──
	{ strategy: "hammer", category: "buyOnly", exitStrategy: "time_exit", exitParams: { period: 10 } },
	{ strategy: "bullish_engulf", category: "buyOnly", exitStrategy: "time_exit", exitParams: { period: 10 } },
	{ strategy: "morning_star", category: "buyOnly", exitStrategy: "time_exit", exitParams: { period: 10 } },
	{ strategy: "three_soldiers", category: "buyOnly", exitStrategy: "time_exit", exitParams: { period: 10 } },
	{ strategy: "breakout", category: "buyOnly", exitStrategy: "time_exit", exitParams: { period: 10 } },
	{ strategy: "volume_contraction", category: "buyOnly", exitStrategy: "time_exit", exitParams: { period: 10 } },

	// ── Sell-only patterns (tested as exit strategies paired with always_buy) ──
	{ strategy: "shooting_star", category: "sellOnly", asExitOf: "always_buy" },
	{ strategy: "bearish_engulf", category: "sellOnly", asExitOf: "always_buy" },
	{ strategy: "evening_star", category: "sellOnly", asExitOf: "always_buy" },
	{ strategy: "three_crows", category: "sellOnly", asExitOf: "always_buy" },
	{ strategy: "rsi_overbought_sell", category: "sellOnly", asExitOf: "always_buy" },

	// ── Special cases ──
	// always_buy+time_exit(5d) = 每天买入+5日定时换仓, 用于测试排序因子
	{ strategy: "always_buy", category: "special", exitStrategy: "time_exit", exitParams: { period: 5 } },
];

const RANK_BY_OPTIONS: PoolBacktestConfig["rankBy"][] = [
	"momentum",
	"value",
	"turnover",
	"technical",
	"low_volatility",
	"signal_recency",
	"ma_alignment",
	"weekly_ma_alignment",
	"random",
];

// ─── Types ─────────────────────────────────────────────────────

interface RunResult {
	pool: string;
	strategy: string;
	rankBy: string;
	exitStrategy?: string;
	startDate: string;
	endDate: string;
	totalReturn: number;
	annualizedReturn: number;
	sharpeRatio: number;
	maxDrawdown: number;
	winRate: number;
	profitFactor: number;
	totalTrades: number;
	avgHoldingDays: number;
	filteredTradeCount: number;
	elapsedMs: number;
	error?: string;
}

interface BaselineFile {
	generatedAt: string;
	config: {
		initialCapital: number;
		maxPositions: number;
		start: string;
		end: string;
		pools: string[];
	};
	results: RunResult[];
}

// ─── Helpers ───────────────────────────────────────────────────

function getDataDir(): string {
	return process.env.TRADING_AGENT_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
}

function log(msg: string, stream?: ReturnType<typeof createWriteStream>) {
	const line = `[${new Date().toISOString()}] ${msg}`;
	console.log(line);
	if (stream) stream.write(line + "\n");
}

function metricsFromResult(r: PoolBacktestResult, strategy: string, rankBy: string, exitStrategy?: string): RunResult {
	return {
		pool: "",
		strategy,
		rankBy,
		exitStrategy,
		startDate: r.startDate,
		endDate: r.endDate,
		totalReturn: r.metrics.totalReturn,
		annualizedReturn: r.metrics.annualizedReturn,
		sharpeRatio: r.metrics.sharpeRatio,
		maxDrawdown: r.metrics.maxDrawdown,
		winRate: r.metrics.winRate,
		profitFactor: r.metrics.profitFactor,
		totalTrades: r.metrics.totalTrades,
		avgHoldingDays: r.metrics.avgHoldingDays,
		filteredTradeCount: r.filteredTradeCount,
		elapsedMs: r.elapsedMs,
	};
}

function formatRow(r: RunResult): string {
	return [
		r.pool,
		r.strategy,
		r.rankBy,
		r.exitStrategy ?? "",
		r.totalReturn.toFixed(2),
		r.annualizedReturn.toFixed(2),
		r.sharpeRatio.toFixed(2),
		r.maxDrawdown.toFixed(2),
		r.winRate.toFixed(2),
		r.profitFactor.toFixed(2),
		r.totalTrades,
		r.avgHoldingDays.toFixed(1),
		r.filteredTradeCount,
		r.elapsedMs,
		r.error ?? "",
	].join(",");
}

const CSV_HEADER =
	"pool,strategy,rankBy,exitStrategy,totalReturn,annualizedReturn,sharpeRatio,maxDrawdown,winRate,profitFactor,totalTrades,avgHoldingDays,filteredTradeCount,elapsedMs,error";

// ─── Pool lookup ───────────────────────────────────────────────

async function resolvePool(
	store: ReturnType<typeof createDataStore>,
	def: PoolDef,
): Promise<{ id: number; name: string; stocks: Array<{ code: string; market: number; name?: string }> } | null> {
	let pool;
	if (typeof def.lookup === "number") {
		pool = await store.getStockPoolById(def.lookup);
	} else {
		pool = await store.getStockPoolByName(def.lookup);
	}
	if (!pool) {
		console.warn(`Pool not found: ${def.name} (lookup: ${def.lookup})`);
		return null;
	}
	const items = await store.getStockPoolItems(pool.id);
	if (items.length === 0) {
		console.warn(`Pool empty: ${def.name} (id=${pool.id})`);
		return null;
	}
	return {
		id: pool.id,
		name: def.name,
		stocks: items.map((item) => ({
			code: item.code,
			market: item.market,
			name: item.name ?? undefined,
		})),
	};
}

// ─── Build config for a strategy entry ─────────────────────────

function buildConfig(entry: StrategyEntry, rankBy: PoolBacktestConfig["rankBy"]): PoolBacktestConfig {
	const base: PoolBacktestConfig = {
		...SHARED_CONFIG,
		start: SHARED_CONFIG.start ?? THREE_YEARS_AGO,
		end: SHARED_CONFIG.end ?? TODAY,
		rankBy,
	};

	switch (entry.category) {
		case "autonomous":
			return { ...base, strategy: entry.strategy };

		case "buyOnly":
			return {
				...base,
				strategy: entry.strategy,
				exitStrategy: entry.exitStrategy,
				exitStrategyParams: entry.exitParams ?? {},
			};

		case "sellOnly":
			// Test as exit strategy: always_buy enters, this strategy exits
			return {
				...base,
				strategy: entry.asExitOf!,
				exitStrategy: entry.strategy,
			};

		case "special":
			if (entry.strategy === "always_buy") {
				return {
					...base,
					strategy: "always_buy",
					exitStrategy: entry.exitStrategy,
					exitStrategyParams: entry.exitParams ?? {},
				};
			}
			if (entry.strategy === "time_exit") {
				return {
					...base,
					strategy: entry.asExitOf!,
					exitStrategy: "time_exit",
					exitStrategyParams: { period: 5 },
				};
			}
			return { ...base, strategy: entry.strategy };

		default:
			return { ...base, strategy: entry.strategy };
	}
}

function strategyLabel(entry: StrategyEntry): string {
	switch (entry.category) {
		case "sellOnly":
			return `${entry.asExitOf}+${entry.strategy}`;
		case "buyOnly":
			return `${entry.strategy}+${entry.exitStrategy}`;
		case "special":
			if (entry.strategy === "time_exit") return `${entry.asExitOf}+time_exit`;
			return `${entry.strategy}+${entry.exitStrategy}`;
		default:
			return entry.strategy;
	}
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	const quickMode = args.includes("--quick");
	const verifyMode = args.includes("--verify");
	const singlePool = args.includes("--pool") ? Number(args[args.indexOf("--pool") + 1]) : undefined;

	// Ensure output dir
	await mkdir(BASELINE_DIR, { recursive: true });

	const logPath = `${BASELINE_DIR}/run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
	const logStream = createWriteStream(logPath, { flags: "a" });

	log("═══════════════════════════════════════", logStream);
	log("  backtest-baseline — 回测基线套件", logStream);
	log("═══════════════════════════════════════", logStream);
	log(`  启动时间: ${new Date().toISOString()}`, logStream);
	log(`  模式: ${verifyMode ? "验证对比" : quickMode ? "快速" : "完整"}`, logStream);
	log(`  时间段: ${THREE_YEARS_AGO} ~ ${TODAY}`, logStream);
	log("", logStream);

	// Init data store
	const dataDir = getDataDir();
	log(`  数据目录: ${dataDir}`, logStream);
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataStore(store);

	// Resolve pools
	const resolvedPools: Array<{ name: string; stocks: Array<{ code: string; market: number; name?: string }> }> = [];
	for (const def of POOLS) {
		if (singlePool !== undefined && typeof def.lookup === "number" && def.lookup !== singlePool) continue;
		const resolved = await resolvePool(store, def);
		if (resolved) {
			resolvedPools.push({ name: resolved.name, stocks: resolved.stocks });
			log(`  ✓ ${resolved.name}: ${resolved.stocks.length} stocks`, logStream);
		}
	}

	if (resolvedPools.length === 0) {
		log("ERROR: No pools resolved. Exiting.", logStream);
		process.exit(1);
	}

	// Determine test matrix
	// Quick mode: full matrix on ZZ500, single rank_by on other pools
	// Full mode: full matrix on all pools
	const referencePool = resolvedPools.find((p) => p.name === "中证500") ?? resolvedPools[0];

	const allResults: RunResult[] = [];
	let totalRuns = 0;
	let completedRuns = 0;

	// Calculate total
	if (quickMode) {
		// All pools: each strategy × 1 (momentum)
		// Plus ZZ500: each strategy × all 9 rank_by
		totalRuns = resolvedPools.length * STRATEGIES.length + STRATEGIES.length * (RANK_BY_OPTIONS.length - 1);
	} else {
		totalRuns = resolvedPools.length * STRATEGIES.length * (verifyMode ? 1 : RANK_BY_OPTIONS.length);
	}

	log(`\n  预计运行次数: ${totalRuns}`, logStream);
	const tStart = performance.now();

	for (const pool of resolvedPools) {
		const isReference = pool.name === referencePool.name;
		const rankByOptions =
			quickMode && !isReference ? ["momentum"] : verifyMode ? ["momentum"] : RANK_BY_OPTIONS;

		for (const entry of STRATEGIES) {
			for (const rankBy of rankByOptions) {
				completedRuns++;
				const config = buildConfig(entry, rankBy);
				const label = strategyLabel(entry);

				const runLog = `[${completedRuns}/${totalRuns}] ${pool.name} / ${label} / ${rankBy}`;
				process.stdout.write(`\r${runLog}...`);

				try {
					const result = await runPoolBacktest(pool.stocks, config);
					const rr = metricsFromResult(result, label, rankBy ?? "none", entry.exitStrategy);
					rr.pool = pool.name;
					allResults.push(rr);

					log(
						`  ${runLog} | 收益=${rr.totalReturn.toFixed(1)}% 夏普=${rr.sharpeRatio.toFixed(2)} 回撤=${rr.maxDrawdown.toFixed(1)}% 交易=${rr.totalTrades} [${(rr.elapsedMs / 1000).toFixed(1)}s]`,
						logStream,
					);
				} catch (err) {
					const rr: RunResult = {
						pool: pool.name,
						strategy: label,
						rankBy: rankBy ?? "none",
						startDate: "",
						endDate: "",
						totalReturn: 0,
						annualizedReturn: 0,
						sharpeRatio: 0,
						maxDrawdown: 0,
						winRate: 0,
						profitFactor: 0,
						totalTrades: 0,
						avgHoldingDays: 0,
						filteredTradeCount: 0,
						elapsedMs: 0,
						error: err instanceof Error ? err.message : String(err),
					};
					allResults.push(rr);
					log(`  ${runLog} | ERROR: ${rr.error}`, logStream);
				}
			}
		}
	}

	const elapsed = ((performance.now() - tStart) / 1000).toFixed(1);
	log(`\n  全部完成! 耗时 ${elapsed}s, ${allResults.length} 个结果`, logStream);

	// ─── Write outputs ──────────────────────────────────────────

	// JSON
	const baseline: BaselineFile = {
		generatedAt: new Date().toISOString(),
		config: {
			initialCapital: SHARED_CONFIG.initialCapital ?? 100_000_000,
			maxPositions: SHARED_CONFIG.maxPositions ?? 20,
			start: THREE_YEARS_AGO,
			end: TODAY,
			pools: resolvedPools.map((p) => p.name),
		},
		results: allResults,
	};

	await writeFile(OUTPUT_JSON, JSON.stringify(baseline, null, 2), "utf-8");
	log(`  JSON → ${OUTPUT_JSON}`, logStream);

	// CSV
	const csvLines = [CSV_HEADER, ...allResults.map(formatRow)];
	await writeFile(OUTPUT_CSV, csvLines.join("\n") + "\n", "utf-8");
	log(`  CSV → ${OUTPUT_CSV}`, logStream);

	// ─── Summary ────────────────────────────────────────────────

	const errors = allResults.filter((r) => r.error);
	const success = allResults.filter((r) => !r.error);
	log(`\n───────────────────────────────────────`, logStream);
	log(`  概要`, logStream);
	log(`───────────────────────────────────────`, logStream);
	log(`  成功: ${success.length}  失败: ${errors.length}`, logStream);

	if (success.length > 0) {
		const sortedByReturn = [...success].sort((a, b) => b.totalReturn - a.totalReturn);
		const sortedBySharpe = [...success].sort((a, b) => b.sharpeRatio - a.sharpeRatio);
		log(`\n  Top 10 总收益:`, logStream);
		for (const r of sortedByReturn.slice(0, 10)) {
			log(
				`    ${r.pool.padEnd(8)} ${r.strategy.padEnd(22)} ${(r.rankBy ?? "").padEnd(18)} 收益=${r.totalReturn.toFixed(1).padStart(8)}%  夏普=${r.sharpeRatio.toFixed(2).padStart(6)}  回撤=${r.maxDrawdown.toFixed(1).padStart(6)}%`,
				logStream,
			);
		}
		log(`\n  Top 10 夏普:`, logStream);
		for (const r of sortedBySharpe.slice(0, 10)) {
			log(
				`    ${r.pool.padEnd(8)} ${r.strategy.padEnd(22)} ${(r.rankBy ?? "").padEnd(18)} 夏普=${r.sharpeRatio.toFixed(2).padStart(6)}  收益=${r.totalReturn.toFixed(1).padStart(8)}%`,
				logStream,
			);
		}
	}

	if (errors.length > 0) {
		log(`\n  失败列表:`, logStream);
		for (const r of errors) {
			log(`    ${r.pool} / ${r.strategy} / ${r.rankBy}: ${r.error}`, logStream);
		}
	}

	// ─── Verify against previous baseline ───────────────────────

	if (verifyMode) {
		log(`\n───────────────────────────────────────`, logStream);
		log(`  验证对比`, logStream);
		log(`───────────────────────────────────────`, logStream);

		const baselinePath = `${BASELINE_DIR}/baseline.json`;
		try {
			const prevRaw = await readFile(baselinePath, "utf-8");
			const prev: BaselineFile = JSON.parse(prevRaw);
			const prevMap = new Map<string, RunResult>();
			for (const r of prev.results) {
				prevMap.set(`${r.pool}|${r.strategy}|${r.rankBy}`, r);
			}

			let diffs = 0;
			const deltaPct = (a: number, b: number) => (Math.abs(b) < 0.001 ? 0 : ((a - b) / Math.abs(b)) * 100);

			for (const cur of success) {
				const key = `${cur.pool}|${cur.strategy}|${cur.rankBy}`;
				const prev_run = prevMap.get(key);
				if (!prev_run) {
					log(`  NEW  ${key}`, logStream);
					diffs++;
					continue;
				}
				const retDelta = deltaPct(cur.totalReturn, prev_run.totalReturn);
				const sharpeDelta = deltaPct(cur.sharpeRatio, prev_run.sharpeRatio);
				if (Math.abs(retDelta) > 5 || Math.abs(sharpeDelta) > 5) {
					log(
						`  DIFF ${key}: 收益 ${prev_run.totalReturn.toFixed(1)}→${cur.totalReturn.toFixed(1)}% (${retDelta > 0 ? "+" : ""}${retDelta.toFixed(1)}%)  夏普 ${prev_run.sharpeRatio.toFixed(2)}→${cur.sharpeRatio.toFixed(2)} (${sharpeDelta > 0 ? "+" : ""}${sharpeDelta.toFixed(1)}%)`,
						logStream,
					);
					diffs++;
				}
			}

			// Check for removed
			for (const prev_run of prev.results) {
				const key = `${prev_run.pool}|${prev_run.strategy}|${prev_run.rankBy}`;
				if (!success.some((s) => `${s.pool}|${s.strategy}|${s.rankBy}` === key)) {
					log(`  MISS ${key}`, logStream);
					diffs++;
				}
			}

			log(`  ${diffs > 0 ? `⚠ ${diffs} 差异` : "✓ 全部一致 (5% 阈值内)"}`, logStream);
		} catch {
			log(`  未找到基线文件 ${baselinePath}`, logStream);
			log(`  将当前结果保存为基线: ${baselinePath}`, logStream);
			await writeFile(baselinePath, JSON.stringify(baseline, null, 2), "utf-8");
		}
	}

	// Always save a copy as the latest baseline reference
	await writeFile(`${BASELINE_DIR}/baseline.json`, JSON.stringify(baseline, null, 2), "utf-8");

	log(`\n  日志 → ${logPath}`, logStream);
	logStream.end();
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
