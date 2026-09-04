import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_ID, SessionManager } from "./session-manager.js";

function stubSession(initialMessages: unknown[] = []) {
	const s = new EventEmitter() as any;
	s.messages = initialMessages;
	s.prompt = vi.fn();
	s.dispose = vi.fn();
	return s;
}

describe("SessionManager", () => {
	let dir: string;
	const sessions: Array<{ initial: unknown[]; hooks?: { onFirstPrompt?: (i: string) => void } }> = [];
	let manager: SessionManager;

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function makeManager() {
		sessions.length = 0;
		manager = new SessionManager({
			sessionsDir: dir,
			createSession: (initial, hooks) => {
				sessions.push({ initial: initial ?? [], hooks });
				return stubSession(initial) as any;
			},
			refineTitle: async () => "精炼标题",
		});
		return manager;
	}

	it("create/list/get/delete round-trips through files", async () => {
		dir = mkdtempSync(join(tmpdir(), "sessions-"));
		const m = makeManager();
		await m.init();
		const { session: _session, meta } = await m.create();
		expect(meta.title).toBe("新会话");
		expect(meta.messageCount).toBe(0);

		// list 读回
		const listed = await m.list();
		expect(listed.map((x) => x.id)).toContain(meta.id);

		// 换一个 manager 实例 = 模拟重启，从文件恢复
		const m2 = makeManager();
		await m2.init();
		const restored = await m2.get(meta.id);
		expect(restored).toBeTruthy();
		expect(sessions[0].initial).toEqual([]);

		await m2.delete(meta.id);
		expect(await m2.list()).toEqual([]);
	});

	it("persists messages on save and restores them", async () => {
		dir = mkdtempSync(join(tmpdir(), "sessions-"));
		const m = makeManager();
		await m.init();
		const { session } = (await m.create()) as any;
		session.messages = [{ role: "user", content: "hi", timestamp: 1 }];
		await m.flush((await m.list())[0].id);

		const m2 = makeManager();
		await m2.init();
		const restored = await m2.get((await m2.list())[0].id);
		expect(restored).toBeTruthy();
		expect(sessions[0].initial).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});

	it("truncates title from first prompt via onFirstPrompt hook", async () => {
		dir = mkdtempSync(join(tmpdir(), "sessions-"));
		const m = makeManager();
		await m.init();
		const { meta: created } = await m.create();
		// create 时 hooks 立即注册
		const { hooks } = sessions[0];
		hooks!.onFirstPrompt!("请分析 600519 贵州茅台的基本面情况，以及行业趋势和估值水平");
		// list() 不得用磁盘旧值回滚未落盘的标题更新
		await m.list();
		expect(m.getMeta(created.id)!.title).toContain("请分析 600519");
		await m.flush(created.id);
		const meta = (await m.list())[0];
		expect(meta.title).toContain("请分析 600519");
		expect(meta.titleSource).toBe("truncated");
	});

	it("system default session is created on ensure and cannot be deleted", async () => {
		dir = mkdtempSync(join(tmpdir(), "sessions-"));
		const m = makeManager();
		await m.init();
		await m.ensureDefault();
		const meta = (await m.list())[0];
		expect(meta.id).toBe(DEFAULT_SESSION_ID);
		expect(meta.system).toBe(true);
		expect(meta.title).toBe("默认会话");
		await expect(m.delete(DEFAULT_SESSION_ID)).rejects.toThrow(/不可删除/);
	});

	it("skips corrupt files in list()", async () => {
		dir = mkdtempSync(join(tmpdir(), "sessions-"));
		const m = makeManager();
		await m.init();
		await m.create();
		// 手写一个坏文件
		writeFileSync(join(dir, "corrupt.json"), "{not json");
		const listed = await m.list();
		expect(listed.length).toBe(1);
	});
});
