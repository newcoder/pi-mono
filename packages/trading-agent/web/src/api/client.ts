const WS_URL = import.meta.env.DEV ? `ws://${window.location.host}/ws` : `ws://${window.location.host}/ws`;
const API_BASE = import.meta.env.DEV ? "" : "";

export interface SessionMeta {
	id: string;
	title: string;
	titleSource?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	system?: boolean;
}

export class TradingApiClient extends EventTarget {
	private ws: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	private _connected = false;
	private reqCounter = 0;
	private pendingReqs = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

	get connected() {
		return this._connected;
	}

	connect() {
		if (this.ws) return;

		this.ws = new WebSocket(WS_URL);

		this.ws.onopen = () => {
			console.log("[WS] Connected");
			this._connected = true;
			this.dispatchEvent(new CustomEvent("connected"));
		};

		this.ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);
				const pending = this.pendingReqs.get(msg.reqId);
				if (pending) {
					this.pendingReqs.delete(msg.reqId);
					if (msg.type === "error") pending.reject(new Error(msg.message || "WS error"));
					else pending.resolve(msg);
					return; // reqId 回复不再 dispatch 事件（session_list/state 等由 promise 消费）
				}
				this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
			} catch {
				console.warn("[WS] Invalid message:", event.data);
			}
		};

		this.ws.onclose = () => {
			console.log("[WS] Disconnected");
			this._connected = false;
			this.ws = null;
			for (const { reject } of this.pendingReqs.values()) {
				reject(new Error("WebSocket disconnected"));
			}
			this.pendingReqs.clear();
			this.dispatchEvent(new CustomEvent("disconnected"));
			// Auto reconnect
			this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
		};

		this.ws.onerror = (err) => {
			console.error("[WS] Error:", err);
			this.dispatchEvent(new CustomEvent("error", { detail: err }));
		};
	}

	disconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
	}

	prompt(message: string, attachments?: Array<{ name: string; content: string; mimeType: string }>) {
		const payload: Record<string, unknown> = { type: "prompt", message };
		if (attachments && attachments.length > 0) {
			payload.attachments = attachments;
		}
		this.send(payload);
	}

	getState() {
		this.send({ type: "get_state" });
	}

	abort() {
		this.send({ type: "abort" });
	}

	async listSessions(): Promise<SessionMeta[]> {
		const msg = await this.request<{ sessions: SessionMeta[] }>("session_list");
		return msg.sessions;
	}

	async switchSession(sessionId: string) {
		return this.request<{ session: SessionMeta; messages: unknown[] }>("session_switch", { sessionId });
	}

	async newSession() {
		return this.request<{ session: SessionMeta; messages: unknown[] }>("session_new");
	}

	async deleteSession(sessionId: string) {
		await this.request("session_delete", { sessionId });
	}

	private send(data: unknown) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		} else {
			console.warn("[WS] Not connected, message dropped");
		}
	}

	private request<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
		if (this.ws?.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Not connected"));
		}
		return new Promise((resolve, reject) => {
			const reqId = ++this.reqCounter;
			this.pendingReqs.set(reqId, { resolve, reject });
			this.send({ type, reqId, ...payload });
		});
	}

	// ─── HTTP API helpers ───────────────────────────────────────

	async getIndices() {
		return this.httpGet("/api/indices");
	}

	async getQuote(code: string) {
		return this.httpGet(`/api/quote/${code}`);
	}

	async getStocks(params?: { industry?: string; concept?: string }) {
		const query = params ? new URLSearchParams(params as Record<string, string>).toString() : "";
		return this.httpGet(`/api/stocks${query ? "?" + query : ""}`);
	}

	async getKlines(code: string, options?: { period?: string; adjust?: string; limit?: number }) {
		const query = new URLSearchParams({ code, ...(options as Record<string, string> || {}) }).toString();
		return this.httpGet(`/api/klines?${query}`);
	}

	async getIndustryKlines(code: string, options?: { period?: string; limit?: number }) {
		const params = new URLSearchParams({ code });
		if (options?.period) params.set("period", options.period);
		if (options?.limit != null) params.set("limit", String(options.limit));
		return this.httpGet(`/api/industry/klines?${params.toString()}`);
	}

	async getStockPools() {
		return this.httpGet("/api/stock-pools");
	}

	async getStockPool(poolId: number) {
		return this.httpGet(`/api/stock-pools/${poolId}`);
	}

	async createStockPool(name: string, description?: string) {
		return this.httpPost("/api/stock-pools", { name, description });
	}

	async deleteStockPool(poolId: number) {
		return this.httpDelete(`/api/stock-pools/${poolId}`);
	}

	async addToStockPool(poolId: number, items: Array<{ code: string; market: number; name?: string }>) {
		return this.httpPost(`/api/stock-pools/${poolId}/items`, { items });
	}

	async removeFromStockPool(poolId: number, items: Array<{ code: string; market: number }>) {
		return this.httpDelete(`/api/stock-pools/${poolId}/items`, { items });
	}

	async getAllStocks() {
		return this.httpGet("/api/stocks?all=1");
	}

	async searchStocks(query: string, limit = 10) {
		return this.httpGet(`/api/stocks?search=${encodeURIComponent(query)}&limit=${limit}`);
	}

	async lookupStock(query: string) {
		return this.httpPost("/api/stock-lookup", { query });
	}

	async getSectors() {
		return this.httpGet("/api/sectors");
	}

	async getMacro() {
		return this.httpGet("/api/macro");
	}

	async getHotStocks(date?: string, limit?: number) {
		const query = new URLSearchParams();
		if (date) query.set("date", date);
		if (limit) query.set("limit", String(limit));
		return this.httpGet(`/api/hot-stocks?${query.toString()}`);
	}

	async getNews(code?: string, sources?: string, limit?: number) {
		const query = new URLSearchParams();
		if (code) query.set("code", code);
		if (sources) query.set("sources", sources);
		if (limit) query.set("limit", String(limit));
		return this.httpGet(`/api/news?${query.toString()}`);
	}

	async getCalendar(start: string, end: string, code?: string) {
		const query = new URLSearchParams({ start, end });
		if (code) query.set("code", code);
		return this.httpGet(`/api/calendar?${query.toString()}`);
	}

	async refreshCalendar(code?: string, startDate?: string, endDate?: string) {
		const body: Record<string, string> = {};
		if (code) body.code = code;
		if (startDate) body.since = startDate;
		if (endDate) body.until = endDate;
		return this.httpPost("/api/calendar/refresh", body);
	}

	async getModelConfig() {
		return this.httpGet("/api/model-config");
	}

	async updateModelConfig(config: { provider: string; modelId: string; apiKey?: string; baseUrl?: string }) {
		return this.httpPost("/api/model-config", config);
	}

	private async httpGet(path: string) {
		const res = await fetch(`${API_BASE}${path}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		return res.json();
	}

	private async httpDelete(path: string, body?: unknown) {
		const init: RequestInit = { method: "DELETE" };
		if (body !== undefined) {
			init.headers = { "Content-Type": "application/json" };
			init.body = JSON.stringify(body);
		}
		const res = await fetch(`${API_BASE}${path}`, init);
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		return res.json();
	}

	private async httpPost(path: string, body: unknown) {
		const res = await fetch(`${API_BASE}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		return res.json();
	}
}

export const apiClient = new TradingApiClient();
