import { createDataStore } from "./src/data/index.js";
const store = createDataStore(`${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`);
await store.init();
const indices = await store.getIndustryList();
console.log("total indices", indices.length);
let count = 0;
for (const idx of indices.slice(0, 50)) {
  const s = await store.getIndustryStocks(idx.code, "em");
  if (s.length > 0) count++;
}
console.log("non-empty in first 50", count);
const s1 = await store.getIndustryStocks("BK1714", "em");
console.log("BK1714", s1.length);
const s2 = await store.getIndustryStocks("BK1711", "em");
console.log("BK1711", s2.length);
await store.close();
