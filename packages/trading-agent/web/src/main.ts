import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { apiClient } from "./api/client.js";
import { createChart, CandlestickSeries, HistogramSeries, AreaSeries } from "lightweight-charts";

// ─── Types ──────────────────────────────────────────────────

interface ChatMessage {
	role: "user" | "assistant" | "tool" | "system";
	content: string;
	isStreaming?: boolean;
}

interface IndexQuote {
	code: string;
	name: string;
	price: number;
	change_pct: number;
}

interface SentimentData {
	advance: number;
	decline: number;
	flat: number;
	limitUp: number;
	limitDown: number;
	northboundFlow: number;
	sentimentIndex: number;
}

interface StockPool {
	id: number;
	name: string;
	description: string;
	item_count: number;
}

interface PoolItem {
	code: string;
	name: string;
}

interface CalendarEvent {
	id?: number;
	event_date: string;
	title: string;
	category: string;
	description?: string | null;
	code?: string | null;
	market?: number | null;
	affected_sectors?: string[] | null;
	importance?: string;
	source?: string | null;
}

interface ToolLog {
	id: number;
	toolCallId: string;
	name: string;
	status: "running" | "done";
	content: string;
	timestamp: number;
}

interface HotStock {
	code: string;
	name: string;
	reason: string;
	date: string;
	market: number;
	price: number;
	change_pct: number;
	turnover_pct: number;
	amount_wan: number;
	pe_ttm: number;
	pb: number;
	mcap_yi: number;
}

interface KlineData {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	amount?: number;
}

// ─── State ──────────────────────────────────────────────────

const state = {
	messages: [] as ChatMessage[],
	indices: [] as IndexQuote[],
	indicesLoaded: false,
	sentiment: null as SentimentData | null,
	marketPhase: "closed" as string,
	connected: false,
	isStreaming: false,
	stockPools: [] as StockPool[],
	selectedPool: null as StockPool | null,
	poolItems: [] as PoolItem[],
	// Chart panel state (replaces selectedStock/stockQuote)
	selectedSymbol: null as string | null,
	selectedType: "stock" as "stock" | "index",
	selectedQuote: null as any,
	selectedKlines: [] as KlineData[],
	selectedIntraday: [] as KlineData[],
	selectedPeriod: "daily" as "daily" | "week" | "month",
	chartPanelCollapsed: false,
	// Calendar state
	calendarEvents: [] as CalendarEvent[],
	calendarMonth: new Date(),
	calendarSelectedDate: null as string | null,
	calendarLoading: false,
	calendarCollapsed: false,
	// Hot stocks state
	hotStocks: [] as HotStock[],
	hotStocksDate: "" as string,
	hotStocksLoading: false,
	hotStocksCollapsed: false,
	// Mobile drawer state
	mobileLeftOpen: false,
	mobileRightOpen: false,
	// Tool log state
	toolLogs: [] as ToolLog[],
	nextToolLogId: 0,
};

// ─── Chart instances ────────────────────────────────────────

let intradayChart: any = null;
let intradaySeries: any = null;
let klineChart: any = null;
let candleSeries: any = null;
let volumeSeries: any = null;

// ─── Time helpers ───────────────────────────────────────────

/** Convert 'YYYY-MM-DD HH:MM:SS' (Beijing Time) to UTC timestamp (seconds) for lightweight-charts */
function toUTCTimestamp(dateStr: string): number {
	const [datePart, timePart] = dateStr.split(" ");
	const [year, month, day] = datePart.split("-").map(Number);
	const [hour, minute, second] = (timePart || "00:00:00").split(":").map(Number);
	// A-share market data is in Beijing Time (UTC+8)
	// Convert to UTC timestamp by subtracting 8 hours
	return Math.floor(Date.UTC(year, month - 1, day, hour - 8, minute, second) / 1000);
}

/** Get today's date string YYYY-MM-DD */
function getTodayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

// ─── Real-time polling ──────────────────────────────────────

let intradayPollTimer: number | null = null;
const INTRADAY_POLL_INTERVAL = 30000; // 30 seconds

/** Check if current time is within A-share trading hours */
function isTradingTime(): boolean {
	const now = new Date();
	const day = now.getDay();
	// Monday to Friday only
	if (day === 0 || day === 6) return false;

	const hours = now.getHours();
	const minutes = now.getMinutes();
	const time = hours * 60 + minutes;

	// Morning session: 9:30 - 11:30
	// Afternoon session: 13:00 - 15:00
	return (time >= 570 && time <= 690) || (time >= 780 && time <= 900);
}

function stopIntradayPolling() {
	if (intradayPollTimer) {
		clearInterval(intradayPollTimer);
		intradayPollTimer = null;
	}
}

function startIntradayPolling(code: string) {
	stopIntradayPolling();
	if (!isTradingTime()) return;

	intradayPollTimer = window.setInterval(() => {
		if (!isTradingTime() || state.selectedSymbol !== code) {
			stopIntradayPolling();
			return;
		}
		pollIntradayData(code);
	}, INTRADAY_POLL_INTERVAL);
}

async function pollIntradayData(code: string) {
	try {
		const data = await apiClient.getKlines(code, { period: "1m", limit: 5 });
		if (!data || data.length === 0) return;

		const today = getTodayStr();
		// Merge new data into state, filter to today only
		const existingMap = new Map(state.selectedIntraday.map((k) => [k.date, k]));
		for (const k of data) {
			if (typeof k.date === "string" && k.date.startsWith(today)) {
				existingMap.set(k.date, {
					date: k.date,
					open: k.open,
					high: k.high,
					low: k.low,
					close: k.close,
					volume: k.volume,
				});
			}
		}
		// Sort by date and keep last 240 bars
		state.selectedIntraday = Array.from(existingMap.values())
			.sort((a, b) => a.date.localeCompare(b.date))
			.slice(-240);

		// Update chart incrementally with UTC timestamps
		if (intradaySeries) {
			for (const k of state.selectedIntraday) {
				intradaySeries.update({ time: toUTCTimestamp(k.date), value: k.close });
			}
		}
	} catch (err) {
		console.warn("[Intraday Poll] Failed to fetch:", err);
	}
}

// ─── DOM refs ───────────────────────────────────────────────

function $(id: string) {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: #${id}`);
	return el;
}

// ─── Chart helpers ──────────────────────────────────────────

function disposeCharts() {
	stopIntradayPolling();
	if (intradayChart) {
		intradayChart.remove();
		intradayChart = null;
		intradaySeries = null;
	}
	if (klineChart) {
		klineChart.remove();
		klineChart = null;
		candleSeries = null;
		volumeSeries = null;
	}
}

