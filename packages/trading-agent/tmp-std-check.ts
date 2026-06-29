import { createDataStore } from "./src/data/index.js";
const store = createDataStore(`${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`);
await store.init();
const rows = await new Promise<any[]>((resolve, reject) => {
  (store as any).db.all(`SELECT DISTINCT standard FROM industry_synthetic_klines ORDER BY standard`, (err: any, r: any[]) => err ? reject(err) : resolve(r));
});
console.log(rows);
await store.close();
