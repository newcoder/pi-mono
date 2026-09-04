#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDataStore, DataSyncService, setDataStore, setDataSync } from "../src/data/index.js";

const dataDir = process.env.TRADING_AGENT_DATA_DIR || join(process.env.HOME || process.env.USERPROFILE || ".", ".trading-agent", "data");

async function main() {
	const indexSymbol = process.argv[2];
	const poolName = process.argv[3];
	if (!indexSymbol || !poolName) {
		console.error("Usage: npx tsx scripts/create-index-pool.ts <index_symbol> <pool_name>");
		console.error("Example: npx tsx scripts/create-index-pool.ts 000852 中证1000");
		process.exit(1);
	}

	const store = createDataStore(dataDir);
	await store.init();
	const sync = new DataSyncService(store);
	await sync.initStorageDir(join(dataDir, "market.db"));
	setDataStore(store);
	setDataSync(sync);

	console.log(`Fetching ${poolName} (${indexSymbol}) constituents from akshare...`);
	const tmpDir = await mkdtemp(join(tmpdir(), "index-pool-"));
	const tmpFile = join(tmpDir, "constituents.json");

	const pythonScript = `
import akshare as ak, json, sys
symbol = sys.argv[1]
df = ak.index_stock_cons_weight_csindex(symbol=symbol)
rows = []
for _, r in df.iterrows():
    code = str(r.iloc[4]).zfill(6)
    name = str(r.iloc[5])
    rows.append({"code": code, "name": name})
with open(r"${tmpFile.replace(/\\/g, "\\\\")}", "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False)
print(len(rows))
`;
	await writeFile(join(tmpDir, "fetch.py"), pythonScript, "utf-8");
	const output = execSync(`python "${join(tmpDir, "fetch.py")}" "${indexSymbol}"`, {
		encoding: "utf-8",
		env: { ...process.env, PYTHONIOENCODING: "utf-8" },
		timeout: 120_000,
	});
	console.log(`Fetched ${output.trim()} constituents`);

	const raw = JSON.parse(await readFile(tmpFile, "utf-8")) as Array<{ code: string; name: string }>;
	const stocks = raw.map((r) => ({
		code: r.code,
		market: r.code.startsWith("6") ? 1 : 0,
		name: r.name,
	}));

	const existing = await store.getStockPoolByName(poolName);
	if (existing) {
		console.log(`Pool "${poolName}" already exists (ID: ${existing.id}). Deleting old items...`);
		await store.deleteStockPool(existing.id);
	}

	const poolId = await store.createStockPool(poolName, `${poolName}指数成分股`);
	await store.addToStockPool(poolId, stocks);
	console.log(`Created pool "${poolName}" (ID: ${poolId}) with ${stocks.length} stocks`);

	await rm(tmpDir, { recursive: true, force: true });
	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
