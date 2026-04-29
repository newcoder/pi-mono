import type { WebSocket } from "ws";
import type { TradingSession } from "../core/trading-session.js";

interface WsMessage {
	type: string;
	[key: string]: unknown;
}

export function setupWsHandler(ws: WebSocket, session: TradingSession) {
	// Forward agent events to the WebSocket client
	const onAgentEvent = (ev: any) => {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({ type: "agent_event", event: ev }));
		}
	};

	const onTradingEvent = (ev: any) => {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({ type: "trading_event", event: ev }));
		}
	};

	session.on("agent_event", onAgentEvent);
	session.on("trading_event", onTradingEvent);

	ws.on("message", async (data) => {
		let msg: WsMessage;
		try {
			msg = JSON.parse(data.toString("utf-8")) as WsMessage;
		} catch {
			ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
			return;
		}

		try {
			switch (msg.type) {
				case "prompt": {
					const message = String(msg.message || "");
					if (!message) {
						ws.send(JSON.stringify({ type: "error", message: "message is required" }));
						return;
					}
					await session.prompt(message);
					break;
				}
				case "get_state": {
					ws.send(
						JSON.stringify({
							type: "state",
							state: {
								mode: session.currentMode,
								messages: session.messages,
							},
						}),
					);
					break;
				}
				case "abort": {
					// TODO: implement abort in TradingSession
					ws.send(JSON.stringify({ type: "info", message: "Abort not yet implemented" }));
					break;
				}
				default: {
					ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
				}
			}
		} catch (err) {
			console.error("[WS] Error handling message:", err);
			ws.send(
				JSON.stringify({
					type: "error",
					message: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	});

	ws.on("close", () => {
		session.off("agent_event", onAgentEvent);
		session.off("trading_event", onTradingEvent);
	});

	ws.on("error", (err) => {
		console.error("[WS] WebSocket error:", err);
	});

	// Send initial connection ack
	ws.send(JSON.stringify({ type: "connected", message: "Trading agent ready" }));
}
