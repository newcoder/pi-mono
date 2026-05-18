import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { apiClient } from "./api/client.js";

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
	selectedStock: null as string | null,
	stockQuote: null as any,
	// Calendar state
	calendarEvents: [] as CalendarEvent[],
	calendarMonth: new Date(),
	calendarSelectedDate: null as string | null,
	calendarLoading: false,
};

// ─── DOM refs ───────────────────────────────────────────────

function $(id: string) {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Element not found: #${id}`);
	return el;
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
			return `<span class="index-quote ${colorClass}">${q.name} ${q.price.toFixed(2)} ${sign}${q.change_pct.toFixed(2)}%</span>`;
		})
		.join('<span class="text-border mx-2">|</span>');
}

function renderSentiment() {
	const container = $("sentiment-bar");
	if (!state.sentiment) {
		container.innerHTML = `<span class="text-muted-foreground">市场情绪: 加载中...</span>`;
		return;
	}
	const s = state.sentiment;
	const barWidth = 20;
	const filled = Math.round((s.sentimentIndex / 100) * barWidth);
	const empty = barWidth - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	const label =
		s.sentimentIndex >= 80
			? "强烈偏多"
			: s.sentimentIndex >= 60
				? "偏多"
				: s.sentimentIndex >= 40
					? "中性"
					: s.sentimentIndex >= 20
						? "偏空"
						: "强烈偏空";
	const nbSign = s.northboundFlow >= 0 ? "+" : "";
	container.innerHTML = `
		<span>情绪 ${s.sentimentIndex}/100 [${bar}] ${label}</span>
		<span class="text-up">涨${s.advance}</span>
		<span class="text-down">跌${s.decline}</span>
		<span>涨停${s.limitUp} 跌停${s.limitDown}</span>
		<span>北向 ${nbSign}${s.northboundFlow}亿</span>
	`;
}

function renderMarketStatus() {
	const container = $("market-status");
	const statusText = container.querySelector("span:first-child");
	if (statusText) statusText.textContent = state.marketPhase;
}

function renderMessages() {
	const container = $("message-list");
	container.innerHTML = state.messages
		.map((msg) => {
			if (msg.role === "user") {
				return `<div class="flex justify-end mb-4"><div class="bg-primary text-primary-foreground px-4 py-2 rounded-lg max-w-3xl">${escapeHtml(msg.content)}</div></div>`;
			}
			if (msg.role === "tool") {
				return `<div class="mb-2 text-xs text-muted-foreground px-4">[Tool] ${escapeHtml(msg.content.slice(0, 120))}${msg.content.length > 120 ? "..." : ""}</div>`;
			}
			if (msg.role === "assistant") {
				return `<div class="mb-4 px-4"><div class="prose dark:prose-invert max-w-3xl">${formatMarkdown(msg.content)}${msg.isStreaming ? '<span class="animate-pulse">▌</span>' : ""}</div></div>`;
			}
			return `<div class="mb-2 text-xs text-yellow-600 px-4">${escapeHtml(msg.content)}</div>`;
		})
		.join("");
	// Auto scroll to bottom
	container.scrollTop = container.scrollHeight;
}

function renderConnectionStatus() {
	const el = $("connection-status");
	if (state.connected) {
		el.textContent = "已连接";
		el.className = "text-xs text-green-500";
	} else {
		el.textContent = "连接中...";
		el.className = "text-xs text-yellow-500";
	}
}

