import { createDataStore } from "./dist/data/index.js";
import { runPoolBacktest } from "./dist/backtest/engine.js";

async function main() {
    const store = createDataStore("C:/Users/Administrator/.trading-agent/data");
    await store.init();

    const mod = await import("./dist/data/index.js");
    mod.setDataStore(store);

    // Get actual pool 53 items
    const pool = await store.getStockPoolById(53);
    console.log(`Pool: ${pool?.name} (ID: ${pool?.id})`);

    const items = await store.getStockPoolItems(53);
    console.log(`Total items: ${items.length}`);

    // Show first 20 items
    console.log("\nFirst 20 items:");
    for (const item of items.slice(0, 20)) {
        const klines = await store.getKlines({
            code: item.code,
            market: item.market,
            period: "daily",
            adjust: "bfq",
            start: "2024-05-06",
            end: "2026-04-30",
        });
        console.log(`  ${item.code} market=${item.market} ${item.name} klines=${klines.length}`);
    }

    // Find 001309 and 601869
    const dm = items.find((i) => i.code === "001309");
    const cf = items.find((i) => i.code === "601869");
    console.log(`\n001309 in pool: ${dm ? `market=${dm.market} name=${dm.name}` : "NOT FOUND"}`);
    console.log(`601869 in pool: ${cf ? `market=${cf.market} name=${cf.name}` : "NOT FOUND"}`);

    // Run pool backtest with first 50 stocks
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

    const first50 = items.slice(0, 50).map((i) => ({ code: i.code, market: i.market, name: i.name ?? undefined }));
    console.log(`\n=== Pool backtest: first 50 stocks ===`);
    const r50 = await runPoolBacktest(first50, config);
    console.log(`  stocks: ${r50.stocks.length}, total trades: ${r50.trades.length}`);

    const t1309_50 = r50.trades.filter((t) => t.code === "001309");
    const t869_50 = r50.trades.filter((t) => t.code === "601869");
    console.log(`  001309 trades: ${t1309_50.length}`);
    console.log(`  601869 trades: ${t869_50.length}`);

    // Run pool backtest with ALL 276 stocks
    const allStocks = items.map((i) => ({ code: i.code, market: i.market, name: i.name ?? undefined }));
    console.log(`\n=== Pool backtest: all ${allStocks.length} stocks ===`);
    const rAll = await runPoolBacktest(allStocks, config);
    console.log(`  stocks with data: ${rAll.stocks.length}, total trades: ${rAll.trades.length}`);

    const t1309_all = rAll.trades.filter((t) => t.code === "001309");
    const t869_all = rAll.trades.filter((t) => t.code === "601869");
    console.log(`  001309 trades: ${t1309_all.length}`);
    console.log(`  601869 trades: ${t869_all.length}`);

    // Run with 1亿
    console.log(`\n=== Pool backtest: all ${allStocks.length} stocks, 1亿 capital ===`);
    const rAll1e = await runPoolBacktest(allStocks, { ...config, initialCapital: 100_000_000 });
    console.log(`  stocks with data: ${rAll1e.stocks.length}, total trades: ${rAll1e.trades.length}`);

    const t1309_1e = rAll1e.trades.filter((t) => t.code === "001309");
    const t869_1e = rAll1e.trades.filter((t) => t.code === "601869");
    console.log(`  001309 trades: ${t1309_1e.length}`);
    console.log(`  601869 trades: ${t869_1e.length}`);

    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
