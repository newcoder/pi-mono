import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	setDataStore(store);
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataSync(sync);

	const names = ["沪深300", "中证500", "中证1000", "自选股", "自选53"];
	for (const name of names) {
		const pool = await store.getStockPoolByName(name);
		if (pool) {
			const items = await store.getStockPoolItems(pool.id);
			console.log(`Pool "${name}" id=${pool.id}, items=${items.length}`);
		} else {
			console.log(`Pool "${name}" not found`);
		}
	}

	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
