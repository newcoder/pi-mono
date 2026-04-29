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

	async getSectors() {
		return this.httpGet("/api/sectors");
	}

	async getMacro() {
		return this.httpGet("/api/macro");
	}

	private async httpGet(path: string) {
		const res = await fetch(`${API_BASE}${path}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		return res.json();
	}
}

export const apiClient = new TradingApiClient();
