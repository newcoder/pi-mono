import { requireStore, requireSync } from "../data/index.js";
import { runJsonScript } from "../tools/_utils.js";

interface SyncTask {
	code: string;
	market: number;
	name?: string;
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function isMarketHours(): boolean {
	const now = new Date();
	const h = now.getHours();
	const m = now.getMinutes();
	const day = now.getDay();
	// Monday-Friday, 9:30-11:30, 13:00-15:00 CST
	if (day === 0 || day === 6) return false;
	const time = h * 60 + m;
	return (time >= 570 && time <= 690) || (time >= 780 && time <= 900);
}

export class BackgroundSyncService {
	private quoteTimer: ReturnType<typeof setInterval> | null = null;
	private klineTimer: ReturnType<typeof setInterval> | null = null;
	private indexTimer: ReturnType<typeof setInterval> | null = null;
	private isRunning = false;

	/**
	 * Start background sync loops.
	 * @param quoteIntervalMs quote sync interval (default: 60s during market hours)
	 * @param klineIntervalMs kline sync interval (default: 5min)
	 * @param indexIntervalMs index sync interval (default: 30s during market hours)
	 */
	start(quoteIntervalMs = 60_000, klineIntervalMs = 5 * 60_000, indexIntervalMs = 30_000) {
		if (this.isRunning) return;
		this.isRunning = true;
		console.log("[BackgroundSync] Starting background sync service...");

		// Index sync loop — always run, but more frequent during market hours
		this.indexTimer = setInterval(async () => {
			if (!isMarketHours()) return;
			try {
				await this.syncIndices();
			} catch (e) {
				console.warn("[BackgroundSync] Index sync failed:", e);
			}
		}, indexIntervalMs);

		// Quote sync loop — only during market hours
		this.quoteTimer = setInterval(async () => {
			if (!isMarketHours()) return;
			try {
				await this.syncPoolQuotes();
			} catch (e) {
				console.warn("[BackgroundSync] Quote sync failed:", e);
			}
		}, quoteIntervalMs);

		// Kline sync loop — runs always, but less frequently
		this.klineTimer = setInterval(async () => {
			try {
				await this.syncPoolKlines();
			} catch (e) {
				console.warn("[BackgroundSync] Kline sync failed:", e);
			}
		}, klineIntervalMs);

		// Initial sync on startup
		this.runInitialSync().catch((e) => console.warn("[BackgroundSync] Initial sync failed:", e));
	}

	stop() {
		if (!this.isRunning) return;
		this.isRunning = false;
		console.log("[BackgroundSync] Stopping background sync service...");
		if (this.quoteTimer) clearInterval(this.quoteTimer);
		if (this.klineTimer) clearInterval(this.klineTimer);
		if (this.indexTimer) clearInterval(this.indexTimer);
		this.quoteTimer = null;
		this.klineTimer = null;
		this.indexTimer = null;
	}

	/** Trigger a full on-demand sync. Returns summary of what was synced. */
	async syncAll(): Promise<{ indices: number; quotes: number; klines: number; errors: string[] }> {
		const errors: string[] = [];
		let indices = 0;
		let quotes = 0;
		let klines = 0;

		try {
			indices = await this.syncIndices();
		} catch (e) {
			errors.push(`indices: ${e instanceof Error ? e.message : String(e)}`);
		}

		try {
			quotes = await this.syncPoolQuotes();
		} catch (e) {
			errors.push(`quotes: ${e instanceof Error ? e.message : String(e)}`);
		}

		try {
			klines = await this.syncPoolKlines();
		} catch (e) {
			errors.push(`klines: ${e instanceof Error ? e.message : String(e)}`);
		}

		return { indices, quotes, klines, errors };
	}

	private async runInitialSync() {
		console.log("[BackgroundSync] Running initial sync...");
		try {
			await this.syncIndices();
		} catch (e) {
			console.warn("[BackgroundSync] Initial index sync failed:", e);
		}
		try {
			await this.syncPoolQuotes();
		} catch (e) {
			console.warn("[BackgroundSync] Initial quote sync failed:", e);
		}
		try {
			await this.syncPoolKlines();
		} catch (e) {
			console.warn("[BackgroundSync] Initial kline sync failed:", e);
		}
		console.log("[BackgroundSync] Initial sync complete.");
	}

