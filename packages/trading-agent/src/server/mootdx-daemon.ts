import { type ChildProcess, spawn } from "node:child_process";
import { resolveAStockDataScript } from "../tools/_utils.js";

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class MootdxDaemon {
	private proc: ChildProcess | null = null;
	private pending = new Map<number, PendingRequest>();
	private reqId = 0;
	private buffer = "";
	private starting = false;
	private ready = false;
	private initMs = 0;
	private restartCount = 0;
	private readonly maxRestarts = 3;
	private shutdownFlag = false;

	async start(): Promise<void> {
		if (this.proc || this.starting) return;
		this.starting = true;
		this.shutdownFlag = false;

		const scriptPath = resolveAStockDataScript("mootdx_daemon.py");

		return new Promise((resolve, reject) => {
			const t0 = Date.now();
			this.proc = spawn("python", [scriptPath], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PYTHONIOENCODING: "utf-8" },
			});

			this.proc.stdout!.setEncoding("utf-8");
			this.proc.stderr!.setEncoding("utf-8");

			this.proc.stdout!.on("data", (chunk: string) => this._onData(chunk));
			this.proc.stderr!.on("data", (chunk: string) => {
				const line = chunk.trim();
				if (line) console.warn("[MootdxDaemon] stderr:", line);
			});

			this.proc.on("error", (err) => {
				console.error("[MootdxDaemon] Process error:", err);
				this.starting = false;
				reject(err);
			});

			this.proc.on("close", (code) => {
				console.warn(`[MootdxDaemon] Process exited with code ${code}`);
				this.proc = null;
				this.ready = false;
				this.starting = false;

				// Reject all pending requests
				for (const [_id, req] of this.pending) {
					clearTimeout(req.timer);
					req.reject(new Error(`Daemon exited (code ${code})`));
				}
				this.pending.clear();

				// Auto-restart if not shutting down
				if (!this.shutdownFlag && this.restartCount < this.maxRestarts) {
					this.restartCount++;
					console.log(`[MootdxDaemon] Auto-restarting (attempt ${this.restartCount}/${this.maxRestarts})...`);
					setTimeout(() => this.start().catch((e) => console.error("[MootdxDaemon] Restart failed:", e)), 1000);
				}
			});

			// Wait for ready event
			const checkReady = setInterval(() => {
				if (this.ready) {
					clearInterval(checkReady);
					this.initMs = Date.now() - t0;
					this.restartCount = 0; // Reset on successful start
					console.log(`[MootdxDaemon] Ready (startup ${this.initMs}ms)`);
					resolve();
				}
			}, 50);

			// Startup timeout
			setTimeout(() => {
				if (!this.ready) {
					clearInterval(checkReady);
					this.proc?.kill();
					this.proc = null;
					this.starting = false;
					reject(new Error("Mootdx daemon startup timeout (30s)"));
				}
			}, 30000);
		});
	}

	private _onData(chunk: string) {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || ""; // Keep incomplete line in buffer

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const msg = JSON.parse(trimmed);
				this._handleMessage(msg);
			} catch (_e) {
				console.warn("[MootdxDaemon] Invalid JSON line:", trimmed.slice(0, 200));
			}
		}
	}

	private _handleMessage(msg: any) {
		// Handle startup events
		if (msg.event === "startup") {
			console.log("[MootdxDaemon] Initializing...");
			return;
		}
		if (msg.event === "ready") {
			this.ready = true;
			if (msg.client_init_ms) this.initMs = msg.client_init_ms;
			return;
		}
		if (msg.event === "error") {
			console.error("[MootdxDaemon] Startup error:", msg.error);
			return;
		}
		if (msg.event === "shutdown") {
			console.log("[MootdxDaemon] Shutdown acknowledged");
			return;
		}

		// Handle responses
		const reqId = msg.id;
		if (reqId == null) {
			console.warn("[MootdxDaemon] Message without id:", msg);
			return;
		}

		const pending = this.pending.get(reqId);
		if (!pending) {
			console.warn(`[MootdxDaemon] No pending request for id ${reqId}`);
			return;
		}

		clearTimeout(pending.timer);
		this.pending.delete(reqId);

		if (msg.success) {
			pending.resolve(msg.data);
		} else {
			pending.reject(new Error(msg.error || `Request ${reqId} failed`));
		}
	}

	async request(command: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<any> {
		if (!this.ready || !this.proc) {
			await this.start();
		}

		const id = ++this.reqId;
		const req = { id, command, ...params };

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Mootdx daemon request timeout (${timeoutMs}ms): ${command}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timer });

			const line = `${JSON.stringify(req)}\n`;
			this.proc!.stdin!.write(line, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(new Error(`Failed to write to daemon: ${err.message}`));
				}
			});
		});
	}

	async ping(): Promise<{ pong: boolean; client_init_ms: number }> {
		return this.request("ping", {}, 5000);
	}

	async stop(): Promise<void> {
		this.shutdownFlag = true;
		if (!this.proc) return;

		// Send quit command
		try {
			await this.request("quit", {}, 5000);
		} catch (_e) {
			// Ignore, process might already be dead
		}

		// Force kill after grace period
		setTimeout(() => {
			if (this.proc && !this.proc.killed) {
				this.proc.kill("SIGTERM");
				setTimeout(() => {
					if (this.proc && !this.proc.killed) {
						this.proc.kill("SIGKILL");
					}
				}, 3000);
			}
		}, 2000);
	}
}
