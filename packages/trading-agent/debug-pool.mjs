import { createDataStore } from "./dist/data/index.js";
import { runBacktest, runPoolBacktest } from "./dist/backtest/engine.js";

async function main() {
    const store = createDataStore("C:/Users/Administrator/.trading-agent/data");
    await store.init();

    // Monkey-patch getDataStore for the engine
    const mod = await import("./dist/data/index.js");
    mod.setDataStore(store);

    const config = {
        strategy: "ma_cross",
        start: "20240506",
        end: "20260430",
        period: "daily",
        adjust: "bfq",
        initialCapital: 100_000,
        positionSize: 1.0,
        slippage: 0.001,
        commission: 0.0003,
    };

    // 1. Single-stock backtest for 001309
    console.log("=== Single-stock: 001309 ===");
    const r1 = await runBacktest({ code: "001309", market: 0, ...config });
    console.log(`  klines: ${r1.klines.length}, signals: ${r1.signals.length}, trades: ${r1.trades.length}`);
    console.log(`  first signal: ${r1.signals[0]?.date} ${r1.signals[0]?.type}`);
    console.log(`  last signal: ${r1.signals[r1.signals.length - 1]?.date} ${r1.signals[r1.signals.length - 1]?.type}`);

    // 2. Single-stock backtest for 601869
    console.log("\n=== Single-stock: 601869 ===");
    const r2 = await runBacktest({ code: "601869", market: 1, ...config });
    console.log(`  klines: ${r2.klines.length}, signals: ${r2.signals.length}, trades: ${r2.trades.length}`);
    console.log(`  first signal: ${r2.signals[0]?.date} ${r2.signals[0]?.type}`);
    console.log(`  last signal: ${r2.signals[r2.signals.length - 1]?.date} ${r2.signals[r2.signals.length - 1]?.type}`);

    // 3. Pool backtest with just these two stocks
    console.log("\n=== Pool backtest: 001309 + 601869 ===");
    const r3 = await runPoolBacktest([
        { code: "001309", market: 0, name: "德明利" },
        { code: "601869", market: 1, name: "长飞光纤" },
    ], config);
    console.log(`  stocks in result: ${r3.stocks.length}, total trades: ${r3.trades.length}`);

    const trades1309 = r3.trades.filter((t) => t.code === "001309");
    const trades869 = r3.trades.filter((t) => t.code === "601869");
    console.log(`  001309 trades: ${trades1309.length} (buys: ${trades1309.filter((t) => t.direction === "buy").length}, sells: ${trades1309.filter((t) => t.direction === "sell").length})`);
    console.log(`  601869 trades: ${trades869.length} (buys: ${trades869.filter((t) => t.direction === "buy").length}, sells: ${trades869.filter((t) => t.direction === "sell").length})`);

    if (trades1309.length > 0) {
        console.log(`  001309 first trade: ${trades1309[0].date} ${trades1309[0].direction}`);
        console.log(`  001309 last trade: ${trades1309[trades1309.length - 1].date} ${trades1309[trades1309.length - 1].direction}`);
    }
    if (trades869.length > 0) {
        console.log(`  601869 first trade: ${trades869[0].date} ${trades869[0].direction}`);
        console.log(`  601869 last trade: ${trades869[trades869.length - 1].date} ${trades869[trades869.length - 1].direction}`);
    }

    // 4. Pool backtest with 53号池的部分股票（模拟大池子）
    console.log("\n=== Pool backtest: 001309 + 601869 + 10 dummy stocks ===");
    const dummyStocks = [
        { code: "600519", market: 1, name: "贵州茅台" },
        { code: "000858", market: 0, name: "五粮液" },
        { code: "600036", market: 1, name: "招商银行" },
        { code: "000001", market: 0, name: "平安银行" },
        { code: "600276", market: 1, name: "恒瑞医药" },
        { code: "002594", market: 0, name: "比亚迪" },
        { code: "601318", market: 1, name: "中国平安" },
        { code: "300750", market: 0, name: "宁德时代" },
        { code: "600887", market: 1, name: "伊利股份" },
        { code: "000333", market: 0, name: "美的集团" },
    ];
    const r4 = await runPoolBacktest([
        ...dummyStocks,
        { code: "001309", market: 0, name: "德明利" },
        { code: "601869", market: 1, name: "长飞光纤" },
    ], { ...config, initialCapital: 1_000_000 });
    console.log(`  stocks in result: ${r4.stocks.length}, total trades: ${r4.trades.length}`);
    const trades1309_4 = r4.trades.filter((t) => t.code === "001309");
    const trades869_4 = r4.trades.filter((t) => t.code === "601869");
    console.log(`  001309 trades: ${trades1309_4.length}`);
    console.log(`  601869 trades: ${trades869_4.length}`);

    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