function renderWatchlist() {
	const container = $("watchlist-panel");
	if (state.stockPools.length === 0) {
		container.innerHTML = `<div class="p-4 text-sm text-muted-foreground">暂无股票池</div>`;
		return;
	}

	let html = `<div class="p-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">股票池</div>`;
	html += `<div class="space-y-1 px-2">`;
	for (const pool of state.stockPools) {
		const isSelected = state.selectedPool?.id === pool.id;
		html += `
			<div class="group cursor-pointer rounded px-2 py-1.5 text-sm hover:bg-muted transition-colors ${isSelected ? 'bg-muted font-medium' : ''}"
			     data-pool-id="${pool.id}">
				<div class="flex items-center justify-between">
					<div class="truncate flex-1">${escapeHtml(pool.name)}</div>
					<button class="delete-pool-btn opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-opacity px-1"
					        data-delete-pool-id="${pool.id}" title="删除股票池">×</button>
				</div>
				<div class="text-xs text-muted-foreground">${pool.item_count} 只</div>
			</div>
		`;
	}
	html += `</div>`;

	// Pool items
	if (state.selectedPool && state.poolItems.length > 0) {
		html += `<div class="mt-4 p-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">${escapeHtml(state.selectedPool.name)}</div>`;
		html += `<div class="space-y-0.5 px-2">`;
		for (const item of state.poolItems) {
			const isSelected = state.selectedStock === item.code;
			html += `
				<div class="cursor-pointer rounded px-2 py-1 text-sm hover:bg-muted transition-colors ${isSelected ? 'bg-muted font-medium' : ''}"
				     data-stock-code="${item.code}">
					<span class="text-muted-foreground">${item.code}</span>
					<span class="ml-1">${escapeHtml(item.name)}</span>
				</div>
			`;
		}
		html += `</div>`;
	}

	container.innerHTML = html;

	// Wire up click handlers
	container.querySelectorAll("[data-pool-id]").forEach((el) => {
		el.addEventListener("click", (e) => {
			// Ignore clicks on delete button
			if ((e.target as HTMLElement).closest(".delete-pool-btn")) return;
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
					state.selectedStock = null;
					state.stockQuote = null;
				}
				await fetchStockPools();
				renderStockDetail();
			} catch (err) {
				alert("删除失败: " + (err as Error).message);
			}
		});
	});
	container.querySelectorAll("[data-stock-code]").forEach((el) => {
		el.addEventListener("click", () => {
			const code = (el as HTMLElement).dataset.stockCode!;
			selectStock(code);
		});
	});
}

