import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { TradingSession } from "../core/trading-session.js";
import { requireStore, requireSync } from "../data/index.js";
import { runAStockDataJsonScript, runJsonScript } from "../tools/_utils.js";
import { predictStockRankingTool } from "../tools/ml-prediction.js";
import type { BackgroundSyncService } from "./background-sync.js";
import type { MootdxDaemon } from "./mootdx-daemon.js";

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
	session?: TradingSession,
	bgSync?: BackgroundSyncService,
	mootdxDaemon?: MootdxDaemon,
	modelRegistry?: ModelRegistry,
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
				// Pass market for each index to avoid code collisions
				// (e.g., 000001 is both 平安银行 market=0 and 上证指数 market=1)
				const codes = indices.map((i) => i.code);
				const markets = indices.map((i) =>
					i.code.startsWith("6") || ["000001", "000688", "000300", "000905"].includes(i.code) ? 1 : 0,
				);
				quotes = await store.getLatestQuotes(codes, markets);
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

			let quote: any = null;

			// 1. Try mootdx (TCP direct) first — fastest and most reliable
			if (mootdxDaemon) {
				try {
					const mootdxResult = await mootdxDaemon.request("quote", { code, market }, 15000);
					if (mootdxResult && mootdxResult.latest != null) {
						quote = mootdxResult;
						console.log(`[Quote] mootdx hit for ${code}: ${mootdxResult._source}`);
					}
				} catch (e) {
					console.warn(`[Quote] mootdx failed for ${code}, falling back:`, e);
				}
			}

			// 2. Fallback: DB cache
			if (!quote) {
				quote = (await store.getLatestQuotes([code], [market]))[0] || null;
			}

			// 3. Fallback: HTTP real-time fetch
			if (!quote) {
				try {
					quote = await sync.getQuoteWithCache(code, market);
				} catch (e) {
					console.warn(`[Quote] Real-time fetch failed for ${code}:`, e);
				}
			}

			// 4. After-hours fallback: use last kline close
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
			if (query.search) {
				const stocks = await store.searchStocks(query.search, Number(query.limit) || 10);
				json(res, 200, stocks);
				return;
			}
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
			json(res, 200, query.all === "1" ? stocks : stocks.slice(0, 500));
			return;
		}

		// Stock pools
		if (path === "/api/stock-pools" && method === "GET") {
			const store = requireStore();
			const pools = await store.getStockPools();
			json(res, 200, pools);
			return;
		}

		if (path === "/api/stock-pools" && method === "POST") {
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const bodyJson = body ? JSON.parse(body) : {};
			const name = bodyJson.name?.trim();
			const description = bodyJson.description?.trim() || "";
			if (!name) {
				badRequest(res, "name is required");
				return;
			}
			const store = requireStore();
			const poolId = await store.createStockPool(name, description);
			json(res, 200, { id: poolId, name, description });
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
			// Enrich missing names from stocks table (canonical source), fallback to quotes
			const itemsNeedingNames = items.filter((i) => !i.name);
			if (itemsNeedingNames.length > 0) {
				for (const item of itemsNeedingNames) {
					const stock = await store.getStock(item.code);
					if (stock?.name) {
						item.name = stock.name;
					}
				}
				// Fallback: any still missing, try latest quotes
				const stillNeeding = items.filter((i) => !i.name);
				if (stillNeeding.length > 0) {
					const codes = stillNeeding.map((i) => i.code);
					const markets = stillNeeding.map((i) => i.market);
					const quotes = await store.getLatestQuotes(codes, markets);
					const nameMap = new Map(quotes.map((q) => [`${q.code}:${q.market}`, q.name]));
					for (const item of stillNeeding) {
						if (!item.name) {
							item.name = nameMap.get(`${item.code}:${item.market}`) || null;
						}
					}
				}
			}
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

		if (path.startsWith("/api/stock-pools/") && path.endsWith("/items") && method === "POST") {
			const poolId = Number(path.slice("/api/stock-pools/".length, -"/items".length));
			if (Number.isNaN(poolId)) {
				badRequest(res, "Invalid pool ID");
				return;
			}
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const bodyJson = body ? JSON.parse(body) : {};
			const items = bodyJson.items;
			if (!Array.isArray(items) || items.length === 0) {
				badRequest(res, "items array required");
				return;
			}
			const store = requireStore();
			await store.addToStockPool(
				poolId,
				items.map((item: any) => ({
					code: String(item.code),
					market: Number(item.market),
					name: item.name ? String(item.name) : undefined,
				})),
			);
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
			const market = code.startsWith("6") ? 1 : 0;
			const period = (query.period as any) || "daily";
			const limit = query.limit ? Number(query.limit) : 100;

			let klines: any[] = [];

			// 1. Try mootdx (TCP direct) first
			if (mootdxDaemon) {
				try {
					const mootdxResult = await mootdxDaemon.request("klines", { code, market, period, limit }, 20000);
					if (Array.isArray(mootdxResult) && mootdxResult.length > 0) {
						klines = mootdxResult;
						console.log(`[Klines] mootdx hit for ${code}: ${mootdxResult.length} bars`);
					}
				} catch (e) {
					console.warn(`[Klines] mootdx failed for ${code}, falling back to DB:`, e);
				}
			}

			// 2. Fallback: DB cache
			if (klines.length === 0) {
				const store = requireStore();
				klines = await store.getKlines({
					code,
					market,
					period,
					adjust: (query.adjust as any) || "bfq",
					limit,
				});
			}

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
			const market = code.startsWith("6") ? 1 : 0;
			let fundamentals: any = null;

			// 1. Try mootdx (TCP direct) first
			if (mootdxDaemon) {
				try {
					const mootdxResult = await mootdxDaemon.request("finance", { code, market }, 15000);
					if (mootdxResult && mootdxResult.eps != null) {
						fundamentals = mootdxResult;
						console.log(`[Fundamentals] mootdx hit for ${code}: ${mootdxResult._source}`);
					}
				} catch (e) {
					console.warn(`[Fundamentals] mootdx failed for ${code}, falling back to DB:`, e);
				}
			}

			// 2. Fallback: DB cache
			if (!fundamentals) {
				const store = requireStore();
				fundamentals = await store.getFundamentals(code, market);
			}

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

		// Hot stocks (同花顺热点强势股)
		if (path === "/api/hot-stocks" && method === "GET") {
			const query = parseQuery(url);
			const args: string[] = [];
			if (query.date) args.push("--date", query.date);
			if (query.limit) args.push("--limit", query.limit);
			try {
				const result = await runAStockDataJsonScript("get_hot_stocks.py", args, 30000);
				json(res, 200, result);
			} catch (e) {
				console.warn("[HotStocks] Fetch failed:", e);
				json(res, 500, { error: "Failed to fetch hot stocks", details: String(e) });
			}
			return;
		}

		// News (a-stock-data news fetcher)
		if (path === "/api/news" && method === "GET") {
			const query = parseQuery(url);
			const code = query.code || "";
			const sources = query.sources || "eastmoney_stock,cls_telegraph,eastmoney_global";
			const limit = query.limit || "20";
			const args: string[] = ["--sources", sources, "--limit", limit];
			if (code) args.push("--code", code);
			try {
				const result = await runAStockDataJsonScript("news_fetcher.py", args, 30000);
				json(res, 200, result);
			} catch (e) {
				console.warn("[News] Fetch failed:", e);
				json(res, 500, { error: "Failed to fetch news", details: String(e) });
			}
			return;
		}

		// Calendar events
		if (path === "/api/calendar" && method === "GET") {
			const query = parseQuery(url);
			const startDate = query.start;
			const endDate = query.end;
			if (!startDate || !endDate) {
				badRequest(res, "start and end date parameters required");
				return;
			}
			const store = requireStore();
			const events = await store.getCalendarEvents(startDate, endDate, query.code);
			json(res, 200, events);
			return;
		}

		if (path === "/api/calendar/refresh" && method === "POST") {
			const store = requireStore();
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const bodyJson = body ? JSON.parse(body) : {};
			const code = bodyJson.code;

			// Run refresh in background via Python script
			const args = code ? ["--refresh-stock", code] : ["--refresh-market"];
			const since = bodyJson.since;
			const until = bodyJson.until;
			if (since) args.push("--since", since);
			if (until) args.push("--until", until);

			// Delete existing events in the target date range before refresh to avoid duplicates
			const refreshStart = since || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
			const refreshEnd = until || new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
			await store.deleteCalendarEventsInRange(refreshStart, refreshEnd);

			const result = await runJsonScript("investment_calendar.py", args, 120_000);
			if (result.success && result.events) {
				await store.saveCalendarEvents(result.events);
			}

			json(res, 200, {
				success: result.success ?? true,
				count: result.count ?? 0,
				start_date: result.start_date,
				end_date: result.end_date,
			});
			return;
		}

		// Stock lookup via iwencai (fallback when local search has no results)
		if (path === "/api/stock-lookup" && method === "POST") {
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const bodyJson = body ? JSON.parse(body) : {};
			const query = bodyJson.query?.trim();
			if (!query) {
				badRequest(res, "query is required");
				return;
			}

			try {
				const result = await runJsonScript("iwencai_screener.py", ["--query", query, "--limit", "5"], 30000);
				if (!result.success) {
					json(res, 200, { success: false, error: result.error || "Lookup failed" });
					return;
				}

				// Extract stock codes and names from iwencai response
				const stocks: Array<{ code: string; name: string; market: number }> = [];
				for (const item of result.results || []) {
					const code = item.股票代码 || item.代码 || item.stock_code || "";
					const name = item.股票简称 || item.名称 || item.stock_name || "";
					if (!code || !name) continue;
					// Normalize code: remove market prefix if present (e.g., "SH600519" -> "600519")
					const normalizedCode = code.replace(/^(SH|SZ|BJ)/i, "");
					const market = normalizedCode.startsWith("6") ? 1 : 0;
					stocks.push({ code: normalizedCode, name, market });
				}

				json(res, 200, { success: true, query, results: stocks.slice(0, 5) });
			} catch (err) {
				console.error("[StockLookup] iwencai failed:", err);
				json(res, 200, { success: false, error: "Lookup service unavailable", results: [] });
			}
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

		// Model configuration endpoints
		if (path === "/api/model-config" && method === "GET") {
			if (!modelRegistry) {
				json(res, 503, { error: "Model registry not available" });
				return;
			}
			const allModels = modelRegistry.getAll();
			const availableModels = modelRegistry.getAvailable();
			const providers = [...new Set(allModels.map((m) => m.provider))];
			json(res, 200, {
				providers: providers.map((p) => ({
					id: p,
					models: allModels
						.filter((m) => m.provider === p)
						.map((m) => ({
							id: m.id,
							name: m.name,
							provider: m.provider,
							api: m.api,
							baseUrl: m.baseUrl,
							reasoning: m.reasoning,
							contextWindow: m.contextWindow,
							maxTokens: m.maxTokens,
						})),
				})),
				available: availableModels.map((m) => `${m.provider}/${m.id}`),
				currentModel: session ? { provider: session.model.provider, modelId: session.model.id } : undefined,
			});
			return;
		}

		if (path === "/api/model-config" && method === "POST") {
			if (!modelRegistry) {
				json(res, 503, { error: "Model registry not available" });
				return;
			}
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const config = body ? JSON.parse(body) : {};
			const { provider, modelId, apiKey, baseUrl } = config;
			if (!provider || !modelId) {
				badRequest(res, "provider and modelId are required");
				return;
			}

			// Update auth.json with API key if provided
			if (apiKey) {
				modelRegistry.authStorage.set(provider, { type: "api_key", key: apiKey });
			}

			// Update models.json with baseUrl if provided
			if (baseUrl) {
				const agentDir = join(homedir(), ".pi", "agent");
				const modelsJsonPath = join(agentDir, "models.json");
				let modelsConfig: { providers: Record<string, { baseUrl?: string; apiKey?: string }> } = { providers: {} };
				try {
					const content = readFileSync(modelsJsonPath, "utf-8");
					modelsConfig = JSON.parse(content);
				} catch {
					// File doesn't exist or is invalid, start fresh
				}
				if (!modelsConfig.providers) modelsConfig.providers = {};
				if (!modelsConfig.providers[provider]) modelsConfig.providers[provider] = {};
				modelsConfig.providers[provider].baseUrl = baseUrl;
				if (apiKey) modelsConfig.providers[provider].apiKey = apiKey;
				writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig, null, 2), "utf-8");
			}

			// Refresh registry to pick up changes
			modelRegistry.refresh();

			// Switch model in the active session if available
			if (session) {
				const newModel = modelRegistry.find(provider, modelId);
				if (newModel) {
					try {
						session.switchModel(newModel);
						console.log(`[ModelConfig] Switched to ${provider}/${modelId}`);
					} catch (err) {
						console.warn(`[ModelConfig] Failed to switch model:`, err);
					}
				}
			}

			json(res, 200, { success: true });
			return;
		}

		// ML Stock Prediction
		if (path === "/api/predict" && method === "POST") {
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const bodyJson = body ? JSON.parse(body) : {};
			const model = bodyJson.model || "de";
			const topN = bodyJson.top_n ?? 50;
			const poolName = bodyJson.pool_name || undefined;

			if (model !== "de" && model !== "lgb") {
				badRequest(res, "model must be 'de' or 'lgb'");
				return;
			}

			console.log(`[API/Predict] Starting ${model} prediction (top_n=${topN}, pool=${poolName || "default"})...`);
			const startTime = Date.now();
			try {
				const result = await predictStockRankingTool.execute(`api-predict-${Date.now()}`, {
					model,
					top_n: topN,
					pool_name: poolName,
				});
				const elapsed = Date.now() - startTime;
				console.log(`[API/Predict] Prediction complete in ${elapsed}ms`);
				const firstContent = result.content?.[0];
				const formattedText = firstContent && "text" in firstContent ? firstContent.text : "";
				json(res, 200, {
					success: !result.details?.error,
					elapsed_ms: elapsed,
					result: result.details,
					formatted: formattedText,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[API/Predict] Prediction failed: ${message}`);
				json(res, 500, { error: message });
			}
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