function initIntradayChart(container: HTMLElement) {
	if (intradayChart) return;
	intradayChart = createChart(container, {
		layout: {
			background: { type: "solid" as any, color: "transparent" },
			textColor: "#9ca3af",
			fontSize: 10,
		},
		grid: {
			vertLines: { color: "rgba(0,0,0,0.05)" },
			horzLines: { color: "rgba(0,0,0,0.05)" },
		},
		crosshair: { mode: 1 },
		rightPriceScale: {
			borderColor: "rgba(0,0,0,0.05)",
			scaleMargins: { top: 0.1, bottom: 0.1 },
		},
		timeScale: {
			borderColor: "rgba(0,0,0,0.05)",
			timeVisible: true,
			secondsVisible: false,
		},
		autoSize: true,
	});
	intradaySeries = intradayChart.addSeries(AreaSeries, {
		lineColor: "#3b82f6",
		topColor: "rgba(59, 130, 246, 0.3)",
		bottomColor: "rgba(59, 130, 246, 0.02)",
		lineWidth: 2,
	});
}

function initKlineChart(container: HTMLElement) {
	if (klineChart) return;
	klineChart = createChart(container, {
		layout: {
			background: { type: "solid" as any, color: "transparent" },
			textColor: "#9ca3af",
			fontSize: 10,
		},
		grid: {
			vertLines: { color: "rgba(0,0,0,0.05)" },
			horzLines: { color: "rgba(0,0,0,0.05)" },
		},
		crosshair: { mode: 1 },
		rightPriceScale: {
			borderColor: "rgba(0,0,0,0.05)",
			scaleMargins: { top: 0.15, bottom: 0.25 },
		},
		leftPriceScale: {
			visible: true,
			borderColor: "rgba(0,0,0,0.05)",
			scaleMargins: { top: 0.7, bottom: 0 },
		},
		timeScale: {
			borderColor: "rgba(0,0,0,0.05)",
			barSpacing: 6,
		},
		autoSize: true,
	});
	candleSeries = klineChart.addSeries(CandlestickSeries, {
		upColor: "#ef4444",
		downColor: "#22c55e",
		borderUpColor: "#ef4444",
		borderDownColor: "#22c55e",
		wickUpColor: "#ef4444",
		wickDownColor: "#22c55e",
	});
	volumeSeries = klineChart.addSeries(HistogramSeries, {
		color: "#3b82f6",
		priceScaleId: "left",
		priceFormat: { type: "volume" },
	});
}

// ─── Rendering ──────────────────────────────────────────────

function renderIndices() {
	const container = $("index-bar");
	if (!state.indicesLoaded) {
		container.innerHTML = `<span class="text-muted-foreground">加载中...</span>`;
		return;
	}
	if (state.indices.length === 0) {
		container.innerHTML = `<span class="text-muted-foreground">暂无指数数据</span>`;
		return;
	}
	container.innerHTML = state.indices
		.map((q) => {
			const sign = q.change_pct >= 0 ? "▲" : "▼";
			const colorClass = q.change_pct > 0 ? "text-up" : q.change_pct < 0 ? "text-down" : "text-neutral";
			return `<span class="index-quote ${colorClass}" data-index-code="${q.code}" data-index-name="${escapeHtml(q.name)}" style="cursor:pointer">
				<span class="index-name">${q.name}</span>
				<span class="index-price">${q.price.toFixed(2)}</span>
				<span class="index-arrow">${sign}</span>
				<span class="index-change">${q.change_pct.toFixed(2)}%</span>
			</span>`;
		})
		.join("");

	// Wire up click handlers
	container.querySelectorAll("[data-index-code]").forEach((el) => {
		el.addEventListener("click", () => {
			const code = (el as HTMLElement).dataset.indexCode!;
			selectSymbol(code, "index");
		});
	});
}

function renderSentiment() {
	const container = $("sentiment-bar");
	if (!state.sentiment) {
		container.innerHTML = `<span class="text-muted-foreground">市场情绪: 加载中...</span>`;
		return;
	}
	const s = state.sentiment;
	const pct = Math.round(s.sentimentIndex);
	const fillColor =
		pct >= 80 ? "linear-gradient(90deg, #22c55e, #16a34a)" :
		pct >= 60 ? "linear-gradient(90deg, #4ade80, #22c55e)" :
		pct >= 40 ? "linear-gradient(90deg, #eab308, #ca8a04)" :
		pct >= 20 ? "linear-gradient(90deg, #f97316, #ea580c)" :
		"linear-gradient(90deg, #ef4444, #dc2626)";
	const label =
		pct >= 80 ? "强烈偏多" :
		pct >= 60 ? "偏多" :
		pct >= 40 ? "中性" :
		pct >= 20 ? "偏空" :
		"强烈偏空";
	const nbSign = s.northboundFlow >= 0 ? "+" : "";
	container.innerHTML = `
		<span class="sentiment-stat">情绪 ${pct}</span>
		<div class="sentiment-progress">
			<div class="sentiment-progress-fill" style="width: ${pct}%; background: ${fillColor}"></div>
		</div>
		<span class="sentiment-label">${label}</span>
		<span class="sentiment-stat">
			<span class="sentiment-stat-dot" style="background: var(--color-up)"></span>涨${s.advance}
		</span>
		<span class="sentiment-stat">
			<span class="sentiment-stat-dot" style="background: var(--color-down)"></span>跌${s.decline}
		</span>
		<span class="sentiment-stat">涨停${s.limitUp}</span>
		<span class="sentiment-stat">跌停${s.limitDown}</span>
		<span class="sentiment-stat">北向 ${nbSign}${s.northboundFlow}亿</span>
	`;
}

function renderMarketStatus() {
	const container = $("market-status");
	const badge = container.querySelector(".market-status-badge");
	if (badge) {
		badge.textContent = state.marketPhase;
		badge.classList.remove("open", "closed", "pre");
		const phase = state.marketPhase;
		if (phase.includes("盘前") || phase.includes("竞价")) badge.classList.add("pre");
		else if (phase.includes("开盘") || phase.includes("交易中")) badge.classList.add("open");
		else badge.classList.add("closed");
	}
}

function buildMessageHTML(msg: ChatMessage): string {
	if (msg.role === "user") {
		return `<div class="message-wrapper user">
			<div class="message-avatar user">你</div>
			<div class="message-bubble user">${escapeHtml(msg.content)}</div>
		</div>`;
	}
	if (msg.role === "assistant") {
		return `<div class="message-wrapper assistant">
			<div class="message-avatar assistant">AI</div>
			<div class="message-bubble assistant">${formatMarkdown(msg.content)}${msg.isStreaming ? '<span class="animate-pulse">▌</span>' : ""}</div>
		</div>`;
	}
	return `<div class="message-wrapper system"><div class="message-bubble system">${escapeHtml(msg.content)}</div></div>`;
}

