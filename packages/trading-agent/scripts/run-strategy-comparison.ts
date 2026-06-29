#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { runPoolBacktest } from "../src/backtest/engine.js";
import type { PoolBacktestConfig, StrategyType } from "../src/backtest/types.js";
import { generatePoolBacktestReport } from "../src/report/pool-report.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(homedir(), ".trading-agent", "data");
const POOL_ID = Number(process.argv[2]) || 53;
const START = "20230626";
const END = "20260626";
const INITIAL_CAPITAL = 100_000_000;

const STRATEGIES: StrategyType[] = [
	"ma_cross",
	"macd_cross",
	"rsi_reversal",
	"bollinger_breakout",
	"supertrend",
	"hammer",
	"bullish_engulf",
	"morning_star",
	"three_soldiers",
	"tech_composite",
	"breakout",
	"volume_contraction",
];

const RANK_BY: Array<"ma_alignment" | "low_volatility" | "weekly_ma_alignment"> = [
	"ma_alignment",
	"low_volatility",
	"weekly_ma_alignment",
];

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(join(dataDir, "market.db"));
	setDataStore(store);
	setDataSync(sync);

	const pool = await store.getStockPoolById(POOL_ID);
	if (!pool) throw new Error(`Pool ${POOL_ID} not found`);
	const items = await store.getStockPoolItems(pool.id);
	const stocks = items.map((item) => ({ code: item.code, market: item.market, name: item.name ?? undefined }));

	const reportsDir = join(dataDir, "..", "reports");
	await mkdir(reportsDir, { recursive: true });

	const summaryPath = join(reportsDir, `strategy-comparison-${pool.name}-${START}-${END}.csv`);
	const summaryStream = createWriteStream(summaryPath, { encoding: "utf-8" });
	summaryStream.write(
		"strategy,rank_by,total_return_pct,annualized_return_pct,sharpe_ratio,max_drawdown_pct,win_rate_pct,profit_factor,avg_holding_days,total_trades,report_url\n",
	);

	for (const strategy of STRATEGIES) {
		for (const rankBy of RANK_BY) {
			const config: PoolBacktestConfig = {
				strategy,
				start: START,
				end: END,
				period: "daily",
				adjust: "bfq",
				initialCapital: INITIAL_CAPITAL,
				positionSize: 1.0,
				fullPosition: true,
				fullPositionMode: "equal_weight",
				rebalanceThreshold: 0,
				maxPositionWeight: 0.1,
				minTradeAmount: 0,
				slippage: 0.001,
				commission: 0.0003,
				minLot: 100,
				rankBy,
				maxPositions: 20,
				volatilityLookbackDays: 5,
			};

			console.log(`\n[${strategy} / ${rankBy}] running...`);
			const startMs = Date.now();
			let result;
			try {
				result = await runPoolBacktest(stocks, config);
			} catch (err) {
				console.error(`  ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
				summaryStream.write(
					`${strategy},${rankBy},ERROR,ERROR,ERROR,ERROR,ERROR,ERROR,ERROR,ERROR,\n`,
				);
				continue;
			}
			const elapsed = Date.now() - startMs;

			const sellCount = result.trades.filter((t) => t.direction === "sell").length;
			let reportUrl = "";
			try {
				const genResult = await generatePoolBacktestReport(
					{
						title: `${pool.name} ${strategy}(${rankBy}) 批量回测报告`,
						poolName: pool.name,
						strategy,
						startDate: result.startDate,
						endDate: result.endDate,
						initialCapital: result.initialCapital,
						strategyCurve: result.equityCurve.map((p) => ({ date: p.date, equity: p.equity })),
						strategyMetrics: {
							totalReturn: result.metrics.totalReturn,
							annualizedReturn: result.metrics.annualizedReturn,
							sharpeRatio: result.metrics.sharpeRatio,
							maxDrawdown: result.metrics.maxDrawdown,
							maxDrawdownDuration: result.metrics.maxDrawdownDuration,
							winRate: result.metrics.winRate,
							profitFactor: result.metrics.profitFactor,
							avgWin: result.metrics.avgWin,
							avgLoss: result.metrics.avgLoss,
							avgHoldingDays: result.metrics.avgHoldingDays,
							totalTrades: sellCount,
						},
						benchmarks: [],
						trades: result.trades,
					},
					reportsDir,
					"http://localhost:3000",
				);
				reportUrl = genResult.url;
				console.log(`  ✓ report: ${genResult.url}`);
			} catch (err) {
				console.warn(`  ⚠ report generation failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			summaryStream.write(
				`${strategy},${rankBy},` +
					`${result.metrics.totalReturn.toFixed(2)},` +
					`${result.metrics.annualizedReturn.toFixed(2)},` +
					`${result.metrics.sharpeRatio.toFixed(3)},` +
					`${result.metrics.maxDrawdown.toFixed(2)},` +
					`${result.metrics.winRate.toFixed(2)},` +
					`${result.metrics.profitFactor.toFixed(3)},` +
					`${result.metrics.avgHoldingDays.toFixed(2)},` +
					`${sellCount},` +
					`${reportUrl}\n`,
			);
			console.log(
				`  ✓ return ${result.metrics.totalReturn.toFixed(2)}%, sharpe ${result.metrics.sharpeRatio.toFixed(3)}, drawdown ${result.metrics.maxDrawdown.toFixed(2)}% (${elapsed}ms)`,
			);
		}
	}

	summaryStream.end();
	await new Promise<void>((resolve, reject) => {
		summaryStream.on("finish", resolve);
		summaryStream.on("error", reject);
	});
	console.log(`\nSummary CSV: ${summaryPath}`);

	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
