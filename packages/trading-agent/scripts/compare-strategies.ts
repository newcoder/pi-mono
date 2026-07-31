
import { runPoolBacktest } from "../src/backtest/engine.js";
import { createDataStore, DataSyncService, setDataStore } from "../src/data/index.js";

const store = createDataStore("C:/Users/Administrator/.trading-agent/data");
await store.init();
new DataSyncService(store).initStorageDir("C:/Users/Administrator/.trading-agent/data/market.db");
setDataStore(store);

const d = new Date(); d.setFullYear(d.getFullYear()-3);
const start = d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0");
const today = new Date();
const end = today.getFullYear()+String(today.getMonth()+1).padStart(2,"0")+String(today.getDate()).padStart(2,"0");
const base = { fullPosition: true, fullPositionMode: "equal_weight", maxPositions: 20, maxPositionWeight: 0.1, initialCapital: 100_000_000, start, end, period: "daily", adjust: "bfq", slippage: 0.001, commission: 0.0003, taxRate: 0.0005, transferFee: 0.00002 };

const pools: Array<{name: string, id: number|string}> = [
    {name: "自选53", id: 53},
    {name: "沪深300", id: "沪深300"},
    {name: "中证500", id: "中证500"},
];

const combos = [
    {strategy: "supertrend", rankBy: "ma_alignment", label: "supertrend+ma"},
    {strategy: "bollinger_breakout", rankBy: "weekly_ma_alignment", label: "bollinger+wma"},
    {strategy: "supertrend", rankBy: "weekly_ma_alignment", label: "supertrend+wma"},
    {strategy: "bollinger_breakout", rankBy: "turnover", label: "bollinger+turnover"},
    {strategy: "rsi_reversal", rankBy: "turnover", label: "rsi+turnover"},
];

const stopConfigs = [
    {label: "无止损", stops: {}},
    {label: "trail15%", stops: {trailingStopPct: 15}},
    {label: "trail10%", stops: {trailingStopPct: 10}},
    {label: "stop8+take30", stops: {stopLossPct: 8, takeProfitPct: 30}},
];

console.log("策略".padEnd(22) + "池".padEnd(8) + stopConfigs.map(s => s.label.padStart(22)).join(""));
console.log("=".repeat(110));

for (const combo of combos) {
    let row = combo.label.padEnd(22);
    for (const pool of pools) {
        let p;
        if (typeof pool.id === "number") p = await store.getStockPoolById(pool.id);
        else p = await store.getStockPoolByName(pool.id);
        if (!p) continue;
        const items = await store.getStockPoolItems(p.id);
        const stocks = items.map((i: any) => ({ code: i.code, market: i.market, name: i.name }));
        
        row = combo.label.padEnd(22) + pool.name.padEnd(8);
        for (const sc of stopConfigs) {
            const config: any = {...base, ...combo, ...sc.stops};
            const r = await runPoolBacktest(stocks, config);
            row += (r.metrics.totalReturn.toFixed(0)+"%").padStart(6) + " S"+r.metrics.sharpeRatio.toFixed(2).padStart(6);
        }
        console.log(row);
    }
    console.log("-".repeat(110));
}