function renderMessages() {
	const container = $("message-list");
	const messages = state.messages;
	const existing = container.children;

	// Incremental update: append new messages or update last streaming one
	if (messages.length > existing.length) {
		// Append only new messages
		const fragment = document.createElement("div");
		for (let i = existing.length; i < messages.length; i++) {
			fragment.innerHTML += buildMessageHTML(messages[i]);
		}
		// Move nodes from fragment to container
		while (fragment.firstChild) {
			container.appendChild(fragment.firstChild);
		}
	} else if (messages.length === existing.length && messages.length > 0) {
		// Likely streaming update on the last message
		const lastMsg = messages[messages.length - 1];
		const lastEl = existing[existing.length - 1] as HTMLElement;
		if (lastEl && lastMsg.role === "assistant") {
			const bubble = lastEl.querySelector(".message-bubble.assistant") as HTMLElement | null;
			if (bubble) {
				bubble.innerHTML = formatMarkdown(lastMsg.content) + (lastMsg.isStreaming ? '<span class="animate-pulse">▌</span>' : "");
			}
		}
	} else if (messages.length < existing.length || messages.length === 0) {
		// Full rebuild only when messages were removed or list is empty
		container.innerHTML = messages.map(buildMessageHTML).join("");
	}

	// Auto scroll to bottom only if user is already near bottom
	const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
	if (nearBottom) {
		container.scrollTop = container.scrollHeight;
	}
}

function renderConnectionStatus() {
	const container = $("connection-status");
	const dot = container.querySelector(".connection-dot");
	const text = container.querySelector("span:last-child");
	if (state.connected) {
		if (dot) {
			dot.classList.remove("connecting");
			dot.classList.add("connected");
		}
		if (text) text.textContent = "已连接";
	} else {
		if (dot) {
			dot.classList.remove("connected");
			dot.classList.add("connecting");
		}
		if (text) text.textContent = "连接中...";
	}
}

