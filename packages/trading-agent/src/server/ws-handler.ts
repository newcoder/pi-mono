import type { WebSocket } from "ws";
import type { SessionMeta } from "../core/session-manager.js";

export interface SessionLike {
	on(event: string, cb: (...args: any[]) => void): unknown;
	off(event: string, cb: (...args: any[]) => void): unknown;
	prompt(input: string, opts?: { systemPromptSuffix?: string; attachments?: unknown[] }): Promise<void>;
	messages: unknown[];
	currentMode?: string;
	dispose?(): void;
}

export interface SessionManagerLike {
	list(): Promise<SessionMeta[]>;
	get(id: string): Promise<SessionLike | undefined>;
	create(id?: string, system?: boolean): Promise<{ session: SessionLike; meta: SessionMeta }>;
	delete(id: string): Promise<void>;
	flush(id?: string): Promise<void>;
	getMeta(id: string): SessionMeta | undefined;
	on(event: string, cb: (...args: any[]) => void): unknown;
	off(event: string, cb: (...args: any[]) => void): unknown;
}

export function setupWsHandler(
	ws: WebSocket,
	ctx: { sessionManager: SessionManagerLike; defaultSession: SessionLike },
) {
	const { sessionManager, defaultSession } = ctx;
	let bound: SessionLike = defaultSession;

	const send = (payload: Record<string, unknown>) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
	};

	// ---- bound session 事件 ----
	let boundAgentHandler: ((ev: any) => void) | null = null;
	let boundTradingHandler: ((ev: any) => void) | null = null;
	const onAgent = (ev: any) => send({ type: "agent_event", event: ev });
	const onTrading = (ev: any) => send({ type: "trading_event", event: ev });

	function bind(next: SessionLike): void {
		if (boundAgentHandler) bound.off("agent_event", boundAgentHandler);
		if (boundTradingHandler) bound.off("trading_event", boundTradingHandler);
		bound = next;
		boundAgentHandler = onAgent;
		bound.on("agent_event", boundAgentHandler);
		// 非默认会话的 trading 事件按绑定转发；默认会话的已在下方全局订阅
		if (next !== defaultSession) {
			boundTradingHandler = onTrading;
			next.on("trading_event", boundTradingHandler);
		} else {
			boundTradingHandler = null;
		}
	}

	// ---- 默认会话 trading_event 广播 ----
	const onDefaultTrading = (ev: any) => send({ type: "trading_event", event: ev });
	defaultSession.on("trading_event", onDefaultTrading);

	// ---- manager meta 推送 ----
	// 简化决策：ws-handler 内部自行维护 boundId（connect 时为 "default"；
	// session_switch/session_new/delete 更新），推送判断用 boundId === id。
	// agent/trading 订阅仍按会话实例。这样 manager 事件只需 id 匹配。
	let boundId: string | null = "default";
	const onSessionUpdated = ({ id, meta }: { id: string; meta: SessionMeta }) => {
		if (boundId === id) send({ type: "session_updated", session: meta });
	};
	const onSessionDeleted = ({ id }: { id: string }) => {
		if (boundId === id) send({ type: "session_deleted", sessionId: id });
	};
	sessionManager.on("session_updated", onSessionUpdated);
	sessionManager.on("session_deleted", onSessionDeleted);

	async function switchTo(id: string): Promise<void> {
		const session = await sessionManager.get(id);
		if (!session) throw new Error(`会话不存在: ${id}`);
		if (boundId !== id) await sessionManager.flush(boundId ?? undefined);
		bind(session);
		boundId = id;
	}

	ws.on("message", async (data) => {
		let msg: { type: string; reqId?: number; [k: string]: unknown };
		try {
			msg = JSON.parse(data.toString("utf-8"));
		} catch {
			send({ type: "error", message: "Invalid JSON" });
			return;
		}
		const reqId = msg.reqId;
		try {
			switch (msg.type) {
				case "prompt": {
					const message = String(msg.message || "");
					const attachments = msg.attachments as
						| Array<{ name: string; content: string; mimeType: string }>
						| undefined;
					if (!message && (!attachments || attachments.length === 0)) {
						send({ type: "error", reqId, message: "message or attachments are required" });
						return;
					}
					await bound.prompt(message, { attachments });
					break;
				}
				case "get_state": {
					const meta = boundId ? sessionManager.getMeta(boundId) : undefined;
					send({
						type: "state",
						state: { mode: bound.currentMode, messages: bound.messages, session: meta },
					});
					break;
				}
				case "session_list": {
					const sessions = await sessionManager.list();
					send({ type: "session_list", reqId, sessions });
					break;
				}
				case "session_new": {
					const { session, meta } = await sessionManager.create();
					if (boundId !== null && boundId !== "default") await sessionManager.flush(boundId);
					bind(session);
					boundId = meta.id;
					send({ type: "session_created", reqId, session: meta, messages: session.messages });
					break;
				}
				case "session_switch": {
					const sessionId = String(msg.sessionId || "");
					if (!sessionId) throw new Error("sessionId is required");
					await switchTo(sessionId);
					const meta = sessionManager.getMeta(sessionId);
					send({ type: "session_state", reqId, session: meta, messages: bound.messages });
					break;
				}
				case "session_delete": {
					const sessionId = String(msg.sessionId || "");
					if (!sessionId) throw new Error("sessionId is required");
					await sessionManager.delete(sessionId);
					if (boundId === sessionId) {
						// 删除的是当前会话：解除绑定到默认，客户端随后自行 session_new
						bind(defaultSession);
						boundId = "default";
					}
					send({ type: "session_deleted", reqId, sessionId });
					break;
				}
				case "abort": {
					send({ type: "info", message: "Abort not yet implemented" });
					break;
				}
				default:
					send({ type: "error", reqId, message: `Unknown message type: ${msg.type}` });
			}
		} catch (err) {
			console.error("[WS] Error handling message:", err);
			send({ type: "error", reqId, message: err instanceof Error ? err.message : String(err) });
		}
	});

	ws.on("close", () => {
		if (boundAgentHandler) bound.off("agent_event", boundAgentHandler);
		if (boundTradingHandler) bound.off("trading_event", boundTradingHandler);
		defaultSession.off("trading_event", onDefaultTrading);
		sessionManager.off("session_updated", onSessionUpdated);
		sessionManager.off("session_deleted", onSessionDeleted);
	});

	ws.on("error", (err) => console.error("[WS] WebSocket error:", err));

	send({ type: "connected", message: "Trading agent ready" });
}
