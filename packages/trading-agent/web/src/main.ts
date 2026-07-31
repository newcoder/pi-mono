import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { apiClient } from "./api/client.js";
import { createChart, CandlestickSeries, HistogramSeries, AreaSeries } from "lightweight-charts";
import { pinyin } from "pinyin-pro";

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

interface SectorData {
	name: string;
	change_pct: number;
	up_count: number;
	down_count: number;
	leader: string;
	leader_change: number;
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
	change_pct?: number | null;
	latest?: number | null;
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
	marketPhase: "closed" as string,
	connected: false,
	isStreaming: false,
	stockPools: [] as StockPool[],
	selectedPool: null as StockPool | null,
	poolItems: [] as PoolItem[],
	// Chart panel state (replaces selectedStock/stockQuote)
	selectedSymbol: null as string | null,
	selectedType: "stock" as "stock" | "index",
	selectedName: null as string | null,
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
	// News state
	newsItems: [] as Array<{
		title: string;
		content: string;
		time: string;
		source: string;
		url: string;
		source_type: string;
	}>,
	newsLoading: false,
	newsCollapsed: false,
	// Mobile drawer state
	mobileLeftOpen: false,
	mobileRightOpen: false,
	// Tool log state
	toolLogs: [] as ToolLog[],
	nextToolLogId: 0,
	toolLogCollapsed: false,
	// File attachments
	attachedFiles: [] as Array<{ name: string; content: string; mimeType: string }>,
	// Search state
	searchQuery: "",
	searchResults: [] as Array<{ code: string; name: string; market: number }>,
	searchHighlightedIndex: -1,
	searchDropdownOpen: false,
	recentPoolId: null as number | null,
	allStocks: [] as Array<{ code: string; name: string; market: number }>,
	allStocksLoaded: false,
};

// ─── Chart instances ────────────────────────────────────────

let intradayChart: any = null;
let intradaySeries: any = null;
let klineChart: any = null;
let candleSeries: any = null;
let volumeSeries: any = null;

// ─── Time helpers ───────────────────────────────────────────

/** Convert 'YYYY-MM-DD HH:MM:SS' to local timestamp (seconds) for lightweight-charts.
 *  Preserves wall-clock time so A-share 09:30 displays as 09:30 regardless of browser timezone. */
function toLocalTimestamp(dateStr: string): number {
	const [datePart, timePart] = dateStr.split(" ");
	const [year, month, day] = datePart.split("-").map(Number);
	const [hour, minute, second] = (timePart || "00:00:00").split(":").map(Number);
	return Math.floor(new Date(year, month - 1, day, hour, minute, second).getTime() / 1000);
}

/** Get today's date string YYYY-MM-DD */
function getTodayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

// ─── Real-time polling ──────────────────────────────────────

let intradayPollTimer: number | null = null;
const INTRADAY_POLL_INTERVAL = 5000; // 5 seconds

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
				intradaySeries.update({ time: toLocalTimestamp(k.date), value: k.close });
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

function readFileAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = reject;
		reader.readAsText(file);
	});
}

function readFileAsDataURL(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
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
				// @ts-ignore
				tickMarkFormatter: (time: number) => {
					const d = new Date(time * 1000);
					return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
				},
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
				// @ts-ignore
				tickMarkFormatter: (time: number | string) => {
					if (typeof time == "string") return time;
					const d = new Date(time * 1000);
					return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
				},
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
				const name = (el as HTMLElement).dataset.indexName;
			selectSymbol(code, "index", name);
		});
	});
}


function buildAttachmentHTML(files: Array<{ name: string; mimeType: string }>): string {
	if (!files || files.length === 0) return "";
	const items = files.map((f) => {
		const icon = f.mimeType.startsWith("image/") ? "🖼️" : "📄";
		return `<span class="attachment-tag">${icon} ${escapeHtml(f.name)}</span>`;
	}).join("");
	return `<div class="message-attachments">${items}</div>`;
}