function renderWatchlist() {
	const container = $("watchlist-panel");
	if (state.stockPools.length === 0) {
		container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><div>暂无股票池</div></div>`;
		return;
	}

	let html = ``;
	for (const pool of state.stockPools) {
		const isSelected = state.selectedPool?.id === pool.id;
		html += `
			<div class="pool-card ${isSelected ? 'active' : ''}" data-pool-id="${pool.id}">
				<div class="pool-card-header">
					<div class="pool-name">${escapeHtml(pool.name)}</div>
					<button class="pool-delete-btn" data-delete-pool-id="${pool.id}" title="删除股票池">×</button>
				</div>
				<div class="pool-count">${pool.item_count} 只</div>
			</div>
		`;
	}

	// Pool items
	if (state.selectedPool && state.poolItems.length > 0) {
		html += `<div class="pool-items-header">${escapeHtml(state.selectedPool.name)}</div>`;
		for (const item of state.poolItems) {
			const isSelected = state.selectedSymbol === item.code;
			html += `
				<div class="stock-item ${isSelected ? 'active' : ''}" data-stock-code="${item.code}">
					<span class="stock-item-code">${item.code}</span>
					<span class="stock-item-name">${escapeHtml(item.name)}</span>
				</div>
			`;
		}
	}

	container.innerHTML = html;

	// Wire up click handlers
	container.querySelectorAll("[data-pool-id]").forEach((el) => {
		el.addEventListener("click", (e) => {
			// Ignore clicks on delete button
			if ((e.target as HTMLElement).closest(".pool-delete-btn")) return;
			const poolId = Number((el as HTMLElement).dataset.poolId);
			selectPool(poolId);
		});
	});
	container.querySelectorAll("[data-delete-pool-id]").forEach((el) => {
		el.addEventListener("click", async (e) => {
			e.stopPropagation();
			const poolId = Number((el as HTMLElement).dataset.deletePoolId);
			const pool = state.stockPools.find((p) => p.id === poolId);
			if (!pool) return;
			if (!confirm(`确认删除股票池 "${pool.name}"？`)) return;
			try {
				await apiClient.deleteStockPool(poolId);
				if (state.selectedPool?.id === poolId) {
					state.selectedPool = null;
					state.poolItems = [];
					state.selectedSymbol = null;
					state.selectedQuote = null;
					state.selectedKlines = [];
					state.selectedIntraday = [];
					renderStockChartPanel();
				}
				await fetchStockPools();
			} catch (err) {
				alert("删除失败: " + (err as Error).message);
			}
		});
	});
	container.querySelectorAll("[data-stock-code]").forEach((el) => {
		el.addEventListener("click", () => {
			const code = (el as HTMLElement).dataset.stockCode!;
			selectSymbol(code, "stock");
		});
	});
}

// ─── Stock Chart Panel ──────────────────────────────────────

function renderStockChartPanel() {
	const container = $("stock-chart-panel");
	if (!state.selectedSymbol) {
		container.classList.add("hidden");
		disposeCharts();
		return;
	}
	container.classList.remove("hidden");
	disposeCharts(); // Clean up old chart instances before replacing DOM

	const q = state.selectedQuote;
	const code = state.selectedSymbol;
	const type = state.selectedType;
	const name = q?.name || code;
	const changeClass = q?.change_pct > 0 ? "text-up" : q?.change_pct < 0 ? "text-down" : "text-neutral";
	const sign = q?.change_pct >= 0 ? "+" : "";
	const price = q?.price ?? q?.latest ?? "-";
	const changePct = q?.change_pct != null ? `${sign}${q.change_pct.toFixed(2)}%` : "-";

	const periodButtons = ["daily", "week", "month"].map((p) => {
		const label = p === "daily" ? "日线" : p === "week" ? "周线" : "月线";
		const active = state.selectedPeriod === p ? "active" : "";
		return `<button class="period-btn ${active}" data-period="${p}">${label}</button>`;
	}).join("");

	const btnText = type === "index" ? "分析此指数" : "分析此股票";

	container.innerHTML = `
		<div class="stock-chart-header">
			<div class="stock-chart-info">
				<div class="stock-chart-name">${escapeHtml(name)}</div>
				<div class="stock-chart-code">${code}</div>
			</div>
			<div class="stock-chart-price">
				<div class="stock-chart-price-value ${changeClass}">${typeof price === "number" ? price.toFixed(2) : price}</div>
				<div class="stock-chart-price-change ${changeClass}">${changePct}</div>
			</div>
			<div class="stock-chart-periods">${periodButtons}</div>
			<button class="stock-chart-collapse-btn" id="chart-collapse-btn" title="收起/展开">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="18 15 12 9 6 15"></polyline>
				</svg>
			</button>
		</div>
		<div class="stock-chart-body ${state.chartPanelCollapsed ? 'collapsed' : ''}">
			<div class="intraday-chart-wrapper">
				<div class="chart-label">分时</div>
				<div id="intraday-chart-container" class="chart-container"></div>
			</div>
			<div class="kline-chart-wrapper">
				<div class="chart-label">${state.selectedPeriod === "daily" ? "日线" : state.selectedPeriod === "week" ? "周线" : "月线"}</div>
				<div id="kline-chart-container" class="chart-container"></div>
			</div>
		</div>
		<div class="stock-chart-footer ${state.chartPanelCollapsed ? 'collapsed' : ''}">
			<button class="stock-chart-analyze-btn" data-symbol="${code}" data-name="${escapeHtml(name)}" data-type="${type}">
				${btnText}
			</button>
		</div>
	`;

	// Wire up period buttons
	container.querySelectorAll("[data-period]").forEach((el) => {
		el.addEventListener("click", () => {
			const period = (el as HTMLElement).dataset.period as "daily" | "week" | "month";
			if (period !== state.selectedPeriod) {
				state.selectedPeriod = period;
				renderStockChartPanel();
				loadKlineData(code, period);
			}
		});
	});

	// Wire up collapse button
	const collapseBtn = container.querySelector("#chart-collapse-btn");
	if (collapseBtn) {
		collapseBtn.addEventListener("click", () => {
			state.chartPanelCollapsed = !state.chartPanelCollapsed;
			renderStockChartPanel();
		});
	}

	// Wire up analyze button
	const analyzeBtn = container.querySelector(".stock-chart-analyze-btn") as HTMLButtonElement | null;
	if (analyzeBtn) {
		analyzeBtn.addEventListener("click", () => {
			const sym = analyzeBtn.dataset.symbol;
			const nm = analyzeBtn.dataset.name;
			const tp = analyzeBtn.dataset.type;
			if (sym) {
				const input = $("message-input") as HTMLInputElement;
				if (tp === "index") {
					input.value = `请对 ${sym} ${nm || ""} 进行综合分析，包括技术面趋势、成分股表现和市场影响`;
				} else {
					input.value = `请对 ${sym} ${nm || ""} 进行综合分析，包括技术面、基本面和估值`;
				}
				input.focus();
			}
		});
	}

	// Render charts if not collapsed
	if (!state.chartPanelCollapsed) {
		requestAnimationFrame(() => {
			renderIntradayChart();
			renderKlineChart();
		});
	}
}

function renderIntradayChart() {
	const container = document.getElementById("intraday-chart-container");
	if (!container) return;

	if (state.selectedIntraday.length === 0) {
		container.innerHTML = `<div class="chart-empty">暂无分时数据</div>`;
		return;
	}

	initIntradayChart(container);
	if (!intradaySeries) return;

	const data = state.selectedIntraday.map((k) => ({
		time: toUTCTimestamp(k.date),
		value: k.close,
	}));
	intradaySeries.setData(data);
	if (intradayChart) {
		intradayChart.timeScale().fitContent();
	}
}

function renderKlineChart() {
	const container = document.getElementById("kline-chart-container");
	if (!container) return;

	if (state.selectedKlines.length === 0) {
		container.innerHTML = `<div class="chart-empty">暂无K线数据</div>`;
		return;
	}

	initKlineChart(container);
	if (!candleSeries || !volumeSeries) return;

	const candleData = state.selectedKlines.map((k) => ({
		time: k.date as string,
		open: k.open,
		high: k.high,
		low: k.low,
		close: k.close,
	}));

	const volumeData = state.selectedKlines.map((k) => ({
		time: k.date as string,
		value: k.volume,
		color: k.close >= k.open ? "rgba(239, 68, 68, 0.5)" : "rgba(34, 197, 94, 0.5)",
	}));

	candleSeries.setData(candleData);
	volumeSeries.setData(volumeData);
	if (klineChart) {
		klineChart.timeScale().fitContent();
	}
}

async function loadKlineData(code: string, period: "daily" | "week" | "month") {
	const limit = period === "daily" ? 100 : period === "week" ? 60 : 24;
	try {
		const klines = await apiClient.getKlines(code, { period, limit });
		state.selectedKlines = klines.map((k: any) => ({
			date: k.date,
			open: k.open,
			high: k.high,
			low: k.low,
			close: k.close,
			volume: k.volume,
		}));
		renderKlineChart();
	} catch (err) {
		console.error("Failed to fetch klines:", err);
		state.selectedKlines = [];
		renderKlineChart();
	}
}

async function loadIntradayData(code: string) {
	try {
		const data = await apiClient.getKlines(code, { period: "1m", limit: 240 });
		const today = getTodayStr();
		// Filter to today's data only for intraday chart
		state.selectedIntraday = data
			.filter((k: any) => typeof k.date === "string" && k.date.startsWith(today))
			.map((k: any) => ({
				date: k.date,
				open: k.open,
				high: k.high,
				low: k.low,
				close: k.close,
				volume: k.volume,
			}));
		renderIntradayChart();
	} catch (err) {
		console.error("Failed to fetch intraday:", err);
		state.selectedIntraday = [];
		renderIntradayChart();
	}
}

// ─── Tool Log Rendering ─────────────────────────────────────

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function renderToolLogs() {
	const container = $("tool-log-list");
	if (!container) return;
	if (state.toolLogs.length === 0) {
		container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔧</div><div>暂无工具调用</div></div>`;
		return;
	}
	container.innerHTML = state.toolLogs
		.map((log) => {
			const statusIcon = log.status === "running" ? `<span class="loading-spinner" style="width:0.625rem;height:0.625rem;border-width:1.5px;display:inline-block;vertical-align:middle;margin-right:0.25rem;"></span>` : "✓";
			return `
				<div class="tool-log-item ${log.status}">
					<div class="tool-log-header-row">
						<span class="tool-log-status">${statusIcon}</span>
						<span class="tool-log-name">${escapeHtml(log.name)}</span>
						<span class="tool-log-time">${formatTime(log.timestamp)}</span>
					</div>
					<div class="tool-log-content">${escapeHtml(log.content)}</div>
				</div>
			`;
		})
		.join("");
	// Auto scroll to bottom
	container.scrollTop = container.scrollHeight;
}

