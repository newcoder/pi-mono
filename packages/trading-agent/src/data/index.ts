import type { DataStore } from "./data-store.js";
import type { DataSyncService } from "./data-sync.js";

// Shared references set during application initialization
let _store: DataStore | null = null;
let _sync: DataSyncService | null = null;

export function setDataStore(store: DataStore): void {
	_store = store;
}

export function getDataStore(): DataStore | null {
	return _store;
}

export function setDataSync(sync: DataSyncService): void {
	_sync = sync;
}

export function getDataSync(): DataSyncService | null {
	return _sync;
}

export function requireStore(): DataStore {
	if (!_store) throw new Error("DataStore not initialized. Call setDataStore() first.");
	return _store;
}

export function requireSync(): DataSyncService {
	if (!_sync) throw new Error("DataSyncService not initialized. Call setDataSync() first.");
	return _sync;
}

export * from "./data-store.js";
export * from "./data-sync.js";
export * from "./types.js";