function buildMessageHTML(msg: ChatMessage): string {
	if (msg.role === "user") {
		const attachments = (msg as any).attachments ? buildAttachmentHTML((msg as any).attachments) : "";
		return `<div class="message-wrapper user">
			<div class="message-avatar user">你</div>
			<div class="message-bubble user">${attachments}${formatMarkdown(msg.content)}</div>
		</div>`;
	}
	if (msg.role === "assistant") {
		return `<div class="message-wrapper assistant">
			<div class="message-avatar assistant">AI</div>
			<div class="message-bubble assistant">${formatMessageContent(msg.content)}${msg.isStreaming ? '<span class="animate-pulse">▌</span>' : ""}</div>
		</div>`;
	}
	return `<div class="message-wrapper system"><div class="message-bubble system">${formatMessageContent(msg.content)}</div></div>`;
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
				bubble.innerHTML = formatMessageContent(lastMsg.content) + (lastMsg.isStreaming ? '<span class="animate-pulse">▌</span>' : "");
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

function renderWatchlist() {
	const poolListEl = $("pool-list");
	const poolItemsEl = $("pool-items");

	if (state.stockPools.length === 0) {
		poolListEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><div>暂无股票池</div></div>`;
		poolItemsEl.innerHTML = "";
		return;
	}

	// Render pool cards into left column
	let poolsHtml = ``;
	for (const pool of state.stockPools) {
		const isSelected = state.selectedPool?.id === pool.id;
		poolsHtml += `
			<div class="pool-card ${isSelected ? 'active' : ''}" data-pool-id="${pool.id}">
				<div class="pool-card-header">
					<div class="pool-name"><span class="pool-id">[${pool.id}]</span> ${escapeHtml(pool.name)}</div>
					<button class="pool-delete-btn" data-delete-pool-id="${pool.id}" title="删除股票池">×</button>
				</div>
				<div class="pool-count">${pool.item_count} 只</div>
			</div>
		`;
	}
	poolListEl.innerHTML = poolsHtml;

	// Render pool items into right column
	if (state.selectedPool && state.poolItems.length > 0) {
		let itemsHtml = `<div class="pool-items-header">${escapeHtml(state.selectedPool.name)}</div>`;
		// 最近访问：最新的放在最前面（数据库按 added_at 升序，这里反转）
		const displayItems = state.selectedPool.name === "最近访问" ? [...state.poolItems].reverse() : state.poolItems;
		for (const item of displayItems) {
			const isSelected = state.selectedSymbol === item.code;
			const changePct = item.change_pct;
			const latest = item.latest;
			let priceHtml = "";
			let changeHtml = "";
			if (latest != null) {
				priceHtml = `<span class="stock-item-price">${latest.toFixed(2)}</span>`;
			}
			if (changePct != null) {
				const isUp = changePct > 0;
				const isDown = changePct < 0;
				const sign = isUp ? "+" : "";
				const colorClass = isUp ? "stock-item-up" : isDown ? "stock-item-down" : "";
				changeHtml = `<span class="stock-item-change ${colorClass}">${sign}${changePct.toFixed(2)}%</span>`;
			}
			itemsHtml += `
				<div class="stock-item ${isSelected ? 'active' : ''}" data-stock-code="${item.code}" data-stock-name="${escapeHtml(item.name)}">
					<span class="stock-item-code">${item.code}</span>
					<span class="stock-item-name">${escapeHtml(item.name)}</span>
					${priceHtml}
					${changeHtml}
				</div>
			`;
		}
		poolItemsEl.innerHTML = itemsHtml;
	} else {
		poolItemsEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📂</div><div>选择股票池查看个股</div></div>`;
	}

	// Wire up pool card click handlers
	poolListEl.querySelectorAll("[data-pool-id]").forEach((el) => {
		el.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".pool-delete-btn")) return;
			const poolId = Number((el as HTMLElement).dataset.poolId);
			selectPool(poolId);
		});
	});
	poolListEl.querySelectorAll("[data-delete-pool-id]").forEach((el) => {
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
					state.selectedName = null;
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

	// Wire up stock item click handlers
	poolItemsEl.querySelectorAll("[data-stock-code]").forEach((el) => {
		el.addEventListener("click", () => {
			const code = (el as HTMLElement).dataset.stockCode!;
			const name = (el as HTMLElement).dataset.stockName;
			selectSymbol(code, "stock", name);
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
	const name = state.selectedName || q?.name || code;
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
				loadKlineData(code, period, type);
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
		container.innerHTML = `<div class="chart-loading">加载中...</div>`;
		return;
	}

	// Clear any placeholder from a previous render before creating the chart
	if (!intradayChart) {
		container.innerHTML = "";
	}

	initIntradayChart(container);
	if (!intradaySeries) return;

	const data = state.selectedIntraday.map((k) => ({
		time: toLocalTimestamp(k.date),
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
		// Show last 6 months by default instead of all data
		const total = candleData.length;
		const barsFor6Months =
			state.selectedPeriod === "month" ? 6 :
			state.selectedPeriod === "week" ? 26 :
			130; // daily: ~6 months of trading days
		const fromIndex = Math.max(0, total - barsFor6Months);
		if (total > 1 && fromIndex < total - 1) {
			klineChart.timeScale().setVisibleLogicalRange({ from: fromIndex, to: total - 1 });
		} else {
			klineChart.timeScale().fitContent();
		}
	}
}

async function loadKlineData(code: string, period: "daily" | "week" | "month", type: "stock" | "index" = state.selectedType) {
	const limit = 10000;
	try {
		const klines = type === "index"
			? await apiClient.getIndustryKlines(code, { period, limit })
			: await apiClient.getKlines(code, { period, limit });
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
		// Use rAF to ensure DOM layout is complete before creating chart
		requestAnimationFrame(() => renderIntradayChart());
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

// ─── News Rendering ─────────────────────────────────────────

function renderNews() {
	const container = $("news-panel");
	if (!container) return;

	if (state.newsLoading) {
		container.innerHTML = `<div class="empty-state"><span class="loading-spinner"></span></div>`;
		return;
	}

	if (state.newsItems.length === 0) {
		container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📰</div><div>暂无新闻数据</div></div>`;
		return;
	}

	let html = "";
	for (const item of state.newsItems.slice(0, 20)) {
		const sourceClass = item.source_type === "eastmoney_stock" ? "news-source-stock" :
			item.source_type === "cls_telegraph" ? "news-source-cls" : "news-source-global";
		html += `
			<div class="news-item" data-url="${escapeHtml(item.url)}" title="${escapeHtml(item.title)}"
				 style="cursor:${item.url ? 'pointer' : 'default'};">
				<div class="news-item-header">
					<span class="news-source ${sourceClass}">${escapeHtml(item.source)}</span>
					<span class="news-time">${escapeHtml(item.time.slice(5, 16))}</span>
				</div>
				<div class="news-title">${escapeHtml(item.title)}</div>
				${item.content ? `<div class="news-content">${escapeHtml(item.content.slice(0, 120))}${item.content.length > 120 ? "..." : ""}</div>` : ""}
			</div>
		`;
	}
	container.innerHTML = html;

	// Wire up click handlers for items with URLs
	container.querySelectorAll(".news-item").forEach((el) => {
		const url = (el as HTMLElement).dataset.url;
		if (url) {
			el.addEventListener("click", () => {
				window.open(url, "_blank", "noopener,noreferrer");
			});
		}
	});
}

async function fetchNewsForStock(code?: string) {
	state.newsLoading = true;
	renderNews();
	try {
		const sources = code
			? "eastmoney_stock,cls_telegraph,eastmoney_global"
			: "cls_telegraph,eastmoney_global";
		const result = await apiClient.getNews(code || "", sources, 15);
		if (result.success) {
			state.newsItems = result.items || [];
		} else {
			state.newsItems = [];
		}
	} catch (e) {
		console.warn("[News] Fetch failed:", e);
		state.newsItems = [];
	} finally {
		state.newsLoading = false;
		renderNews();
	}
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
		.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');
}

/** Turn known stock codes and names inside HTML into clickable <span class="stock-link"> elements.
 *  Operates on text nodes only, skipping <pre>/<code> and already-linkified spans. */
function linkifyStocksInHTML(html: string): string {
	if (!state.allStocksLoaded || state.allStocks.length === 0) return html;

	const codeMap = new Map<string, { code: string; name: string; market: number }>();
	const nameMap = new Map<string, { code: string; name: string; market: number }>();
	for (const s of state.allStocks) {
		codeMap.set(s.code, s);
		nameMap.set(s.name, s);
	}
	const sortedNames = Array.from(nameMap.keys()).sort((a, b) => b.length - a.length);

	const container = document.createElement("div");
	container.innerHTML = html;

	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const parent = node.parentElement;
		if (parent && (parent.tagName === "PRE" || parent.tagName === "CODE" || parent.closest(".stock-link"))) continue;
		nodes.push(node as Text);
	}

	for (const textNode of nodes) {
		const text = textNode.textContent || "";
		let result = "";
		let i = 0;
		while (i < text.length) {
			let matched = false;

			// Try 6-digit stock code (not part of a longer number)
			if (i + 6 <= text.length && /^\d{6}$/.test(text.slice(i, i + 6))) {
				const prev = i > 0 ? text[i - 1] : "";
				const next = i + 6 < text.length ? text[i + 6] : "";
				if (!/\d/.test(prev) && !/\d/.test(next)) {
					const code = text.slice(i, i + 6);
					const stock = codeMap.get(code);
					if (stock) {
						result += `<span class="stock-link" data-code="${stock.code}" data-market="${stock.market}" data-name="${escapeHtml(stock.name)}">${code}</span>`;
						i += 6;
						matched = true;
					}
				}
			}

			// Try longest stock name match
			if (!matched) {
				for (const name of sortedNames) {
					if (text.substr(i, name.length) === name) {
						const stock = nameMap.get(name)!;
						result += `<span class="stock-link" data-code="${stock.code}" data-market="${stock.market}" data-name="${escapeHtml(stock.name)}">${name}</span>`;
						i += name.length;
						matched = true;
						break;
					}
				}
			}

			if (!matched) {
				result += text[i];
				i++;
			}
		}

		if (result !== text) {
			const wrapper = document.createElement("span");
			wrapper.innerHTML = result;
			if (textNode.parentNode) {
				textNode.parentNode.replaceChild(wrapper, textNode);
			}
		}
	}

	return container.innerHTML;
}

function formatMessageContent(text: string): string {
	return linkifyStocksInHTML(formatMarkdown(text));
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
		const recentPool = state.stockPools.find((p) => p.name === "最近访问");
		if (recentPool) {
			state.recentPoolId = recentPool.id;
		}
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

async function selectPool(poolId: number) {
	const pool = state.stockPools.find((p) => p.id === poolId);
	if (!pool) return;
	state.selectedPool = pool;
	state.poolItems = [];
	renderWatchlist();

	try {
		const result = await apiClient.getStockPool(poolId);
		state.poolItems = result.items.map((s: any) => ({ code: s.code, name: s.name, change_pct: s.change_pct, latest: s.latest }));
		renderWatchlist();
	} catch (err) {
		console.error("Failed to fetch pool items:", err);
	}
}

async function selectSymbol(code: string, type: "stock" | "index" = "stock", knownName?: string) {
	// Keep previous chart DOM until new data arrives — avoid blank-panel flash.
	// Only show loading indicator in the chart containers.
	state.selectedSymbol = code;
	state.selectedType = type;
	state.selectedName = knownName || null;
	state.selectedQuote = null;
	state.selectedKlines = [];
	state.selectedIntraday = [];
	state.chartPanelCollapsed = false;

	// Show loading indicator in chart area immediately
	const intradayCtr = document.getElementById("intraday-chart-container");
	if (intradayCtr) intradayCtr.innerHTML = `<div class="chart-loading">加载中...</div>`;
	const klineCtr = document.getElementById("kline-chart-container");
	if (klineCtr) klineCtr.innerHTML = `<div class="chart-loading">加载中...</div>`;

	renderWatchlist();
	renderIndices();

	// Fetch quote + klines first, render panel as soon as they arrive.
	// Intraday (1m) is fetched separately to avoid blocking the panel
	// on a slow Python subprocess + Sina API round-trip.
	const [quoteResult, klinesResult] = await Promise.allSettled([
		apiClient.getQuote(code),
		state.selectedType === "index"
			? apiClient.getIndustryKlines(code, { period: state.selectedPeriod, limit: 10000 })
			: apiClient.getKlines(code, { period: state.selectedPeriod, limit: 10000 }),
	]);

	// Fetch news in background (fire-and-forget)
	if (type === "stock") {
		fetchNewsForStock(code);
	}

	if (quoteResult.status === "fulfilled") {
		state.selectedQuote = quoteResult.value;
		state.selectedName = state.selectedName || quoteResult.value?.name || null;
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

	// Render panel immediately with quote + klines; intraday loads async below
	renderStockChartPanel();

	// Add to recent pool (fire-and-forget)
	if (type === "stock") {
		const name = knownName || (quoteResult.status === "fulfilled" ? quoteResult.value?.name : null);
		if (name) {
			const market = code.startsWith("6") ? 1 : 0;
			addToRecentPool(code, name, market).catch((err) => console.error("[RecentPool] add failed:", err));
		}
	}

	// Fetch intraday in background — does not block the main panel
	loadIntradayData(code);

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
	if (ev.type === "mode_change") {
		state.marketPhase = ev.mode;
	}
	if (ev.type === "navigate" && ev.url) {
		if (ev.newTab) {
			window.open(ev.url, "_blank");
		} else {
			window.location.href = ev.url;
		}
	}
}

// ─── Event wiring ───────────────────────────────────────────

function setupWebSocket() {
	apiClient.addEventListener("connected", () => {
		state.connected = true;
		apiClient.getState();
	});

	apiClient.addEventListener("disconnected", () => {
		state.connected = false;
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
	});

	apiClient.connect();
}

function setupInput() {
	const input = $("message-input") as HTMLInputElement;
	const sendBtn = $("send-btn");
	const attachBtn = $("attach-btn");
	const fileInput = $("file-input") as HTMLInputElement;
	const attachmentPreview = $("attachment-preview");

	const updateAttachmentPreview = () => {
		if (state.attachedFiles.length === 0) {
			attachmentPreview.innerHTML = "";
			attachmentPreview.classList.add("hidden");
			return;
		}
		attachmentPreview.classList.remove("hidden");
		attachmentPreview.innerHTML = state.attachedFiles.map((f, i) => {
			const icon = f.mimeType.startsWith("image/") ? "🖼️" : "📄";
			return `<span class="attachment-chip">${icon} ${escapeHtml(f.name)}<button class="attachment-remove" data-index="${i}" title="移除">×</button></span>`;
		}).join("");

		// Wire up remove buttons
		attachmentPreview.querySelectorAll(".attachment-remove").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const idx = Number((btn as HTMLElement).dataset.index);
				state.attachedFiles.splice(idx, 1);
				updateAttachmentPreview();
			});
		});
	};

	attachBtn.addEventListener("click", () => {
		fileInput.click();
	});

	fileInput.addEventListener("change", async () => {
		const files = fileInput.files;
		if (!files) return;

		for (const file of Array.from(files)) {
			try {
				let content: string;
				if (file.type.startsWith("image/")) {
					content = await readFileAsDataURL(file);
				} else {
					content = await readFileAsText(file);
				}
				state.attachedFiles.push({
					name: file.name,
					content,
					mimeType: file.type || "application/octet-stream",
				});
			} catch (err) {
				console.error("[File] Failed to read:", file.name, err);
			}
		}
		updateAttachmentPreview();
		fileInput.value = "";
	});

	const send = () => {
		const text = input.value.trim();
		if ((!text && state.attachedFiles.length === 0) || state.isStreaming) return;

		const attachments = state.attachedFiles.slice();
		state.messages.push({ role: "user", content: text || "(file)", attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })) } as any);
		renderMessages();
		apiClient.prompt(text, attachments);
		input.value = "";
		state.attachedFiles = [];
		updateAttachmentPreview();
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
	const calendarToggle = document.getElementById("calendar-toggle");
	if (calendarToggle) {
		calendarToggle.addEventListener("click", () => {
			state.calendarCollapsed = !state.calendarCollapsed;
			const chevron = calendarToggle.querySelector(".collapsible-chevron");
			const content = document.getElementById("calendar-content");
			const wrapper = document.getElementById("calendar-panel-wrapper");
			if (chevron) chevron.classList.toggle("collapsed", state.calendarCollapsed);
			if (content) content.classList.toggle("collapsed", state.calendarCollapsed);
			if (wrapper) wrapper.classList.toggle("collapsed", state.calendarCollapsed);
		});
	}

	const newsToggle = document.getElementById("news-toggle");
	if (newsToggle) {
		newsToggle.addEventListener("click", () => {
			state.newsCollapsed = !state.newsCollapsed;
			const chevron = newsToggle.querySelector(".collapsible-chevron");
			const content = document.getElementById("news-content");
			if (chevron) chevron.classList.toggle("collapsed", state.newsCollapsed);
			if (content) content.classList.toggle("collapsed", state.newsCollapsed);
		});
	}

	// Tool log toggle
	const toolLogToggle = document.getElementById("tool-log-toggle");
	const toolLogPanel = document.getElementById("tool-log-panel");
	if (toolLogToggle && toolLogPanel) {
		toolLogToggle.addEventListener("click", () => {
			state.toolLogCollapsed = !state.toolLogCollapsed;
			toolLogPanel.classList.toggle("collapsed", state.toolLogCollapsed);
			toolLogToggle.title = state.toolLogCollapsed ? "展开" : "收起";
		});
	}

	// Settings button
	const settingsBtn = document.getElementById("settings-btn");
	if (settingsBtn) {
		settingsBtn.addEventListener("click", () => {
			openSettingsModal();
		});
	}
}

// ─── Settings Modal ─────────────────────────────────────────

interface ModelConfigData {
	providers: Array<{
		id: string;
		models: Array<{
			id: string;
			name: string;
			provider: string;
			api: string;
			baseUrl?: string;
			reasoning?: boolean;
			contextWindow?: number;
			maxTokens?: number;
		}>;
	}>;
	available: string[];
	currentModel?: { provider: string; modelId: string };
}

let modelConfigData: ModelConfigData | null = null;

async function openSettingsModal() {
	const modal = document.getElementById("settings-modal");
	if (!modal) return;

	// Load model config if not already loaded
	if (!modelConfigData) {
		try {
			modelConfigData = await apiClient.getModelConfig();
		} catch (err) {
			console.error("[Settings] Failed to load model config:", err);
		}
	}

	const current = modelConfigData?.currentModel;
	populateProviderSelect(current?.provider, current?.modelId);
	modal.classList.remove("hidden");
}

function closeSettingsModal() {
	const modal = document.getElementById("settings-modal");
	if (modal) modal.classList.add("hidden");
}

function populateProviderSelect(currentProvider?: string, currentModelId?: string) {
	const providerSelect = document.getElementById("settings-provider") as HTMLSelectElement;
	const modelSelect = document.getElementById("settings-model") as HTMLSelectElement;
	if (!providerSelect || !modelSelect || !modelConfigData) return;

	providerSelect.innerHTML = '<option value="">选择提供商</option>' +
		modelConfigData.providers.map((p) => `<option value="${p.id}" ${p.id === currentProvider ? 'selected' : ''}>${p.id}</option>`).join("");

	if (currentProvider) {
		const provider = modelConfigData.providers.find((p) => p.id === currentProvider);
		if (provider) {
			modelSelect.innerHTML = '<option value="">选择模型</option>' +
				provider.models.map((m) => `<option value="${m.id}" ${m.id === currentModelId ? 'selected' : ''}>${m.name || m.id}</option>`).join("");
		} else {
			modelSelect.innerHTML = '<option value="">先选择提供商</option>';
		}
	} else {
		modelSelect.innerHTML = '<option value="">先选择提供商</option>';
	}
}

function handleProviderChange() {
	const providerSelect = document.getElementById("settings-provider") as HTMLSelectElement;
	const modelSelect = document.getElementById("settings-model") as HTMLSelectElement;
	if (!providerSelect || !modelSelect || !modelConfigData) return;

	const provider = modelConfigData.providers.find((p) => p.id === providerSelect.value);
	if (provider) {
		modelSelect.innerHTML = '<option value="">选择模型</option>' +
			provider.models.map((m) => `<option value="${m.id}">${m.name || m.id}</option>`).join("");
	} else {
		modelSelect.innerHTML = '<option value="">先选择提供商</option>';
	}
}

function setupSettingsModal() {
	const modal = document.getElementById("settings-modal");
	const closeBtn = document.getElementById("settings-close");
	const cancelBtn = document.getElementById("settings-cancel");
	const saveBtn = document.getElementById("settings-save");
	const providerSelect = document.getElementById("settings-provider") as HTMLSelectElement;

	if (closeBtn) closeBtn.addEventListener("click", closeSettingsModal);
	if (cancelBtn) cancelBtn.addEventListener("click", closeSettingsModal);
	if (modal) {
		modal.addEventListener("click", (e) => {
			if (e.target === modal) closeSettingsModal();
		});
	}
	if (providerSelect) {
		providerSelect.addEventListener("change", handleProviderChange);
	}

	if (saveBtn) {
		saveBtn.addEventListener("click", async () => {
			const providerSelect = document.getElementById("settings-provider") as HTMLSelectElement;
			const modelSelect = document.getElementById("settings-model") as HTMLSelectElement;
			const apiKeyInput = document.getElementById("settings-api-key") as HTMLInputElement;
			const baseUrlInput = document.getElementById("settings-base-url") as HTMLInputElement;

			const provider = providerSelect.value;
			const modelId = modelSelect.value;
			if (!provider || !modelId) {
				alert("请选择提供商和模型");
				return;
			}

			try {
				await apiClient.updateModelConfig({
					provider,
					modelId,
					apiKey: apiKeyInput.value || undefined,
					baseUrl: baseUrlInput.value || undefined,
				});
				closeSettingsModal();
				// Reload page to apply new model config
				window.location.reload();
			} catch (err) {
				console.error("[Settings] Failed to save:", err);
				alert("保存失败: " + (err instanceof Error ? err.message : String(err)));
			}
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

// ─── Search ─────────────────────────────────────────────────

let searchDebounceTimer: number | null = null;

async function loadAllStocks() {
	try {
		const stocks = await apiClient.getAllStocks();
		state.allStocks = stocks.map((s: any) => ({ code: s.code, name: s.name, market: s.market }));
		state.allStocksLoaded = true;
		console.log(`[Search] Loaded ${state.allStocks.length} stocks`);
	} catch (err) {
		console.error("Failed to load all stocks:", err);
	}
}

function matchesSearch(stock: { code: string; name: string }, query: string): boolean {
	const q = query.toLowerCase().trim();
	if (!q) return false;
	if (stock.code.includes(q)) return true;
	if (stock.name.toLowerCase().includes(q)) return true;
	try {
		const py = pinyin(stock.name, { toneType: "none", type: "string" }).toLowerCase().replace(/\s/g, "");
		if (py.includes(q)) return true;
		const pyFirst = pinyin(stock.name, { toneType: "none", pattern: "first", type: "string" }).toLowerCase().replace(/\s/g, "");
		if (pyFirst.includes(q)) return true;
	} catch {
		// pinyin-pro may fail on some characters
	}
	return false;
}

function performSearch(query: string) {
	if (!query.trim() || !state.allStocksLoaded) {
		state.searchResults = [];
		state.searchHighlightedIndex = -1;
		state.searchDropdownOpen = false;
		renderSearchDropdown();
		return;
	}
	const q = query.trim().toLowerCase();
	const filtered = state.allStocks
		.filter((s) => matchesSearch(s, q))
		.slice(0, 10);
	state.searchResults = filtered;
	state.searchHighlightedIndex = filtered.length > 0 ? 0 : -1;
	state.searchDropdownOpen = filtered.length > 0;
	renderSearchDropdown();
}

function renderSearchDropdown() {
	const dropdown = $("search-dropdown");
	if (!dropdown) return;
	if (!state.searchDropdownOpen || state.searchResults.length === 0) {
		dropdown.classList.add("hidden");
		dropdown.innerHTML = "";
		return;
	}
	dropdown.classList.remove("hidden");
	dropdown.innerHTML = state.searchResults
		.map((stock, idx) => {
			const isHighlighted = idx === state.searchHighlightedIndex;
			return `<div class="search-dropdown-item ${isHighlighted ? "highlighted" : ""}" data-index="${idx}" data-code="${stock.code}" data-name="${escapeHtml(stock.name)}" data-market="${stock.market}">
				<span class="search-item-code">${escapeHtml(stock.code)}</span>
				<span class="search-item-name">${escapeHtml(stock.name)}</span>
			</div>`;
		})
		.join("");

	// Click handlers
	dropdown.querySelectorAll(".search-dropdown-item").forEach((el) => {
		el.addEventListener("click", () => {
			const code = (el as HTMLElement).dataset.code!;
			const name = (el as HTMLElement).dataset.name!;
			const market = Number((el as HTMLElement).dataset.market!);
			selectSearchResult(code, name, market);
		});
	});
}

async function selectSearchResult(code: string, name: string, market: number) {
	// Close dropdown and clear input
	state.searchDropdownOpen = false;
	state.searchResults = [];
	state.searchHighlightedIndex = -1;
	renderSearchDropdown();
	const input = $("stock-search-input") as HTMLInputElement;
	if (input) input.value = "";

	// Select the stock (shows chart) - pass knownName so recent pool works even if quote fails
	selectSymbol(code, "stock", name);
}

async function addToRecentPool(code: string, name: string, market: number) {
	// Ensure we have the recent pool ID (create if missing)
	if (!state.recentPoolId) {
		let recentPool = state.stockPools.find((p) => p.name === "最近访问");
		if (!recentPool) {
			// Try fetching pools fresh
			try {
				const pools = await apiClient.getStockPools();
				state.stockPools = pools;
				recentPool = pools.find((p: any) => p.name === "最近访问");
			} catch {
				return;
			}
		}
		if (!recentPool) {
			// Create the pool
			try {
				const created = await apiClient.createStockPool("最近访问", "自动记录最近查看的股票");
				recentPool = { id: created.id, name: created.name, description: created.description, item_count: 0, created_at: new Date().toISOString() };
				state.stockPools.unshift(recentPool);
				renderWatchlist();
			} catch (err) {
				console.error("[RecentPool] Failed to create pool:", err);
				return;
			}
		}
		state.recentPoolId = recentPool!.id;
	}
	try {
		// Remove existing entry first so re-adding bumps it to the front (newest added_at)
		try {
			await apiClient.removeFromStockPool(state.recentPoolId, [{ code, market }]);
		} catch {
			// Ignore errors if item didn't exist
		}
		await apiClient.addToStockPool(state.recentPoolId, [{ code, market, name }]);
		console.log(`[RecentPool] Added ${code} ${name}`);
		// Refresh pool list to get accurate item_count
		try {
			state.stockPools = await apiClient.getStockPools();
			renderWatchlist();
		} catch {
			// ignore
		}
		// Refresh pool items if the recent pool is currently selected
		if (state.selectedPool?.id === state.recentPoolId) {
			const result = await apiClient.getStockPool(state.recentPoolId);
			state.poolItems = result.items.map((s: any) => ({ code: s.code, name: s.name, change_pct: s.change_pct, latest: s.latest }));
			renderWatchlist();
		}
	} catch (err) {
		console.error("Failed to add to recent pool:", err);
	}
}

function setupSearch() {
	const input = $("stock-search-input") as HTMLInputElement;
	const dropdown = $("search-dropdown");
	if (!input || !dropdown) return;

	input.addEventListener("input", () => {
		const query = input.value;
		state.searchQuery = query;
		if (searchDebounceTimer) {
			clearTimeout(searchDebounceTimer);
		}
		searchDebounceTimer = window.setTimeout(() => {
			performSearch(query);
		}, 200);
	});

	input.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown") {
			if (!state.searchDropdownOpen || state.searchResults.length === 0) return;
			e.preventDefault();
			state.searchHighlightedIndex = (state.searchHighlightedIndex + 1) % state.searchResults.length;
			renderSearchDropdown();
		} else if (e.key === "ArrowUp") {
			if (!state.searchDropdownOpen || state.searchResults.length === 0) return;
			e.preventDefault();
			state.searchHighlightedIndex = (state.searchHighlightedIndex - 1 + state.searchResults.length) % state.searchResults.length;
			renderSearchDropdown();
		} else if (e.key === "Enter") {
			e.preventDefault();
			const query = input.value.trim();
			if (!query) return;
			// If dropdown is open with a highlighted result, select it
			if (state.searchDropdownOpen && state.searchResults.length > 0 && state.searchHighlightedIndex >= 0) {
				const selected = state.searchResults[state.searchHighlightedIndex];
				if (selected) {
					selectSearchResult(selected.code, selected.name, selected.market);
					return;
				}
			}
			// Search cache and select first match, or fallback to iwencai
			if (state.allStocksLoaded) {
				const matches = state.allStocks.filter((s) => matchesSearch(s, query));
				if (matches.length > 0) {
					selectSearchResult(matches[0].code, matches[0].name, matches[0].market);
				} else {
					// Fallback: ask iwencai to find the stock
					lookupStockViaIwencai(query);
				}
			} else {
				// Cache not loaded yet, try iwencai directly
				lookupStockViaIwencai(query);
			}
		} else if (e.key === "Escape") {
			state.searchDropdownOpen = false;
			renderSearchDropdown();
		}
	});

	// Close dropdown when clicking outside
	document.addEventListener("click", (e) => {
		if (!input.contains(e.target as Node) && !dropdown.contains(e.target as Node)) {
			state.searchDropdownOpen = false;
			renderSearchDropdown();
		}
	});

	// Focus input opens dropdown if there are results
	input.addEventListener("focus", () => {
		if (state.searchResults.length > 0) {
			state.searchDropdownOpen = true;
			renderSearchDropdown();
		}
	});
}

/** Fallback: query iwencai to find stock by natural language */
async function lookupStockViaIwencai(query: string) {
	try {
		console.log(`[Search] Falling back to iwencai for: ${query}`);
		const result = await apiClient.lookupStock(query);
		if (result.success && result.results && result.results.length > 0) {
			const stock = result.results[0];
			selectSearchResult(stock.code, stock.name, stock.market);
		} else {
			console.warn("[Search] iwencai found no results for:", query);
		}
	} catch (err) {
		console.error("[Search] iwencai lookup failed:", err);
	}
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

				<!-- Search bar -->
			<div class="search-bar">
				<span class="search-bar-label">RESEARCH</span>
				<a href="/public/backtest.html" target="_blank" class="backtest-nav-link" title="回测策略">📊 回测</a>
				<div class="search-input-wrapper">
					<input type="text" id="stock-search-input" placeholder="搜索股票 (代码/名称/拼音)" autocomplete="off" />
					<div id="search-dropdown" class="search-dropdown hidden"></div>
				</div>
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
					<div id="watchlist-panel" class="sidebar-content">
						<div id="pool-list" class="pool-list"></div>
						<div id="pool-items" class="pool-items"></div>
					</div>
				</div>

				<!-- Center: Chat area -->
				<div class="chat-area">
					<div class="chat-main">
						<!-- Stock Chart Panel -->
						<div id="stock-chart-panel" class="stock-chart-panel hidden"></div>
						<div class="chat-output-wrapper">
							<div id="message-list" class="message-list"></div>
								<div id="tool-log-panel" class="tool-log-panel">
									<div class="tool-log-panel-header">
										<span>工具调用</span>
										<button id="tool-log-toggle" class="tool-log-toggle-btn" title="收起">
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<polyline points="15 18 9 12 15 6"></polyline>
											</svg>
										</button>
									</div>
									<div id="tool-log-list" class="tool-log-list"></div>
								</div>
							</div>
						<div class="chat-input-area">
							<div id="attachment-preview" class="attachment-preview hidden"></div>
							<div class="chat-input-wrapper">
								<button id="settings-btn" class="chat-settings-btn" aria-label="设置" title="模型配置">
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<circle cx="12" cy="12" r="3"></circle>
										<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
									</svg>
								</button>
								<button id="attach-btn" class="chat-attach-btn" aria-label="附件" title="上传文件">
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
									</svg>
								</button>
								<input type="file" id="file-input" style="position:absolute;opacity:0;width:0;height:0;" multiple accept=".txt,.csv,.json,.md,.py,.ts,.js,.html,.css,.xml,.yaml,.yml,image/*" />
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
				</div>

				<!-- Settings Modal -->
				<div id="settings-modal" class="modal-overlay hidden">
					<div class="modal-content">
						<div class="modal-header">
							<h3>模型配置</h3>
							<button id="settings-close" class="modal-close" title="关闭">&times;</button>
						</div>
						<div class="modal-body">
							<div class="form-group">
								<label for="settings-provider">提供商</label>
								<select id="settings-provider" class="form-select">
									<option value="">加载中...</option>
								</select>
							</div>
							<div class="form-group">
								<label for="settings-model">模型</label>
								<select id="settings-model" class="form-select">
									<option value="">先选择提供商</option>
								</select>
							</div>
							<div class="form-group">
								<label for="settings-api-key">API Key</label>
								<input type="password" id="settings-api-key" class="form-input" placeholder="输入 API Key (可选)" />
							</div>
							<div class="form-group">
								<label for="settings-base-url">Base URL</label>
								<input type="text" id="settings-base-url" class="form-input" placeholder="输入 Base URL (可选)" />
							</div>
							<div class="form-actions">
								<button id="settings-save" class="btn-primary">保存</button>
								<button id="settings-cancel" class="btn-secondary">取消</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Right sidebar: Hot Stocks + Calendar -->
				<div id="right-sidebar" class="calendar-sidebar">
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

					<!-- News Panel -->
					<div class="collapsible-panel" id="news-panel-wrapper">
						<div class="collapsible-header" id="news-toggle">
							<span class="collapsible-title">📰 财经新闻</span>
							<svg class="collapsible-chevron ${state.newsCollapsed ? 'collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="18 15 12 9 6 15"></polyline>
							</svg>
						</div>
						<div class="collapsible-content ${state.newsCollapsed ? 'collapsed' : ''}" id="news-content">
							<div id="news-panel" class="news-panel"></div>
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

function setupMessageLinks() {
	const messageList = $("message-list");
	messageList.addEventListener("click", (e) => {
		const target = (e.target as HTMLElement).closest(".stock-link") as HTMLElement | null;
		if (!target) return;
		const code = target.dataset.code;
		const market = target.dataset.market ? Number(target.dataset.market) : NaN;
		const name = target.dataset.name;
		if (code && !Number.isNaN(market)) {
			e.preventDefault();
			e.stopPropagation();
			selectSymbol(code, "stock", name);
		}
	});
}

function init() {
	renderApp();
	setupWebSocket();
	setupInput();
	setupSettingsModal();
	setupMobileDrawers();
	setupSearch();
	setupMessageLinks();
	fetchIndices();
	fetchStockPools();
	loadAllStocks();
	fetchCalendarForMonth();
	fetchNewsForStock(); // Load market-wide news on init

	// Refresh indices every 60s
	setInterval(fetchIndices, 60_000);
}

init();