// ─── Calendar Rendering ─────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
	macro: "bg-blue-500",
	industry: "bg-green-500",
	stock: "bg-purple-500",
	earnings: "bg-orange-500",
	conference: "bg-cyan-500",
	unlock: "bg-red-500",
	dividend: "bg-pink-500",
	holder: "bg-yellow-500",
	other: "bg-gray-500",
};

const CATEGORY_LABELS: Record<string, string> = {
	macro: "宏观",
	industry: "行业",
	stock: "个股",
	earnings: "财报",
	conference: "会议",
	unlock: "解禁",
	dividend: "分红",
	holder: "股东",
	other: "其他",
};

function getMonthData(date: Date) {
	const year = date.getFullYear();
	const month = date.getMonth();
	const firstDay = new Date(year, month, 1);
	const lastDay = new Date(year, month + 1, 0);
	const startOffset = firstDay.getDay(); // 0=Sunday
	const daysInMonth = lastDay.getDate();
	return { year, month, startOffset, daysInMonth };
}

function formatDateKey(year: number, month: number, day: number): string {
	return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getEventsForDate(dateKey: string, events: CalendarEvent[]): CalendarEvent[] {
	return events.filter((e) => e.event_date === dateKey);
}

function getMonthEvents(monthDate: Date, events: CalendarEvent[]): CalendarEvent[] {
	const year = monthDate.getFullYear();
	const month = monthDate.getMonth();
	const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;

	// Filter events for this month and deduplicate by (date, title)
	const seen = new Set<string>();
	const monthEvents = events
		.filter((e) => {
			if (!e.event_date.startsWith(monthPrefix)) return false;
			const key = `${e.event_date}|${e.title}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => {
			// Sort by date first, then by importance
			if (a.event_date !== b.event_date) return a.event_date.localeCompare(b.event_date);
			const impOrder = { high: 0, medium: 1, low: 2 };
			return (impOrder[a.importance as keyof typeof impOrder] ?? 1) - (impOrder[b.importance as keyof typeof impOrder] ?? 1);
		});

	return monthEvents;
}

function renderCalendar() {
	const container = $("calendar-panel");
	if (!container) return;

	const { year, month, startOffset, daysInMonth } = getMonthData(state.calendarMonth);
	const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
	const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

	let html = `
		<div class="calendar-month-nav">
			<button id="cal-prev">&lt;</button>
			<span class="calendar-month-label">${year}年${monthNames[month]}</span>
			<button id="cal-next">&gt;</button>
		</div>
		<div class="calendar-weekdays">
			${weekdayLabels.map((d) => `<div class="calendar-weekday">${d}</div>`).join("")}
		</div>
		<div class="calendar-days">
	`;

	// Empty cells before the first day
	for (let i = 0; i < startOffset; i++) {
		html += `<div class="calendar-day empty"></div>`;
	}

	const today = new Date();
	const todayKey = formatDateKey(today.getFullYear(), today.getMonth(), today.getDate());

	for (let day = 1; day <= daysInMonth; day++) {
		const dateKey = formatDateKey(year, month, day);
		const dayEvents = getEventsForDate(dateKey, state.calendarEvents);
		const isToday = dateKey === todayKey;
		const isSelected = dateKey === state.calendarSelectedDate;
		const hasEvents = dayEvents.length > 0;

		// Group events by category for dot colors
		const categoryDots = hasEvents
			? [...new Set(dayEvents.map((e) => e.category))]
					.slice(0, 3)
					.map((cat) => `<span class="calendar-dot ${CATEGORY_COLORS[cat] || "bg-gray-500"}"></span>`)
					.join("")
			: "";

		html += `
			<div class="calendar-day ${isToday ? "today" : ""} ${isSelected ? "selected" : ""} ${hasEvents ? "has-events" : ""}"
			     data-date="${dateKey}">
				<div class="calendar-day-num">${day}</div>
				<div class="calendar-dots">${categoryDots}</div>
			</div>
		`;
	}

	html += `</div>`;

	// Monthly event list (always visible)
	const monthEvents = getMonthEvents(state.calendarMonth, state.calendarEvents);
	if (monthEvents.length > 0) {
		html += `<div class="calendar-events-section">`;
		html += `<div class="calendar-events-title">本月重点关注</div>`;
		for (const ev of monthEvents) {
			const catLabel = CATEGORY_LABELS[ev.category] || ev.category;
			const catColor = CATEGORY_COLORS[ev.category] || "bg-gray-500";
			const dateLabel = ev.source === "seasonal" ? "预计" : ev.event_date.slice(5);
			html += `
				<div class="calendar-event-card"
				     data-event-id="${ev.id || ""}" data-event-title="${escapeHtml(ev.title)}" data-event-date="${ev.event_date}"
				     data-event-category="${ev.category}" data-event-code="${ev.code || ""}">
					<div class="calendar-event-header">
						<span class="calendar-event-badge ${catColor}"></span>
						<span class="calendar-event-date">${dateLabel}</span>
						<span class="calendar-event-title">${escapeHtml(ev.title)}</span>
					</div>
					${ev.description ? `<div class="calendar-event-desc">${escapeHtml(ev.description)}</div>` : ""}
				</div>
			`;
		}
		html += `</div>`;
	}

	// Loading indicator
	if (state.calendarLoading) {
		html += `<div class="calendar-events-section" style="text-align:center"><span class="loading-spinner"></span></div>`;
	}

	container.innerHTML = html;

	// Wire up click handlers
	container.querySelectorAll(".calendar-day[data-date]").forEach((el) => {
		el.addEventListener("click", () => {
			const dateKey = (el as HTMLElement).dataset.date!;
			state.calendarSelectedDate = state.calendarSelectedDate === dateKey ? null : dateKey;
			renderCalendar();

			// Scroll to and highlight the first event for the selected date
			if (state.calendarSelectedDate) {
				const targetEvent = container.querySelector(
					`.calendar-event-card[data-event-date="${state.calendarSelectedDate}"]`,
				);
				if (targetEvent) {
					targetEvent.classList.add("highlight");
					targetEvent.scrollIntoView({ behavior: "smooth", block: "nearest" });
					setTimeout(() => targetEvent.classList.remove("highlight"), 1500);
				}
			}
		});
	});

	container.querySelectorAll(".calendar-event-card").forEach((el) => {
		el.addEventListener("click", () => {
			const code = (el as HTMLElement).dataset.eventCode;
			if (code) {
				selectSymbol(code, "stock");
			}
			const title = (el as HTMLElement).dataset.eventTitle!;
			const date = (el as HTMLElement).dataset.eventDate!;
			const category = (el as HTMLElement).dataset.eventCategory!;
			const input = $("message-input") as HTMLInputElement;
			const catLabel = CATEGORY_LABELS[category] || category;
			input.value = `请分析 ${date} 的${catLabel}事件："${title}"，评估其对A股市场的影响和投资机会`;
			input.focus();
		});
	});

	const prevBtn = container.querySelector("#cal-prev");
	const nextBtn = container.querySelector("#cal-next");
	if (prevBtn) {
		prevBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
			fetchCalendarForMonth();
		});
	}
	if (nextBtn) {
		nextBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
			fetchCalendarForMonth();
		});
	}
}

// ─── Hot Stocks Rendering ───────────────────────────────────

function renderHotStocks() {
	const container = $("hot-stocks-list");
	if (!container) return;

	if (state.hotStocksLoading) {
		container.innerHTML = `<div class="empty-state"><span class="loading-spinner"></span></div>`;
		return;
	}

	if (state.hotStocks.length === 0) {
		container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📈</div><div>暂无强势股数据</div></div>`;
		return;
	}

	let html = `<div class="hot-stocks-date">${escapeHtml(state.hotStocksDate)} 同花顺热点</div>`;
	for (const stock of state.hotStocks) {
		const changeClass = stock.change_pct > 0 ? "text-up" : stock.change_pct < 0 ? "text-down" : "text-neutral";
		const sign = stock.change_pct >= 0 ? "+" : "";
		const reasons = stock.reason
			.split(/[+、,，;；]/)
			.filter((r) => r.trim())
			.map((r) => `<span class="hot-stock-tag">${escapeHtml(r.trim())}</span>`)
			.join("");

		html += `
			<div class="hot-stock-item" data-stock-code="${stock.code}" data-stock-name="${escapeHtml(stock.name)}">
				<div class="hot-stock-header">
					<span class="hot-stock-name">${escapeHtml(stock.name)}</span>
					<span class="hot-stock-code">${stock.code}</span>
					<span class="hot-stock-change ${changeClass}">${sign}${stock.change_pct.toFixed(2)}%</span>
				</div>
				<div class="hot-stock-tags">${reasons}</div>
				<div class="hot-stock-metrics">
					<span>价格 ${stock.price.toFixed(2)}</span>
					<span>换手 ${stock.turnover_pct.toFixed(1)}%</span>
					<span>市值 ${(stock.mcap_yi).toFixed(1)}亿</span>
				</div>
			</div>
		`;
	}
	container.innerHTML = html;

	// Wire up click handlers
	container.querySelectorAll(".hot-stock-item").forEach((el) => {
		el.addEventListener("click", () => {
			const code = (el as HTMLElement).dataset.stockCode!;
			selectSymbol(code, "stock");
		});
	});
}

// ─── Utilities ──────────────────────────────────────────────

function escapeHtml(text: string): string {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}

function formatMarkdown(text: string): string {
	// Very simple markdown formatter
	return escapeHtml(text)
		.replace(/\n/g, "<br>")
		.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
}

// ─── API / WebSocket handlers ───────────────────────────────

async function fetchIndices() {
	try {
		const quotes = await apiClient.getIndices();
		state.indices = quotes.map((q: any) => ({
			code: q.code,
			name: q.name,
			price: q.latest || q.price || 0,
			change_pct: q.change_pct || 0,
		}));
		state.indicesLoaded = true;
		renderIndices();
	} catch (err) {
		console.error("Failed to fetch indices:", err);
		state.indicesLoaded = true;
		renderIndices();
	}
}

async function fetchStockPools() {
	try {
		state.stockPools = await apiClient.getStockPools();
		renderWatchlist();
	} catch (err) {
		console.error("Failed to fetch stock pools:", err);
	}
}

async function fetchCalendarForMonth() {
	const year = state.calendarMonth.getFullYear();
	const month = state.calendarMonth.getMonth();
	const start = formatDateKey(year, month, 1);
	const end = formatDateKey(year, month + 1, 0);
	try {
		state.calendarEvents = await apiClient.getCalendar(start, end);
		renderCalendar();
	} catch (err) {
		console.error("Failed to fetch calendar:", err);
	}
}

async function refreshCalendar() {
	state.calendarLoading = true;
	renderCalendar();
	try {
		const result = await apiClient.refreshCalendar();
		console.log("[Calendar] Refreshed:", result);
		await fetchCalendarForMonth();
	} catch (err) {
		console.error("Failed to refresh calendar:", err);
	} finally {
		state.calendarLoading = false;
		renderCalendar();
	}
}

async function fetchHotStocks() {
	try {
		state.hotStocksLoading = true;
		renderHotStocks();
		const result = await apiClient.getHotStocks(undefined, 50);
		state.hotStocks = result.rows || [];
		state.hotStocksDate = result.date || "";
		state.hotStocksLoading = false;
		renderHotStocks();
	} catch (err) {
		console.error("Failed to fetch hot stocks:", err);
		state.hotStocksLoading = false;
		renderHotStocks();
	}
}

async function selectPool(poolId: number) {
	const pool = state.stockPools.find((p) => p.id === poolId);
	if (!pool) return;
	state.selectedPool = pool;
	state.poolItems = [];
	renderWatchlist();

	try {
		const result = await apiClient.getStockPool(poolId);
		state.poolItems = result.items.map((s: any) => ({ code: s.code, name: s.name }));
		renderWatchlist();
	} catch (err) {
		console.error("Failed to fetch pool items:", err);
	}
}

async function selectSymbol(code: string, type: "stock" | "index" = "stock") {
	// Dispose old charts and stop polling before re-rendering
	disposeCharts();

	state.selectedSymbol = code;
	state.selectedType = type;
	state.selectedQuote = null;
	state.selectedKlines = [];
	state.selectedIntraday = [];
	state.chartPanelCollapsed = false;

	renderWatchlist();
	renderStockChartPanel();
	renderIndices();

	// Fetch quote, klines, and intraday in parallel
	const [quoteResult, klinesResult, intradayResult] = await Promise.allSettled([
		apiClient.getQuote(code),
		apiClient.getKlines(code, { period: state.selectedPeriod, limit: state.selectedPeriod === "daily" ? 100 : state.selectedPeriod === "week" ? 60 : 24 }),
		apiClient.getKlines(code, { period: "1m", limit: 240 }),
	]);

	if (quoteResult.status === "fulfilled") {
		state.selectedQuote = quoteResult.value;
	} else {
		console.error("Failed to fetch quote:", quoteResult.reason);
	}

	if (klinesResult.status === "fulfilled") {
		state.selectedKlines = klinesResult.value.map((k: any) => ({
			date: k.date,
			open: k.open,
			high: k.high,
			low: k.low,
			close: k.close,
			volume: k.volume,
		}));
	} else {
		console.error("Failed to fetch klines:", klinesResult.reason);
	}

	if (intradayResult.status === "fulfilled") {
		const today = getTodayStr();
		state.selectedIntraday = intradayResult.value
			.filter((k: any) => typeof k.date === "string" && k.date.startsWith(today))
			.map((k: any) => ({
				date: k.date,
				open: k.open,
				high: k.high,
				low: k.low,
				close: k.close,
				volume: k.volume,
			}));
	} else {
		console.error("Failed to fetch intraday:", intradayResult.reason);
	}

	renderStockChartPanel();

	// Start real-time polling for intraday data during trading hours
	startIntradayPolling(code);
}

function handleAgentEvent(ev: any) {
	let needRenderMessages = false;
	let needRenderToolLogs = false;

	switch (ev.type) {
		case "message_start": {
			if (ev.message?.role === "assistant") {
				state.messages.push({ role: "assistant", content: "", isStreaming: true });
				state.isStreaming = true;
				needRenderMessages = true;
			}
			break;
		}
		case "message_update": {
			if (ev.assistantMessageEvent?.type === "text_delta") {
				const lastMsg = state.messages[state.messages.length - 1];
				if (lastMsg?.role === "assistant") {
					lastMsg.content += ev.assistantMessageEvent.delta;
					needRenderMessages = true;
				}
			}
			break;
		}
		case "message_end": {
			const lastMsg = state.messages[state.messages.length - 1];
			if (lastMsg?.role === "assistant") {
				lastMsg.isStreaming = false;
			}
			state.isStreaming = false;
			needRenderMessages = true;
			break;
		}
		case "tool_execution_start": {
			state.toolLogs.push({
				id: state.nextToolLogId++,
				toolCallId: ev.toolCallId,
				name: ev.toolName,
				status: "running",
				content: `调用 ${ev.toolName}...`,
				timestamp: Date.now(),
			});
			needRenderToolLogs = true;
			break;
		}
		case "tool_execution_update": {
			const log = state.toolLogs.find((l) => l.toolCallId === ev.toolCallId && l.status === "running");
			if (log) {
				const partialText = ev.partialResult?.content?.find((c: any) => c.type === "text")?.text || "";
				if (partialText) {
					log.content = partialText.slice(0, 300);
					needRenderToolLogs = true;
				}
			}
			break;
		}
		case "tool_execution_end": {
			let resultText = "";
			if (typeof ev.result === "string") {
				resultText = ev.result;
			} else if (ev.result?.content) {
				resultText = ev.result.content.find((c: any) => c.type === "text")?.text || "";
			}
			const log = state.toolLogs.find((l) => l.toolCallId === ev.toolCallId);
			if (log) {
				log.status = "done";
				log.content = resultText.slice(0, 300);
				needRenderToolLogs = true;
			}
			// Auto-refresh stock pools when a new pool is created
			if (ev.toolName === "manage_stock_pool" && resultText.includes("创建成功")) {
				fetchStockPools();
			}
			break;
		}
		case "agent_end": {
			state.isStreaming = false;
			needRenderMessages = true;
			// Clean up any tool logs that are still running when the agent ends
			for (const log of state.toolLogs) {
				if (log.status === "running") {
					log.status = "done";
					needRenderToolLogs = true;
				}
			}
			break;
		}
	}
	if (needRenderMessages) renderMessages();
	if (needRenderToolLogs) renderToolLogs();
}

function handleTradingEvent(ev: any) {
	if (ev.type === "sentiment_update" && ev.data) {
		state.sentiment = ev.data;
		renderSentiment();
	}
	if (ev.type === "mode_change") {
		state.marketPhase = ev.mode;
		renderMarketStatus();
	}
}

// ─── Event wiring ───────────────────────────────────────────

function setupWebSocket() {
	apiClient.addEventListener("connected", () => {
		state.connected = true;
		renderConnectionStatus();
		apiClient.getState();
	});

	apiClient.addEventListener("disconnected", () => {
		state.connected = false;
		renderConnectionStatus();
	});

	apiClient.addEventListener("agent_event", (e: any) => {
		handleAgentEvent(e.detail.event);
	});

	apiClient.addEventListener("trading_event", (e: any) => {
		handleTradingEvent(e.detail.event);
	});

	apiClient.addEventListener("state", (e: any) => {
		const s = e.detail.state;
		if (s.mode) state.marketPhase = s.mode;
		renderMarketStatus();
	});

	apiClient.connect();
}

function setupInput() {
	const input = $("message-input") as HTMLInputElement;
	const sendBtn = $("send-btn");

	const send = () => {
		const text = input.value.trim();
		if (!text || state.isStreaming) return;
		state.messages.push({ role: "user", content: text });
		renderMessages();
		apiClient.prompt(text);
		input.value = "";
	};

	sendBtn.addEventListener("click", send);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	});

	// Calendar refresh button
	const calRefreshBtn = document.getElementById("calendar-refresh-btn");
	if (calRefreshBtn) {
		calRefreshBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			refreshCalendar();
		});
	}

	// Collapsible panel toggles
	const hotStocksToggle = document.getElementById("hot-stocks-toggle");
	if (hotStocksToggle) {
		hotStocksToggle.addEventListener("click", () => {
			state.hotStocksCollapsed = !state.hotStocksCollapsed;
			const chevron = hotStocksToggle.querySelector(".collapsible-chevron");
			const content = document.getElementById("hot-stocks-content");
			if (chevron) chevron.classList.toggle("collapsed", state.hotStocksCollapsed);
			if (content) content.classList.toggle("collapsed", state.hotStocksCollapsed);
		});
	}

	const calendarToggle = document.getElementById("calendar-toggle");
	if (calendarToggle) {
		calendarToggle.addEventListener("click", () => {
			state.calendarCollapsed = !state.calendarCollapsed;
			const chevron = calendarToggle.querySelector(".collapsible-chevron");
			const content = document.getElementById("calendar-content");
			if (chevron) chevron.classList.toggle("collapsed", state.calendarCollapsed);
			if (content) content.classList.toggle("collapsed", state.calendarCollapsed);
		});
	}
}

