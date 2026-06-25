import { createDataStore } from "./dist/data/index.js";
import { runPoolBacktest } from "./dist/backtest/engine.js";

async function main() {
    const store = createDataStore("C:/Users/Administrator/.trading-agent/data");
    await store.init();

    const mod = await import("./dist/data/index.js");
    mod.setDataStore(store);

    const items = await store.getStockPoolItems(53);
    const allStocks = items.map((i) => ({ code: i.code, market: i.market, name: i.name ?? undefined }));

    const config = {
        strategy: "ma_cross",
        start: "20240506",
        end: "20260430",
        period: "daily",
        adjust: "bfq",
        initialCapital: 100_000,
        slippage: 0.001,
        commission: 0.0003,
    };

    // Run backtest and capture daily state for 001309
    console.log("=== Running pool backtest with detailed logging ===\n");

    // Import engine internals to inspect
    const { generateSignals } = await import("./dist/backtest/strategies.js");

    // Get 001309 klines and signals
    const klines1309 = await store.getKlines({
        code: "001309", market: 0, period: "daily", adjust: "bfq",
        start: "2024-05-06", end: "2026-04-30",
    });
    const signals1309 = generateSignals(klines1309, "ma_cross", {});
    console.log(`001309: ${klines1309.length} klines, ${signals1309.length} signals`);
    console.log("Buy signals:");
    for (const s of signals1309.filter((s) => s.type === "buy").slice(0, 10)) {
        const execIdx = s.index + 1;
        const execKline = klines1309[execIdx];
        console.log(`  ${s.date} (idx=${s.index}) -> exec ${execKline?.date} open=${execKline?.open}`);
    }

    // Get 601869 klines and signals
    const klines869 = await store.getKlines({
        code: "601869", market: 1, period: "daily", adjust: "bfq",
        start: "2024-05-06", end: "2026-04-30",
    });
    const signals869 = generateSignals(klines869, "ma_cross", {});
    console.log(`\n601869: ${klines869.length} klines, ${signals869.length} signals`);
    console.log("Buy signals:");
    for (const s of signals869.filter((s) => s.type === "buy").slice(0, 10)) {
        const execIdx = s.index + 1;
        const execKline = klines869[execIdx];
        console.log(`  ${s.date} (idx=${s.index}) -> exec ${execKline?.date} open=${execKline?.open}`);
    }

    // Now run the pool backtest and check what happens on specific dates
    const result = await runPoolBacktest(allStocks, config);
    console.log(`\n=== Pool result: ${result.stocks.length} stocks, ${result.trades.length} trades ===`);

    // Check specific dates
    const buyDates1309 = signals1309.filter((s) => s.type === "buy").map((s) => {
        const execIdx = s.index + 1;
        return klines1309[execIdx]?.date;
    });

    console.log("\n=== Checking 001309 buy signal execution dates ===");
    for (const date of buyDates1309.slice(0, 5)) {
        const tradesOnDate = result.trades.filter((t) => t.date === date);
        const buyTrades = tradesOnDate.filter((t) => t.direction === "buy");
        console.log(`Date ${date}: total trades=${tradesOnDate.length}, buys=${buyTrades.length}`);
        if (buyTrades.length > 0) {
            console.log(`  First few buys: ${buyTrades.slice(0, 3).map((t) => `${t.code}@${t.price.toFixed(0)}`).join(", ")}`);
        }
        const t1309 = result.trades.find((t) => t.date === date && t.code === "001309");
        console.log(`  001309 on this date: ${t1309 ? `${t1309.direction} ${t1309.shares}股 @${t1309.price.toFixed(2)}` : "NO TRADE"}`);
    }

    // Compute what maxBuyAmount would be on first signal day
    console.log("\n=== Simulating first buy day ===");
    const firstBuyDate = buyDates1309[0]; // 2024-05-24
    const tradesBeforeFirstBuy = result.trades.filter((t) => t.date < firstBuyDate && t.direction === "buy");
    const cashSpentBefore = tradesBeforeFirstBuy.reduce((sum, t) => sum + t.amount, 0);
    console.log(`First buy date for 001309: ${firstBuyDate}`);
    console.log(`Trades before this date: ${result.trades.filter((t) => t.date < firstBuyDate).length}`);
    console.log(`Buy trades before this date: ${tradesBeforeFirstBuy.length}`);
    console.log(`Cash spent before: ${cashSpentBefore.toFixed(0)}`);

    // Find 001309's position in sortedCandidates
    const sortedCodes = allStocks.map((s) => s.code).sort();
    const idx1309 = sortedCodes.indexOf("001309");
    console.log(`\n001309 position in sorted candidate list: ${idx1309} / ${sortedCodes.length}`);

    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
