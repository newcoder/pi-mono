import { createDataStore } from "./src/data/index.js";
const store = createDataStore(`${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`);
await store.init();
for (const code of ["BK1714", "BK1711", "BK0420"]) {
  const k = await store.getIndustryKlines(code, "daily");
  console.log(code, k.length, k[k.length-1]?.date);
}
await store.close();
