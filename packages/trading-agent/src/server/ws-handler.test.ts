import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { type SessionLike, setupWsHandler } from "./ws-handler.js";

class FakeWs {
	readyState = 1;
	OPEN = 1; // ws-handler 内用实例属性 ws.OPEN 判断
	sent: any[] = [];
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	private listeners: Record<string, Array<(d: any) => void>> = {};
	on(type: string, cb: (d: any) => void) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(cb);
		return this;
	}
	async receive(msg: any) {
		for (const cb of this.listeners.message ?? []) await cb({ toString: () => JSON.stringify(msg) });
	}
}

function fakeSession(): SessionLike & EventEmitter {
	const s = new EventEmitter() as any;
	s.messages = [];
	s.prompt = vi.fn().mockResolvedValue(undefined);
	return s;
}
function fakeMeta(id: string, title = "标题") {
	return {
		id,
		title,
		titleSource: "truncated" as const,
		createdAt: "2026-09-04T00:00:00.000Z",
		updatedAt: "2026-09-04T00:00:00.000Z",
		messageCount: 0,
	};
}

describe("setupWsHandler session binding", () => {
	// 每个 fake manager 都补齐 handler 会调用的 flush/getMeta/delete，避免运行时 undefined
	function baseManager(overrides: Record<string, unknown> = {}) {
		const manager = new EventEmitter() as any;
		manager.flush = vi.fn().mockResolvedValue(undefined);
		manager.getMeta = vi.fn(() => fakeMeta("default"));
		manager.delete = vi.fn().mockResolvedValue(undefined);
		manager.list = vi.fn().mockResolvedValue([]);
		manager.get = vi.fn().mockResolvedValue(undefined);
		Object.assign(manager, overrides);
		return manager;
	}

	it("binds to default on connect and routes prompt to it", async () => {
		const defaultS = fakeSession();
		const manager = baseManager({
			list: vi.fn().mockResolvedValue([fakeMeta("default")]),
			get: vi.fn().mockResolvedValue(defaultS),
		});
		const ws = new FakeWs();
		setupWsHandler(ws as any, { sessionManager: manager, defaultSession: defaultS });

		await ws.receive({ type: "prompt", message: "你好" });
		expect(defaultS.prompt).toHaveBeenCalledWith("你好", expect.anything());
	});

	it("session_switch rebinds agent events to the new session", async () => {
		const defaultS = fakeSession();
		const otherS = fakeSession();
		const manager = baseManager({
			get: vi.fn(async (id: string) => (id === "s2" ? otherS : defaultS)),
			getMeta: vi.fn(() => fakeMeta("s2")),
		});
		const ws = new FakeWs();
		setupWsHandler(ws as any, { sessionManager: manager, defaultSession: defaultS });

		await ws.receive({ type: "session_switch", sessionId: "s2", reqId: 1 });
		// 转发新会话的 agent 事件
		otherS.emit("agent_event", { type: "message_end" });
		expect(ws.sent.some((m) => m.type === "agent_event")).toBe(true);
		// 旧会话 agent 事件不再转发
		const before = ws.sent.length;
		defaultS.emit("agent_event", { type: "message_end" });
		expect(ws.sent.length).toBe(before);
	});

	it("session_list / session_new / session_delete round-trips with reqId", async () => {
		const defaultS = fakeSession();
		const created = fakeSession();
		const manager = baseManager({
			list: vi.fn().mockResolvedValue([fakeMeta("s1"), fakeMeta("s2")]),
			create: vi.fn().mockResolvedValue({ session: created, meta: fakeMeta("s3") }),
			getMeta: vi.fn(() => fakeMeta("s3")),
		});
		const ws = new FakeWs();
		setupWsHandler(ws as any, { sessionManager: manager, defaultSession: defaultS });

		await ws.receive({ type: "session_list", reqId: 7 });
		expect(ws.sent.some((m) => m.type === "session_list" && m.reqId === 7 && m.sessions.length === 2)).toBe(true);

		await ws.receive({ type: "session_new", reqId: 8 });
		expect(ws.sent.some((m) => m.type === "session_created" && m.reqId === 8)).toBe(true);

		await ws.receive({ type: "session_delete", sessionId: "s1", reqId: 9 });
		expect(ws.sent.some((m) => m.type === "session_deleted" && m.reqId === 9)).toBe(true);
	});

	it("pushes session_deleted to a connection bound to a session deleted elsewhere", async () => {
		const defaultS = fakeSession();
		const otherS = fakeSession();
		const manager = baseManager({
			get: vi.fn(async (id: string) => (id === "s2" ? otherS : defaultS)),
			getMeta: vi.fn(() => fakeMeta("s2")),
		});
		const ws = new FakeWs();
		setupWsHandler(ws as any, { sessionManager: manager, defaultSession: defaultS });
		await ws.receive({ type: "session_switch", sessionId: "s2" });
		manager.emit("session_deleted", { id: "s2" });
		expect(ws.sent.some((m) => m.type === "session_deleted")).toBe(true);
	});
});
