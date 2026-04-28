import { createDataStore, DataSyncService } from "../src/data/index.js";

async function main() {
	const dataDir = process.env.TRADING_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE}/.trading-agent/data`;
	const store = createDataStore(dataDir);
	await store.init();

	const sync = new DataSyncService(store);

	const periods = [
		{ name: "weekly", label: "周线" },
		{ name: "monthly", label: "月线" },
	];

	for (const { name, label } of periods) {
		console.log(`\n========== 开始同步全市场${label} ==========`);
		const startTime = Date.now();
		try {
			const count = await sync.syncAllKlines(name, "bfq", 500);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			console.log(`[完成] ${label}同步完成: ${count} 条K线, 耗时 ${elapsed}s`);
		} catch (e) {
			console.error(`[失败] ${label}同步失败:`, e);
		}
	}

	store.close();
	console.log("\n全部同步完成");
}

main().catch((e) => {
	console.error("程序异常:", e);
	process.exit(1);
});