// ─── Mobile Drawer Helpers ──────────────────────────────────

function updateMobileDrawers() {
	const leftSidebar = document.getElementById("left-sidebar");
	const rightSidebar = document.getElementById("right-sidebar");
	const overlay = document.getElementById("sidebar-overlay");

	if (leftSidebar) {
		leftSidebar.classList.toggle("open", state.mobileLeftOpen);
	}
	if (rightSidebar) {
		rightSidebar.classList.toggle("open", state.mobileRightOpen);
	}
	if (overlay) {
		overlay.classList.toggle("active", state.mobileLeftOpen || state.mobileRightOpen);
	}
}

function toggleMobileLeft() {
	state.mobileLeftOpen = !state.mobileLeftOpen;
	if (state.mobileLeftOpen) state.mobileRightOpen = false;
	updateMobileDrawers();
}

function toggleMobileRight() {
	state.mobileRightOpen = !state.mobileRightOpen;
	if (state.mobileRightOpen) state.mobileLeftOpen = false;
	updateMobileDrawers();
}

function closeMobileDrawers() {
	state.mobileLeftOpen = false;
	state.mobileRightOpen = false;
	updateMobileDrawers();
}

function setupMobileDrawers() {
	const leftToggle = document.getElementById("mobile-left-toggle");
	const rightToggle = document.getElementById("mobile-right-toggle");
	const leftClose = document.getElementById("mobile-left-close");
	const rightClose = document.getElementById("mobile-right-close");
	const overlay = document.getElementById("sidebar-overlay");

	if (leftToggle) leftToggle.addEventListener("click", toggleMobileLeft);
	if (rightToggle) rightToggle.addEventListener("click", toggleMobileRight);
	if (leftClose) leftClose.addEventListener("click", closeMobileDrawers);
	if (rightClose) rightClose.addEventListener("click", closeMobileDrawers);
	if (overlay) overlay.addEventListener("click", closeMobileDrawers);

	// Auto-close drawers on window resize to desktop
	window.addEventListener("resize", () => {
		if (window.innerWidth > 768) {
			closeMobileDrawers();
		}
	});
}

