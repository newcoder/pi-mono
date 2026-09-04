import { createDataStore } from "./dist/data/index.js";
import { runPoolBacktest } from "./dist/backtest/engine.js";

async function main() {
    const store = createDataStore("C:/Users/Administrator/.trading-agent/data");
    await store.init();

    const mod = await import("./dist/data/index.js");
    mod.setDataStore(store);

    const items = await store.getStockPoolItems(53);
    const allStocks = items.map((i) => ({ code: i.code, market: i.market, name: i.name ?? undefined }));

    const config1m = {
        strategy: "ma_cross",
        start: "20240506",
        end: "20260430",
        period: "daily",
        adjust: "bfq",
        initialCapital: 1_000_000,
        slippage: 0.001,
        commission: 0.0003,
    };

    console.log("=== Pool backtest: 276 stocks, 1M capital ===");
    const r1m = await runPoolBacktest(allStocks, config1m);
    console.log(`  stocks: ${r1m.stocks.length}, total trades: ${r1m.trades.length}`);
    console.log(`  001309 trades: ${r1m.trades.filter((t) => t.code === "001309").length}`);
    console.log(`  601869 trades: ${r1m.trades.filter((t) => t.code === "601869").length}`);

    const config100m = {
        strategy: "ma_cross",
        start: "20240506",
        end: "20260430",
        period: "daily",
        adjust: "bfq",
        initialCapital: 100_000_000,
        slippage: 0.001,
        commission: 0.0003,
    };

    console.log("\n=== Pool backtest: 276 stocks, 100M capital ===");
    const r100m = await runPoolBacktest(allStocks, config100m);
    console.log(`  stocks: ${r100m.stocks.length}, total trades: ${r100m.trades.length}`);
    console.log(`  001309 trades: ${r100m.trades.filter((t) => t.code === "001309").length}`);
    console.log(`  601869 trades: ${r100m.trades.filter((t) => t.code === "601869").length}`);

    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
