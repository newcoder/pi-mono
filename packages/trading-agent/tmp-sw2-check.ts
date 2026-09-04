import { createDataStore } from "./src/data/index.js";
const store = createDataStore(`${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`);
await store.init();
const industries = await store.getIndustries("sw_l2", 2);
console.log("sw_l2 industries:", industries.length);
let withKlines = 0;
let withStocks = 0;
for (const ind of industries.slice(0, 20)) {
  const klines = await store.getIndustrySyntheticKlines(ind.industry_code, "sw_l2");
  const stocks = await store.getIndustryStocks(ind.industry_code, "sw_l2");
  if (klines.length > 0) withKlines++;
  if (stocks.length > 0) withStocks++;
  console.log(ind.industry_code, klines.length, stocks.length, ind.name);
}
console.log("sample with klines/stocks:", withKlines, withStocks);
await store.close();
