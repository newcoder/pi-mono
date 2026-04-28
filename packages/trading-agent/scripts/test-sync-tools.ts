import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";
import { syncKlineTool, syncFundamentalsTool, syncNewsTool } from "../src/tools/data-sync.js";

async function main() {
	const dataDir = `${process.env.HOME || process.env.USERPROFILE}/.trading-agent/data`;
	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(`${dataDir}/market.db`);
	setDataStore(store);
	setDataSync(sync);

	console.log("=== 测试 sync_kline (日线) ===");
	const klineResult = await syncKlineTool.execute("test-1", { period: "daily", batchSize: 500 });
	console.log(klineResult.content[0].text);

	console.log("\n=== 测试 sync_news (watchlist) ===");
	const newsResult = await syncNewsTool.execute("test-2", { scope: "watchlist", sources: "cls", limit: 10 });
	console.log(newsResult.content[0].text);

	console.log("\n=== 测试 sync_fundamentals (小批量) ===");
	const fundResult = await syncFundamentalsTool.execute("test-3", { batchSize: 50 });
	console.log(fundResult.content[0].text);

	store.close();
	console.log("\n全部测试通过!");
}

main().catch((e) => {
	console.error("测试失败:", e);
	process.exit(1);
});
