import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { TradingSession } from "../core/trading-session.js";
import type { BackgroundSyncService } from "./background-sync.js";
import { handleRequest } from "./router.js";
import { setupWsHandler } from "./ws-handler.js";

const STATIC_EXTENSIONS: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
};

function getContentType(path: string): string {
	const ext = path.slice(path.lastIndexOf("."));
	return STATIC_EXTENSIONS[ext] || "application/octet-stream";
}

function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): boolean {
	const url = req.url || "/";
	const resolvedStaticDir = resolve(staticDir);
	let filePath = resolve(join(staticDir, url === "/" ? "index.html" : url));

	// Security: prevent directory traversal
	if (!filePath.startsWith(resolvedStaticDir)) {
		return false;
	}

	if (!existsSync(filePath) || !statSync(filePath).isFile()) {
		// Try index.html for SPA routes
		const indexPath = resolve(join(staticDir, "index.html"));
		if (existsSync(indexPath) && statSync(indexPath).isFile()) {
			filePath = indexPath;
		} else {
			return false;
		}
	}

	const content = readFileSync(filePath);
	res.writeHead(200, { "Content-Type": getContentType(filePath) });
	res.end(content);
	return true;
}

export interface ServerOptions {
	port?: number;
	staticDir?: string;
	bgSync?: BackgroundSyncService;
}

export function startServer(
	session: TradingSession,
	options: ServerOptions = {},
): { httpServer: ReturnType<typeof createServer>; wsServer: WebSocketServer } {
	const port = options.port || 3000;
	const staticDir = options.staticDir ? resolve(options.staticDir) : undefined;

	const httpServer = createServer((req, res) => {
		// Try static files first (if configured), then API routes
		if (staticDir && req.method === "GET" && !req.url?.startsWith("/api/")) {
			const served = serveStatic(req, res, staticDir);
			if (served) return;
		}

		handleRequest(req, res, options.bgSync);
	});

	const wsServer = new WebSocketServer({ server: httpServer });

	wsServer.on("connection", (ws) => {
		console.log("[WS] Client connected");
		setupWsHandler(ws, session);
	});

	wsServer.on("error", (err) => {
		console.error("[WS] Server error:", err);
	});

	httpServer.listen(port, () => {
		console.log(`[Server] HTTP + WebSocket listening on http://localhost:${port}`);
	});

	return { httpServer, wsServer };
}
