import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";

const dataDir = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/data`;

async function main() {
	const store = createDataStore(dataDir);
	await store.init();
	setDataStore(store);
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataSync(sync);

	const items = await store.getStockPoolItems(53);
	console.log(`Syncing klines for ${items.length} stocks in pool 53...`);
	for (const item of items) {
		try {
			await sync.syncKline(item.code, item.market, "daily", "bfq", "20230701", "20260630");
		} catch (e) {
			console.warn(`Failed ${item.code}:`, (e as Error).message);
		}
	}
	console.log("Done.");
	store.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