	/** Sync the 6 major indices. Returns number of indices synced. */
	private async syncIndices(): Promise<number> {
		const store = requireStore();
		const indices = [
			{ code: "000001", market: 1, name: "上证指数" },
			{ code: "399001", market: 0, name: "深证成指" },
			{ code: "399006", market: 0, name: "创业板指" },
			{ code: "000688", market: 1, name: "科创50" },
			{ code: "000300", market: 1, name: "沪深300" },
			{ code: "000905", market: 1, name: "中证500" },
		];
		const codeList = indices.map((i) => i.code).join(",");

		try {
			const quotes = await runJsonScript("get_index_quotes.py", ["--codes", codeList], 30000);
			const now = new Date().toISOString();
			for (const q of quotes) {
				const idx = indices.find((i) => i.code === q.code);
				if (!idx) continue;
				await store.saveQuote({
					code: q.code,
					market: idx.market,
					snapshot_date: todayStr(),
					name: q.name || idx.name,
					latest: q.price ?? null,
					open: null,
					high: null,
					low: null,
					prev_close: null,
					volume: null,
					turnover: null,
					change_pct: q.change_pct ?? null,
					pe: null,
					pb: null,
					total_cap: null,
					float_cap: null,
					high_52w: null,
					low_52w: null,
					updated_at: now,
				});
			}
			console.log(`[BackgroundSync] Synced ${quotes.length}/${indices.length} indices`);
			return quotes.length;
		} catch (e) {
			console.warn("[BackgroundSync] Index sync via get_index_quotes.py failed:", e);
			// Fallback: try per-index via getQuoteWithCache
			let synced = 0;
			const sync = requireSync();
			for (const idx of indices) {
				try {
					await sync.getQuoteWithCache(idx.code, idx.market);
					synced++;
				} catch (e2) {
					console.warn(`[BackgroundSync] Fallback sync failed for index ${idx.code}:`, e2);
				}
			}
			return synced;
		}
	}

	/** Sync real-time quotes for all stocks in stock pools. Returns number of stocks synced. */
	private async syncPoolQuotes(): Promise<number> {
		const store = requireStore();
		const sync = requireSync();
		const stocks = await this.getPoolStocks(store);
		if (stocks.length === 0) return 0;

		let synced = 0;
		for (const s of stocks) {
			try {
				await sync.getQuoteWithCache(s.code, s.market);
				synced++;
			} catch (e) {
				console.warn(`[BackgroundSync] Failed to sync quote ${s.code}:`, e);
			}
		}
		if (synced > 0) {
			console.log(`[BackgroundSync] Synced ${synced}/${stocks.length} pool quotes`);
		}
		return synced;
	}

	/** Sync daily klines for all stocks in stock pools. Returns number of stocks synced. */
	private async syncPoolKlines(): Promise<number> {
		const store = requireStore();
		const sync = requireSync();
		const stocks = await this.getPoolStocks(store);
		if (stocks.length === 0) return 0;

		let synced = 0;
		for (const s of stocks) {
			try {
				await sync.syncKline(s.code, s.market, "daily", "bfq");
				synced++;
			} catch (e) {
				console.warn(`[BackgroundSync] Failed to sync kline ${s.code}:`, e);
			}
		}
		if (synced > 0) {
			console.log(`[BackgroundSync] Synced ${synced}/${stocks.length} pool klines`);
		}
		return synced;
	}

	/** Get unique stocks from all stock pools. */
	private async getPoolStocks(store: any): Promise<SyncTask[]> {
		try {
			const pools = await store.getStockPools();
			const seen = new Map<string, SyncTask>();
			for (const pool of pools) {
				try {
					const items = await store.getStockPoolItems(pool.id);
					for (const item of items) {
						const code = item.code;
						if (!seen.has(code)) {
							seen.set(code, {
								code,
								market: code.startsWith("6") ? 1 : 0,
								name: item.name,
							});
						}
					}
				} catch (e) {
					console.warn(`[BackgroundSync] Failed to get pool ${pool.id} items:`, e);
				}
			}
			return Array.from(seen.values());
		} catch (e) {
			console.warn("[BackgroundSync] Failed to get stock pools:", e);
			return [];
		}
	}
}
