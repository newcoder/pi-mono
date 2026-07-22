import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { runDynamicPoolBacktest, runPoolBacktest } from "../backtest/engine.js";
import { STRATEGY_META } from "../backtest/strategies.js";
import { loadUserConfig, saveUserConfig } from "../config/user-config.js";
import type { TradingSession } from "../core/trading-session.js";
import { marketFromCode, requireStore, requireSync } from "../data/index.js";
import { runAStockDataJsonScript, runJsonScript, runLocalDataJsonScript } from "../tools/_utils.js";
import { predictStockRankingTool } from "../tools/ml-prediction.js";
import { BACKTEST_PARAMS_SCHEMA } from "../tools/backtest.js";
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

/** Read and parse JSON request body with a size limit (prevents OOM). */
const MAX_BODY_SIZE = 256 * 1024; // 256 KB
async function readJsonBody(req: IncomingMessage): Promise<any> {
	let chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buf.length;
		if (total > MAX_BODY_SIZE) throw new Error("Request body too large");
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString("utf-8");
	return raw ? JSON.parse(raw) : {};
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Fetch minute klines direct from Sina HTTP — ~200ms, no Python subprocess.
 *  URL: money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData */
async function fetchSinaMinuteKlines(code: string, market: number, period: string) {
	const prefix = market === 1 ? "sh" : "sz";
	const scale = { "1m": "5", "5m": "5", "15m": "15", "30m": "30", "60m": "60" }[period] || "5";
	const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${prefix}${code}&scale=${scale}&ma=no&datalen=240`;
	try {
		const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
		if (!resp.ok) return [];
		const raw = await resp.json() as any[];
		if (!Array.isArray(raw) || raw.length === 0) return [];
		const rows: any[] = [];
		for (const bar of raw) {
			const date = bar.day;
			if (!date) continue;
			rows.push({
				code, market, period, adjust: "bfq", date,
				open: parseFloat(bar.open) || null,
				high: parseFloat(bar.high) || null,
				low: parseFloat(bar.low) || null,
				close: parseFloat(bar.close) || null,
				volume: parseFloat(bar.volume) || null,
				turnover: null,
				change_pct: null, change_amount: null, amplitude: null, pre_close: null,
			});
		}
		return rows;
	} catch (e) {
		console.warn(`[Sina] Minute fetch failed for ${code}:`, e);
		return [];
	}
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

		// Theme history (market theme classification over time)
		if (path === "/api/theme-history" && method === "GET") {
			const store = requireStore();
			const query = parseQuery(url);
			const level = query.level;
			const rows = await store.getThemeHistory(level);
			json(res, 200, rows);
			return;
		}

		// Index quotes (major A-share indices)
		if (path === "/api/indices" && method === "GET") {
			const store = requireStore();
			const indices = [
				{ code: "000001", name: "上证指数", market: 1 },
				{ code: "399001", name: "深证成指", market: 0 },
				{ code: "399006", name: "创业板指", market: 0 },
				{ code: "000688", name: "科创50", market: 1 },
				{ code: "000300", name: "沪深300", market: 1 },
				{ code: "000905", name: "中证500", market: 1 },
			];
			const codeList = indices.map((i) => i.code).join(",");

			let quotes: any[] = [];

			// 1. Read from DB first — background sync updates every 30s during market hours.
			//    This avoids spawning a Python process on every frontend poll.
			const dbCodes = indices.map((i) => i.code);
			const dbMarkets = indices.map((i) => i.market);
			const dbQuotes = await store.getLatestQuotes(dbCodes, dbMarkets);
			const maxAge = 90_000; // 90s — max acceptable staleness before falling back to real-time

			let dbFresh = false;
			if (dbQuotes.length === indices.length) {
				const now = Date.now();
				dbFresh = dbQuotes.every((q) => {
					const updated = q.updated_at ? new Date(q.updated_at).getTime() : 0;
					return now - updated < maxAge;
				});
			}

			if (dbFresh) {
				quotes = dbQuotes.map((q) => ({
					code: q.code,
					name: q.name || indices.find((i) => i.code === q.code)?.name,
					latest: q.latest,
					change_pct: q.change_pct,
					snapshot_date: q.snapshot_date,
					updated_at: q.updated_at,
				}));
			} else {
				// 2. DB is stale or missing — fetch real-time via Python script
				try {
					const spotQuotes = await runLocalDataJsonScript("get_index_quotes.py", ["--codes", codeList], 30000);
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
					// Use whatever DB had (even if stale)
					quotes = dbQuotes.map((q) => ({
						code: q.code,
						name: q.name || indices.find((i) => i.code === q.code)?.name,
						latest: q.latest,
						change_pct: q.change_pct,
						snapshot_date: q.snapshot_date,
						updated_at: q.updated_at,
					}));
				}
			}

			// 3. Fill any missing indices from klines as last resort
			const foundCodes = new Set(quotes.map((q) => q.code));
			for (const idx of indices) {
				if (!foundCodes.has(idx.code)) {
					try {
						const klines = await store.getKlines({
							code: idx.code,
							market: idx.market,
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
			const market = marketFromCode(code);

			let quote: any = null;

			// 1. Try mootdx (TCP direct) first with a short timeout to avoid UI blocking
			if (mootdxDaemon) {
				try {
					const mootdxResult = await mootdxDaemon.request("quote", { code, market }, 3000);
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

			// 3. Fallback: HTTP real-time fetch (fast batch-capable source)
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
			// Enrich with latest quote data (change_pct, latest price)
			const allCodes = items.map((i) => i.code);
			const allMarkets = items.map((i) => i.market);
			const quotes = await store.getLatestQuotes(allCodes, allMarkets);
			const quoteMap = new Map(quotes.map((q) => [`${q.code}:${q.market}`, q]));

			// Fallback: batch-fetch real-time quotes for items missing from DB
			const itemsNeedingQuotes = items.filter((i) => !quoteMap.has(`${i.code}:${i.market}`));
			if (itemsNeedingQuotes.length > 0) {
				try {
					const batchItems = itemsNeedingQuotes.map((i) => ({ code: i.code, market: i.market }));
					const fetched: any[] = await runLocalDataJsonScript(
						"batch_get_quotes.py",
						["--items", JSON.stringify(batchItems)],
						30_000,
					);
					for (const q of fetched) {
						if (q?.code != null && q?.latest != null) {
							quoteMap.set(`${q.code}:${q.market}`, q);
						}
					}
				} catch (e) {
					console.warn(`[Pool/${poolId}] Batch quote fetch failed:`, e);
				}
			}

			const enrichedItems = items.map((item) => {
				const q = quoteMap.get(`${item.code}:${item.market}`);
				return {
					...item,
					change_pct: q?.change_pct ?? null,
					latest: q?.latest ?? null,
				};
			});
			json(res, 200, { pool, items: enrichedItems });
			return;
		}

		if (path.startsWith("/api/stock-pools/") && !path.endsWith("/items") && method === "DELETE") {
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

		if (path.startsWith("/api/stock-pools/") && path.endsWith("/items") && method === "DELETE") {
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
			for (const item of items) {
				await store.removeFromStockPool(poolId, String(item.code), Number(item.market));
			}
			json(res, 200, { success: true });
			return;
		}

		// Backtest report save
		if (path === "/api/backtest/save" && method === "POST") {
			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const params = body ? JSON.parse(body) : {};
			try {
				const { generatePoolBacktestReport } = await import("../report/pool-report.js");
				const outputDir = join(homedir(), ".trading-agent", "reports");
				const genResult = await generatePoolBacktestReport(params, outputDir, "http://localhost:3000");
				json(res, 200, { url: genResult.url });
			} catch (err) {
				json(res, 500, { error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}

		// Backtest strategies metadata
		if (path === "/api/backtest/strategies" && method === "GET") {
			json(res, 200, STRATEGY_META);
			return;
		}

		// Backtest runner
		if (path === "/api/backtest/run" && method === "POST") {
			try {
				const params = await readJsonBody(req);
				const poolId = params.poolId;
				const config = params.config || {};

				if (!poolId) {
					badRequest(res, "poolId is required");
					return;
				}

				// Validate critical config fields
				if (config.random_runs != null && (config.random_runs <= 0 || config.random_runs > 100)) {
					badRequest(res, "random_runs must be 1-100");
					return;
				}
				if (config.positionSize != null && (config.positionSize < 0 || config.positionSize > 1)) {
					badRequest(res, "positionSize must be 0-1");
					return;
				}
				if (config.min_lot != null && config.min_lot <= 0) {
					badRequest(res, "min_lot must be > 0");
					return;
				}
				if (config.rebalance_frequency != null && config.rebalance_frequency < 1) {
					badRequest(res, "rebalance_frequency must be >= 1");
					return;
				}

				const store = requireStore();
				const pool = await store.getStockPoolById(poolId);
				if (!pool) {
					json(res, 404, { error: `Pool ${poolId} not found` });
					return;
				}

				let result: any;
				if (pool.is_dynamic) {
					result = await runDynamicPoolBacktest(poolId, config);
				} else {
					const items = await store.getStockPoolItems(poolId);
					const stocks = items.map((i: any) => ({ code: i.code, market: i.market, name: i.name || undefined }));
					result = await runPoolBacktest(stocks, config);
				}

				json(res, 200, result);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes("too large")) {
					json(res, 413, { error: "Request body too large (max 256KB)" });
				} else {
					json(res, 500, { error: message });
				}
			}
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
			const market = marketFromCode(code);
			const period = (query.period as any) || "daily";
			const limit = query.limit ? Number(query.limit) : 100;
			const INTRADAY_PERIODS = new Set(["1m", "5m", "15m", "30m", "60m"]);
			const NON_DAILY_PERIODS = new Set(["week", "month", "quarter", "year"]);

			let klines: any[] = [];
			const store = requireStore();
			const sync = requireSync();
			const adjust = (query.adjust as any) || "bfq";

			// 1. DB cache first
			klines = await store.getKlines({ code, market, period, adjust, limit });
			console.log(`[Klines] DB cache for ${code} ${period}: ${klines.length} bars`);

			// 2. Determine if data is stale and needs a fresh sync
			let needsSync = false;
			const latestBarDate =
				klines.length > 0 && typeof klines[klines.length - 1]?.date === "string"
					? klines[klines.length - 1].date.slice(0, 10)
					: null;

			if (klines.length === 0) {
				needsSync = true;
			} else if (INTRADAY_PERIODS.has(period)) {
				// Intraday: stale if latest bar is before today
				if (latestBarDate && latestBarDate < todayStr()) {
					needsSync = true;
				}
			} else if (NON_DAILY_PERIODS.has(period)) {
				// week/month/quarter/year: stale if latest bar is before last period boundary
				const now = new Date();
				let threshold: Date;
				switch (period) {
					case "week":
						threshold = new Date(now); threshold.setDate(now.getDate() - 7); break;
					case "month":
						threshold = new Date(now); threshold.setMonth(now.getMonth() - 1); break;
					case "quarter":
						threshold = new Date(now); threshold.setMonth(now.getMonth() - 3); break;
					default: // year
						threshold = new Date(now); threshold.setFullYear(now.getFullYear() - 1); break;
				}
				const thresholdStr = threshold.toISOString().slice(0, 10);
				if (latestBarDate && latestBarDate < thresholdStr) {
					needsSync = true;
				}
			}

			// 3. Sync if needed (covers intraday + week/month/quarter/year)
			if (needsSync && sync) {
				const today = todayStr();
				const start = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
				// Intraday: fast direct Sina HTTP (no Python subprocess overhead)
				if (INTRADAY_PERIODS.has(period)) {
					console.log(`[Klines] Fetching intraday from Sina for ${code} ${period}`);
					try {
						const intradayRows = await fetchSinaMinuteKlines(code, market, period);
						if (intradayRows.length > 0) {
							await store.saveKlines(intradayRows);
							klines = await store.getKlines({ code, market, period, adjust, limit });
							console.log(`[Klines] Sina intraday: ${intradayRows.length} bars for ${code}`);
						}
					} catch (e) {
						console.warn(`[Klines] Sina intraday failed for ${code}:`, e);
					}
				} else {
					console.log(`[Klines] Syncing ${period} data for ${code} (latest bar: ${latestBarDate || "none"})`);
					try {
						const synced = await sync.syncKline(code, market, period, "bfq", start, today.replace(/-/g, ""));
						console.log(`[Klines] Synced ${synced} ${period} bars for ${code}`);
						if (synced > 0) {
							klines = await store.getKlines({ code, market, period, adjust, limit });
						}
					} catch (e) {
						console.warn(`[Klines] Sync failed for ${code} ${period}:`, e);
					}
				}
			}

			// 3. Fallback: mootdx (TCP direct) with a short timeout
			if (klines.length === 0 && mootdxDaemon) {
				console.log(`[Klines] Falling back to mootdx for ${code} ${period} (market=${market})`);
				try {
					const mootdxResult = await mootdxDaemon.request("klines", { code, market, period, limit }, 5000);
					if (Array.isArray(mootdxResult) && mootdxResult.length > 0) {
						klines = mootdxResult;
						console.log(`[Klines] mootdx hit for ${code}: ${mootdxResult.length} bars`);
						// Persist fallback data so next request hits DB
						try {
							const rows = mootdxResult.map((k: any) => ({
								code: k.code,
								market: k.market,
								period: k.period,
								adjust: k.adjust,
								date: k.date,
								open: k.open ?? null,
								high: k.high ?? null,
								low: k.low ?? null,
								close: k.close ?? null,
								volume: k.volume ?? null,
								turnover: k.turnover ?? null,
								change_pct: k.change_pct ?? null,
								change_amount: k.change_amount ?? null,
								amplitude: k.amplitude ?? null,
								pre_close: k.pre_close ?? null,
							}));
							await store.saveKlines(rows);
						} catch (saveErr) {
							console.warn(`[Klines] Failed to persist mootdx fallback for ${code}:`, saveErr);
						}
					}
				} catch (e) {
					console.warn(`[Klines] mootdx failed for ${code}:`, e);
				}
			} else if (klines.length === 0) {
				console.warn(`[Klines] No mootdxDaemon available for ${code} ${period}`);
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
			const market = marketFromCode(code);
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

		// Industry indices list
		if (path === "/api/industry/list" && method === "GET") {
			const store = requireStore();
			const sync = requireSync();
			let list = await store.getIndustryList();
			if (list.length === 0) {
				try {
					await sync.syncIndustryList();
					list = await store.getIndustryList();
				} catch (e) {
					console.warn("[Industry/List] Sync failed:", e);
				}
			}
			json(res, 200, list);
			return;
		}

		// Industry index spot quote
		if (path === "/api/industry/spot" && method === "GET") {
			const query = parseQuery(url);
			const store = requireStore();
			const sync = requireSync();
			const code = query.code;

			if (code) {
				let quote: any = null;
				try {
					quote = await sync.syncIndustryQuote(code);
				} catch (e) {
					console.warn(`[Industry/Spot] Real-time fetch failed for ${code}:`, e);
					quote = await store.getIndustryQuote(code, todayStr());
				}
				json(res, 200, quote);
				return;
			}

			let quotes = await store.getLatestIndustryQuotes();
			if (quotes.length === 0) {
				try {
					await sync.syncAllIndustryQuotes();
					quotes = await store.getLatestIndustryQuotes();
				} catch (e) {
					console.warn("[Industry/Spot] On-demand sync failed:", e);
				}
			}
			json(res, 200, quotes);
			return;
		}

		// Industry index klines
		if (path === "/api/industry/klines" && method === "GET") {
			const query = parseQuery(url);
			const code = query.code;
			if (!code) {
				badRequest(res, "code parameter required (e.g. BK1036)");
				return;
			}
			const period = query.period || "daily";
			const limit = query.limit ? Number(query.limit) : 100;
			const start = query.start;
			const end = query.end;

			const store = requireStore();
			const sync = requireSync();

			let klines: any[] = await store.getIndustryKlines(code, period, start, end, limit);
			if (klines.length === 0) {
				try {
					await sync.syncIndustryKlines(code, period);
					klines = await store.getIndustryKlines(code, period, start, end, limit);
				} catch (e) {
					console.warn(`[Industry/Klines] Sync failed for ${code}:`, e);
				}
			}
			json(res, 200, klines);
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

			// Prefer active session model, then saved user config, then undefined
			const userConfig = loadUserConfig();
			const currentModel = session
				? { provider: session.model.provider, modelId: session.model.id }
				: userConfig.model;

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
				currentModel,
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

			// Persist selected model as user preference
			saveUserConfig({ model: { provider, modelId } });

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

			if (model !== "de" && model !== "de_regression" && model !== "lgb") {
				badRequest(res, "model must be 'de', 'de_regression' or 'lgb'");
				return;
			}

			console.log(`[API/Predict] Starting ${model} prediction (top_n=${topN}, pool=${poolName || "default"})...`);
			const startTime = Date.now();
			try {
				const result = await predictStockRankingTool.execute(`api-predict-${Date.now()}`, {
					model,
					top_n: topN,
					pool_name: poolName,
					horizon: bodyJson.horizon ?? 5,
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