// ─── App HTML ───────────────────────────────────────────────

function renderApp() {
	const app = $("app");
	app.innerHTML = `
		<div class="trading-layout">
			<!-- Header -->
			<div class="trading-header">
				<button id="mobile-left-toggle" class="mobile-toggle" aria-label="股票池">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="3" y1="12" x2="21" y2="12"></line>
						<line x1="3" y1="6" x2="21" y2="6"></line>
						<line x1="3" y1="18" x2="21" y2="18"></line>
					</svg>
				</button>
				<div class="trading-header-logo">
					<div class="trading-header-logo-icon">π</div>
					<span>Trading Agent</span>
				</div>
				<div id="index-bar" class="index-bar">
					<span class="text-muted-foreground">加载中...</span>
				</div>
				<button id="mobile-right-toggle" class="mobile-toggle" aria-label="投资日历">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
						<line x1="16" y1="2" x2="16" y2="6"></line>
						<line x1="8" y1="2" x2="8" y2="6"></line>
						<line x1="3" y1="10" x2="21" y2="10"></line>
					</svg>
				</button>
			</div>

			<!-- Sentiment bar -->
			<div id="sentiment-bar" class="sentiment-bar">
				<span class="text-muted-foreground">市场情绪: 加载中...</span>
			</div>

			<!-- Market status -->
			<div id="market-status" class="market-status-bar">
				<span class="market-status-badge closed" id="market-phase">休市</span>
				<span class="connection-badge" id="connection-status">
					<span class="connection-dot connecting"></span>
					<span>连接中...</span>
				</span>
			</div>

			<!-- Main content: sidebar + chat + calendar -->
			<div class="flex flex-1 overflow-hidden">
				<!-- Overlay for mobile drawers -->
				<div id="sidebar-overlay" class="sidebar-overlay"></div>

				<!-- Left sidebar: Watchlist -->
				<div id="left-sidebar" class="sidebar">
					<div class="sidebar-header">
						<span>股票池</span>
						<button id="mobile-left-close" class="mobile-toggle" aria-label="关闭">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>
					</div>
					<div id="watchlist-panel" class="sidebar-content"></div>
				</div>

				<!-- Center: Chat area -->
				<div class="chat-area">
					<div class="chat-main">
						<!-- Stock Chart Panel -->
						<div id="stock-chart-panel" class="stock-chart-panel hidden"></div>
						<div id="message-list" class="message-list"></div>
						<div class="chat-input-area">
							<div class="chat-input-wrapper">
								<input
									id="message-input"
									type="text"
									placeholder="输入消息..."
									class="chat-input"
								/>
								<button id="send-btn" class="chat-send-btn" aria-label="发送">
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<line x1="22" y1="2" x2="11" y2="13"></line>
										<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
									</svg>
								</button>
							</div>
						</div>
					</div>
					<div id="tool-log-panel" class="tool-log-panel">
						<div class="tool-log-panel-header">工具调用</div>
						<div id="tool-log-list" class="tool-log-list"></div>
					</div>
				</div>

				<!-- Right sidebar: Hot Stocks + Calendar -->
				<div id="right-sidebar" class="calendar-sidebar">
					<!-- Hot Stocks Panel -->
					<div class="collapsible-panel" id="hot-stocks-panel">
						<div class="collapsible-header" id="hot-stocks-toggle">
							<span class="collapsible-title">📈 强势股</span>
							<svg class="collapsible-chevron ${state.hotStocksCollapsed ? 'collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="18 15 12 9 6 15"></polyline>
							</svg>
						</div>
						<div class="collapsible-content ${state.hotStocksCollapsed ? 'collapsed' : ''}" id="hot-stocks-content">
							<div id="hot-stocks-list" class="hot-stocks-list"></div>
						</div>
					</div>

					<!-- Calendar Panel -->
					<div class="collapsible-panel" id="calendar-panel-wrapper">
						<div class="collapsible-header" id="calendar-toggle">
							<span class="collapsible-title">📅 投资日历</span>
							<div style="display:flex;gap:0.5rem;align-items:center;">
								<button id="calendar-refresh-btn" class="calendar-refresh-btn" title="刷新日历数据">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<polyline points="23 4 23 10 17 10"></polyline>
										<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
									</svg>
								</button>
								<svg class="collapsible-chevron ${state.calendarCollapsed ? 'collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="18 15 12 9 6 15"></polyline>
								</svg>
							</div>
						</div>
						<div class="collapsible-content ${state.calendarCollapsed ? 'collapsed' : ''}" id="calendar-content">
							<div id="calendar-panel" class="calendar-panel"></div>
						</div>
					</div>

					<button id="mobile-right-close" class="mobile-toggle mobile-panel-close" aria-label="关闭">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				</div>
			</div>
		</div>
	`;
}

// ─── Init ───────────────────────────────────────────────────

function init() {
	renderApp();
	setupWebSocket();
	setupInput();
	setupMobileDrawers();
	fetchIndices();
	fetchStockPools();
	fetchCalendarForMonth();
	fetchHotStocks();

	// Refresh indices every 60s
	setInterval(fetchIndices, 60_000);
}

init();
