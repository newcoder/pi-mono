import { createDataStore } from "./dist/data/index.js";
import { generateSignals } from "./dist/backtest/strategies.js";

async function main() {
    const store = createDataStore("C:/Users/Administrator/.trading-agent/data");
    await store.init();

    const mod = await import("./dist/data/index.js");
    mod.setDataStore(store);

    const items = await store.getStockPoolItems(53);
    const allStocks = items.map((i) => ({ code: i.code, market: i.market, name: i.name ?? undefined }));

    // Get 601869 klines and ALL signals (not just buy)
    const klines869 = await store.getKlines({
        code: "601869", market: 1, period: "daily", adjust: "bfq",
        start: "2024-05-06", end: "2026-04-30",
    });
    const signals869 = generateSignals(klines869, "ma_cross", {});
    console.log("601869 ALL signals (first 15):");
    for (const s of signals869.slice(0, 15)) {
        const execIdx = s.index + 1;
        const execKline = klines869[execIdx];
        console.log(`  ${s.date} idx=${s.index} type=${s.type} -> exec ${execKline?.date} open=${execKline?.open}`);
    }

    // Check which stocks have buy signals on 2024-06-19
    console.log("\n=== Stocks with BUY signals on 2024-06-19 ===");
    let count = 0;
    for (const stock of allStocks) {
        const klines = await store.getKlines({
            code: stock.code, market: stock.market, period: "daily", adjust: "bfq",
            start: "2024-05-06", end: "2026-04-30",
        });
        if (klines.length === 0) continue;
        const signals = generateSignals(klines, "ma_cross", {});
        for (const s of signals) {
            if (s.type === "buy") {
                const execIdx = s.index + 1;
                if (execIdx < klines.length && klines[execIdx].date === "2024-06-19") {
                    console.log(`  ${stock.code} @${klines[execIdx].open}`);
                    count++;
                    break;
                }
            }
        }
    }
    console.log(`Total stocks with buy signal on 2024-06-19: ${count}`);

    // Now run pool backtest and trace 2024-06-19 specifically
    // We need to patch runPoolBacktest to add logging
    const { runPoolBacktest } = await import("./dist/backtest/engine.js");

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

    const result = await runPoolBacktest(allStocks, config);
    const t869 = result.trades.filter((t) => t.code === "601869");
    console.log(`\n601869 trades in pool: ${t869.length}`);
    if (t869.length > 0) {
        for (const t of t869.slice(0, 5)) {
            console.log(`  ${t.date} ${t.direction} ${t.shares}股 @${t.price.toFixed(2)}`);
        }
    }

    // Find all trades on 2024-06-19
    const trades0619 = result.trades.filter((t) => t.date === "2024-06-19");
    console.log(`\nAll trades on 2024-06-19: ${trades0619.length}`);
    for (const t of trades0619) {
        console.log(`  ${t.code} ${t.direction} ${t.shares}股 @${t.price.toFixed(2)} amount=${t.amount.toFixed(0)}`);
    }

    // Check positions before 2024-06-19
    const tradesBefore = result.trades.filter((t) => t.date < "2024-06-19");
    const buysBefore = tradesBefore.filter((t) => t.direction === "buy");
    const sellsBefore = tradesBefore.filter((t) => t.direction === "sell");
    console.log(`\nTrades before 2024-06-19: ${tradesBefore.length} (buys: ${buysBefore.length}, sells: ${sellsBefore.length})`);

    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
