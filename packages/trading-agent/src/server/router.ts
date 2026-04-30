import type { IncomingMessage, ServerResponse } from "node:http";
import { requireStore, requireSync } from "../data/index.js";
import { runJsonScript } from "../tools/_utils.js";
import type { BackgroundSyncService } from "./background-sync.js";

function json(res: ServerResponse, status: number, data: unknown) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse) {
	json(res, 404, { error: "Not found" });
}

function badRequest(res: ServerResponse, message: string) {
	json(res, 400, { error: message });
}

/** Parse query string from URL */
function parseQuery(url: string): Record<string, string> {
	const query: Record<string, string> = {};
	const qIdx = url.indexOf("?");
	if (qIdx === -1) return query;
	const params = new URLSearchParams(url.slice(qIdx + 1));
	for (const [key, value] of params) {
		query[key] = value;
	}
	return query;
}

/** Route incoming HTTP requests to handlers */
export async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	bgSync?: BackgroundSyncService,
): Promise<void> {
	const url = req.url || "/";
	const path = url.split("?")[0];
	const method = req.method || "GET";

	try {
		// CORS headers
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Health check
		if (path === "/api/health" && method === "GET") {
			json(res, 200, { status: "ok" });
			return;
		}

		// Index quotes (major A-share indices)
		if (path === "/api/indices" && method === "GET") {
			const store = requireStore();
			const indices = [
				{ code: "000001", name: "上证指数" },
				{ code: "399001", name: "深证成指" },
				{ code: "399006", name: "创业板指" },
				{ code: "000688", name: "科创50" },
				{ code: "000300", name: "沪深300" },
				{ code: "000905", name: "中证500" },
			];
			const codeList = indices.map((i) => i.code).join(",");

			let quotes: any[] = [];
			try {
				// Fetch real-time index quotes via Sina (batch, reliable)
				const spotQuotes = await runJsonScript("get_index_quotes.py", ["--codes", codeList], 30000);
				quotes = spotQuotes.map((q: any) => ({
					code: q.code,
					name: q.name,
					latest: q.price,
					change_pct: q.change_pct,
					snapshot_date: new Date().toISOString().slice(0, 10),
					updated_at: new Date().toISOString(),
				}));
			} catch (e) {
				console.warn("[Indices] Real-time fetch failed, falling back to DB:", e);
				// Fallback: use cached quotes from DB
				const codes = indices.map((i) => i.code);
				quotes = await store.getLatestQuotes(codes);
			}

			// Ensure all requested indices are represented
			const foundCodes = new Set(quotes.map((q) => q.code));
			for (const idx of indices) {
				if (!foundCodes.has(idx.code)) {
					// Last resort: try kline close as fallback
					try {
						const market =
							idx.code.startsWith("6") || ["000001", "000688", "000300", "000905"].includes(idx.code) ? 1 : 0;
						const klines = await store.getKlines({
							code: idx.code,
							market,
							period: "daily",
							adjust: "bfq",
							limit: 1,
						});
						if (klines.length > 0) {
							quotes.push({
								code: idx.code,
								name: idx.name,
								latest: klines[0].close,
								change_pct: klines[0].change_pct,
								snapshot_date: klines[0].date,
								updated_at: klines[0].date,
							});
						}
					} catch (e) {
						console.warn(`[Indices] Kline fallback failed for ${idx.code}:`, e);
					}
				}
			}

			json(res, 200, quotes);
			return;
		}

		// Market sentiment
		if (path === "/api/sentiment" && method === "GET") {
			// Sentiment is fetched via Python script; for now return placeholder
			// or we can invoke the analyzeSentimentTool if needed.
			json(res, 200, { note: "Sentiment data available via WebSocket push" });
			return;
		}

		// Stock quote
		if (path.startsWith("/api/quote/") && method === "GET") {
			const code = path.slice("/api/quote/".length);
			if (!code) {
				badRequest(res, "Stock code required");
				return;
			}
			const store = requireStore();
			const sync = requireSync();
			const market = code.startsWith("6") ? 1 : 0;

			let quote: any = (await store.getLatestQuotes([code]))[0] || null;

			// If no cached quote, try real-time fetch
			if (!quote) {
				try {
					quote = await sync.getQuoteWithCache(code, market);
				} catch (e) {
					console.warn(`[Quote] Real-time fetch failed for ${code}:`, e);
				}
			}

			// After-hours fallback: use last kline close
			if (!quote) {
				try {
					const klines = await store.getKlines({ code, market, period: "daily", adjust: "bfq", limit: 1 });
					if (klines.length > 0) {
						quote = {
							code,
							market,
							name: null,
							latest: klines[0].close,
							change_pct: klines[0].change_pct,
							snapshot_date: klines[0].date,
							updated_at: klines[0].date,
						};
					}
				} catch (e) {
					console.warn(`[Quote] Kline fallback failed for ${code}:`, e);
				}
			}

			// Merge fundamentals for valuation metrics
			if (quote) {
				// Normalize field names for frontend
				if (quote.latest != null && quote.price == null) {
					quote.price = quote.latest;
				}
				if (quote.total_cap != null && quote.market_cap == null) {
					quote.market_cap = quote.total_cap;
				}

				try {
					const fundamentals = await store.getLatestFundamentals(code, market);
					if (fundamentals) {
						const price = quote.latest ?? quote.price ?? 0;
						const shares = fundamentals.total_shares ?? 0;
						const equity = fundamentals.parent_equity ?? fundamentals.total_equity ?? 0;
						const eps = fundamentals.eps ?? 0;

						if (!quote.market_cap && shares > 0 && price > 0) {
							quote.market_cap = price * shares;
						}
						if (!quote.pe_ttm && eps > 0) {
							quote.pe_ttm = price / eps;
						}
						if (!quote.pb && equity > 0 && shares > 0) {
							const bvps = equity / shares;
							quote.pb = price / bvps;
						}
					}
				} catch (e) {
					console.warn(`[Quote] Fundamentals merge failed for ${code}:`, e);
				}
			}

			json(res, 200, quote);
			return;
		}

		// Stock search
		if (path === "/api/stocks" && method === "GET") {
			const query = parseQuery(url);
			const store = requireStore();
			if (query.industry) {
				const stocks = await store.getStocksByIndustry(query.industry);
				json(res, 200, stocks);
				return;
			}
			if (query.concept) {
				const stocks = await store.getStocksByConcept(query.concept);
				json(res, 200, stocks);
				return;
			}
			const stocks = await store.getAllStocks();
			json(res, 200, stocks.slice(0, 500));
			return;
		}

		// Stock pools
		if (path === "/api/stock-pools" && method === "GET") {
			const store = requireStore();
			const pools = await store.getStockPools();
			json(res, 200, pools);
			return;
		}

		if (path.startsWith("/api/stock-pools/") && method === "GET") {
			const poolId = Number(path.slice("/api/stock-pools/".length));
			if (Number.isNaN(poolId)) {
				badRequest(res, "Invalid pool ID");
				return;
			}
			const store = requireStore();
			const pool = await store.getStockPoolById(poolId);
			const items = await store.getStockPoolItems(poolId);
			json(res, 200, { pool, items });
			return;
		}

		if (path.startsWith("/api/stock-pools/") && method === "DELETE") {
			const poolId = Number(path.slice("/api/stock-pools/".length));
			if (Number.isNaN(poolId)) {
				badRequest(res, "Invalid pool ID");
				return;
			}
			const store = requireStore();
			await store.deleteStockPool(poolId);
			json(res, 200, { success: true });
			return;
		}

		// Klines
		if (path === "/api/klines" && method === "GET") {
			const query = parseQuery(url);
			const code = query.code;
			if (!code) {
				badRequest(res, "code parameter required");
				return;
			}
			const store = requireStore();
			const klines = await store.getKlines({
				code,
				market: code.startsWith("6") ? 1 : 0,
				period: (query.period as any) || "daily",
				adjust: (query.adjust as any) || "bfq",
				limit: query.limit ? Number(query.limit) : 100,
			});
			json(res, 200, klines);
			return;
		}

		// Fundamentals
		if (path.startsWith("/api/fundamentals/") && method === "GET") {
			const code = path.slice("/api/fundamentals/".length);
			if (!code) {
				badRequest(res, "Stock code required");
				return;
			}
			const store = requireStore();
			const market = code.startsWith("6") ? 1 : 0;
			const fundamentals = await store.getFundamentals(code, market);
			json(res, 200, fundamentals);
			return;
		}

		// Sectors
		if (path === "/api/sectors" && method === "GET") {
			const store = requireStore();
			const sectors = await store.getSectors();
			json(res, 200, sectors);
			return;
		}

		// Industries
		if (path === "/api/industries" && method === "GET") {
			const query = parseQuery(url);
			const store = requireStore();
			const industries = await store.getIndustries(query.standard, query.level ? Number(query.level) : undefined);
			json(res, 200, industries);
			return;
		}

		// Macro
		if (path === "/api/macro" && method === "GET") {
			const store = requireStore();
			const macro = await store.getLatestMacro();
			json(res, 200, macro);
			return;
		}

		// On-demand sync trigger
		if (path === "/api/sync" && method === "POST") {
			if (!bgSync) {
				json(res, 503, { error: "Background sync not available" });
				return;
			}
			// Run sync in background, return immediately with ack
			bgSync
				.syncAll()
				.then((result) => {
					console.log("[BackgroundSync] On-demand sync complete:", result);
				})
				.catch((e) => {
					console.warn("[BackgroundSync] On-demand sync failed:", e);
				});
			json(res, 202, { status: "accepted", message: "Sync started in background" });
			return;
		}

		// Serve static files (frontend)
		if (method === "GET" && (path === "/" || !path.startsWith("/api/"))) {
			// Static file serving is handled by the server.ts wrapper
			notFound(res);
			return;
		}

		notFound(res);
	} catch (err) {
		console.error("[Server] Error handling request:", err);
		json(res, 500, { error: err instanceof Error ? err.message : String(err) });
	}
}