function renderStockDetail() {
	const container = $("stock-detail");
	if (!state.selectedStock) {
		container.innerHTML = ``;
		container.classList.add("hidden");
		return;
	}
	container.classList.remove("hidden");
	if (!state.stockQuote) {
		container.innerHTML = `
			<div class="p-3 text-sm text-muted-foreground">
				<div class="font-medium">${escapeHtml(state.selectedStock)}</div>
				<div class="text-xs">暂无行情数据</div>
			</div>
		`;
		return;
	}
	const q = state.stockQuote;
	const changeClass = q.change_pct > 0 ? "text-up" : q.change_pct < 0 ? "text-down" : "text-neutral";
	const sign = q.change_pct >= 0 ? "+" : "";
	container.innerHTML = `
		<div class="p-3 border-b border-border">
			<div class="flex items-center justify-between">
				<div>
					<div class="font-medium">${escapeHtml(q.name)}</div>
					<div class="text-xs text-muted-foreground">${q.code}</div>
				</div>
				<div class="text-right">
					<div class="text-lg font-semibold ${changeClass}">${q.price?.toFixed(2) ?? "-"}</div>
					<div class="text-xs ${changeClass}">${sign}${q.change_pct?.toFixed(2) ?? "-"}%</div>
				</div>
			</div>
		</div>
		<div class="p-3 text-xs space-y-1 text-muted-foreground">
			<div class="flex justify-between"><span>市值</span><span>${q.market_cap ? (q.market_cap / 1e8).toFixed(2) + "亿" : "-"}</span></div>
			<div class="flex justify-between"><span>PE</span><span>${q.pe_ttm != null ? q.pe_ttm.toFixed(2) : "-"}</span></div>
			<div class="flex justify-between"><span>PB</span><span>${q.pb != null ? q.pb.toFixed(2) : "-"}</span></div>
			<div class="flex justify-between"><span>股息率</span><span>${q.dividend_yield ? q.dividend_yield.toFixed(2) + "%" : "-"}</span></div>
		</div>
		<div class="p-3 border-t border-border">
			<button id="analyze-stock-btn" class="w-full bg-muted hover:bg-muted/80 text-foreground text-xs py-1.5 rounded transition-colors"
			        data-stock-code="${q.code}" data-stock-name="${escapeHtml(q.name)}"
			>分析此股票</button>
		</div>
	`;

	// Wire up analyze button
	const analyzeBtn = container.querySelector("#analyze-stock-btn") as HTMLButtonElement | null;
	if (analyzeBtn) {
		analyzeBtn.addEventListener("click", () => {
			const code = analyzeBtn.dataset.stockCode;
			const name = analyzeBtn.dataset.stockName;
			if (code) {
				const input = $("message-input") as HTMLInputElement;
				input.value = `请对 ${code} ${name || ""} 进行综合分析，包括技术面、基本面和估值`;
				input.focus();
			}
		});
	}
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
		<div class="flex items-center justify-between mb-2 px-1">
			<button id="cal-prev" class="text-xs px-1.5 py-0.5 rounded hover:bg-muted transition-colors">&lt;</button>
			<span class="text-sm font-medium">${year}年${monthNames[month]}</span>
			<button id="cal-next" class="text-xs px-1.5 py-0.5 rounded hover:bg-muted transition-colors">&gt;</button>
		</div>
		<div class="grid grid-cols-7 gap-px mb-1">
			${weekdayLabels.map((d) => `<div class="text-center text-[10px] text-muted-foreground py-0.5">${d}</div>`).join("")}
		</div>
		<div class="grid grid-cols-7 gap-px">
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
		html += `<div class="mt-2 border-t border-border pt-2">`;
		html += `<div class="text-[10px] text-muted-foreground mb-1 px-1 font-medium">本月重点关注</div>`;
		for (const ev of monthEvents) {
			const catLabel = CATEGORY_LABELS[ev.category] || ev.category;
			const catColor = CATEGORY_COLORS[ev.category] || "bg-gray-500";
			const dateLabel = ev.source === "seasonal" ? "预计" : ev.event_date.slice(5);
			html += `
				<div class="calendar-event-item px-1 py-0.5 rounded hover:bg-muted cursor-pointer transition-colors"
				     data-event-id="${ev.id || ""}" data-event-title="${escapeHtml(ev.title)}" data-event-date="${ev.event_date}"
				     data-event-category="${ev.category}">
					<div class="flex items-center gap-1">
						<span class="calendar-dot ${catColor}"></span>
						<span class="text-[10px] text-muted-foreground min-w-[2.5rem]">${dateLabel}</span>
						<span class="text-[11px] font-medium truncate flex-1">${escapeHtml(ev.title)}</span>
					</div>
					${ev.description ? `<div class="text-[10px] text-muted-foreground truncate pl-3">${escapeHtml(ev.description)}</div>` : ""}
				</div>
			`;
		}
		html += `</div>`;
	}

	// Loading indicator
	if (state.calendarLoading) {
		html += `<div class="mt-2 text-center text-[10px] text-muted-foreground">刷新中...</div>`;
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
					`.calendar-event-item[data-event-date="${state.calendarSelectedDate}"]`,
				);
				if (targetEvent) {
					targetEvent.classList.add("highlight");
					targetEvent.scrollIntoView({ behavior: "smooth", block: "nearest" });
					setTimeout(() => targetEvent.classList.remove("highlight"), 1500);
				}
			}
		});
	});

	container.querySelectorAll(".calendar-event-item").forEach((el) => {
		el.addEventListener("click", () => {
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
		.replace(/```([\s\S]*?)```/g, '<pre class="bg-muted p-2 rounded overflow-x-auto text-sm my-2"><code>$1</code></pre>')
		.replace(/`([^`]+)`/g, '<code class="bg-muted px-1 rounded text-sm">$1</code>')
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

async function selectStock(code: string) {
	state.selectedStock = code;
	state.stockQuote = null;
	renderWatchlist();
	renderStockDetail();

	try {
		const quote = await apiClient.getQuote(code);
		state.stockQuote = quote;
		renderStockDetail();
	} catch (err) {
		console.error("Failed to fetch quote:", err);
	}
}

function handleAgentEvent(ev: any) {
	switch (ev.type) {
		case "message_start": {
			if (ev.message?.role === "assistant") {
				state.messages.push({ role: "assistant", content: "", isStreaming: true });
				state.isStreaming = true;
			}
			break;
		}
		case "message_update": {
			if (ev.assistantMessageEvent?.type === "text_delta") {
				const lastMsg = state.messages[state.messages.length - 1];
				if (lastMsg?.role === "assistant") {
					lastMsg.content += ev.assistantMessageEvent.delta;
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
			break;
		}
		case "tool_execution_start": {
			state.messages.push({ role: "tool", content: `[${ev.toolName}]` });
			break;
		}
		case "tool_execution_end": {
			const resultText = ev.result?.content?.find((c: any) => c.type === "text")?.text || "";
			state.messages.push({ role: "tool", content: resultText.slice(0, 200) });
			// Auto-refresh stock pools when a new pool is created
			if (ev.toolName === "manage_stock_pool" && resultText.includes("创建成功")) {
				fetchStockPools();
			}
			break;
		}
		case "agent_end": {
			state.isStreaming = false;
			break;
		}
	}
	renderMessages();
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
		calRefreshBtn.addEventListener("click", () => {
			refreshCalendar();
		});
	}
}

// ─── App HTML ───────────────────────────────────────────────

function renderApp() {
	const app = $("app");
	app.innerHTML = `
		<div class="flex flex-col h-screen bg-background text-foreground">
			<!-- Top bar: Index quotes -->
			<div id="index-bar" class="trading-panel">
				<span class="text-muted-foreground">加载中...</span>
			</div>

			<!-- Sentiment bar -->
			<div id="sentiment-bar" class="sentiment-bar">
				<span class="text-muted-foreground">市场情绪: 加载中...</span>
			</div>

			<!-- Market status -->
			<div id="market-status" class="market-status">
				<span>休市</span>
				<span id="connection-status" class="ml-auto">连接中...</span>
			</div>

			<!-- Main content: sidebar + chat -->
			<div class="flex flex-1 overflow-hidden">
				<!-- Left sidebar: Watchlist -->
				<div class="w-56 border-r border-border flex flex-col">
					<div id="watchlist-panel" class="flex-1 overflow-y-auto py-2"></div>
					<!-- Stock detail popup -->
					<div id="stock-detail" class="hidden border-t border-border"></div>
				</div>

				<!-- Center: Chat area -->
				<div class="flex-1 flex flex-col min-w-0">
					<div id="message-list" class="flex-1 overflow-y-auto py-4"></div>
					<div class="border-t border-border p-4">
						<div class="flex gap-2 max-w-3xl mx-auto">
							<input
								id="message-input"
								type="text"
								placeholder="输入消息..."
								class="flex-1 bg-muted border border-border rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
							/>
							<button
								id="send-btn"
								class="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm hover:bg-primary/90 transition-colors"
							>
								发送
							</button>
						</div>
					</div>
				</div>

				<!-- Right sidebar: Calendar -->
				<div class="w-64 border-l border-border flex flex-col bg-card">
					<div class="flex items-center justify-between px-3 py-2 border-b border-border">
						<span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">投资日历</span>
						<button id="calendar-refresh-btn" class="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted transition-colors text-muted-foreground"
						        title="刷新日历数据"
						>
							刷新
						</button>
					</div>
					<div id="calendar-panel" class="flex-1 overflow-y-auto p-2"></div>
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
	fetchIndices();
	fetchStockPools();
	fetchCalendarForMonth();

	// Refresh indices every 60s
	setInterval(fetchIndices, 60_000);
}

init();
