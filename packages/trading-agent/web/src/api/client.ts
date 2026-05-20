const WS_URL = import.meta.env.DEV ? `ws://${window.location.host}/ws` : `ws://${window.location.host}/ws`;
const API_BASE = import.meta.env.DEV ? "" : "";

export class TradingApiClient extends EventTarget {
	private ws: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	private _connected = false;

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
				this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
			} catch {
				console.warn("[WS] Invalid message:", event.data);
			}
		};

		this.ws.onclose = () => {
			console.log("[WS] Disconnected");
			this._connected = false;
			this.ws = null;
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

	prompt(message: string) {
		this.send({ type: "prompt", message });
	}

	getState() {
		this.send({ type: "get_state" });
	}

	abort() {
		this.send({ type: "abort" });
	}

	private send(data: unknown) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		} else {
			console.warn("[WS] Not connected, message dropped");
		}
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

	async getStockPools() {
		return this.httpGet("/api/stock-pools");
	}

	async getStockPool(poolId: number) {
		return this.httpGet(`/api/stock-pools/${poolId}`);
	}

	async deleteStockPool(poolId: number) {
		return this.httpDelete(`/api/stock-pools/${poolId}`);
	}

	async addToStockPool(poolId: number, items: Array<{ code: string; market: number; name?: string }>) {
		return this.httpPost(`/api/stock-pools/${poolId}/items`, { items });
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

	private async httpGet(path: string) {
		const res = await fetch(`${API_BASE}${path}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		return res.json();
	}

	private async httpDelete(path: string) {
		const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
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
