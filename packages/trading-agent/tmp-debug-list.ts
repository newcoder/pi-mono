import { createDataStore } from "./src/data/index.js";
const store = createDataStore(`${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`);
await store.init();
const indices = await store.getIndustryList();
console.log("has BK1714?", indices.some(i => i.code === "BK1714"));
console.log("has BK1711?", indices.some(i => i.code === "BK1711"));
console.log("sample codes", indices.slice(0,10).map(i=>i.code));
const nonEmpty = [];
for (const idx of indices) {
  const s = await store.getIndustryStocks(idx.code, "em");
  if (s.length > 0) nonEmpty.push(idx.code);
}
console.log("non-empty count", nonEmpty.length, nonEmpty.slice(0,10));
await store.close();
