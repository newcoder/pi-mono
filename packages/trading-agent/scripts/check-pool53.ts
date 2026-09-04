import { createDataStore } from "../src/data/index.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;
console.log("dataDir", dataDir);
const store = createDataStore(dataDir);
await store.init();
console.log("store init ok");
const pools = await store.getStockPools();
console.log("pools count", pools.length);
const pool53 = pools.find((p) => p.id === 53);
console.log("pool53", pool53);
if (pool53) {
	const items = await store.getStockPoolItems(53);
	console.log("items count", items.length);
	console.log(items.slice(0, 10).map((i) => i.code));
}
store.close();
