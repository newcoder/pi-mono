import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TradingSession } from "./trading-session.js";

export interface SessionMeta {
	id: string;
	title: string;
	titleSource: "truncated" | "refined" | undefined;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	system?: boolean;
}

export interface SessionFile {
	id: string;
	title: string;
	titleSource?: SessionMeta["titleSource"];
	createdAt: string;
	updatedAt: string;
	system?: boolean;
	messages: unknown[];
}

export const DEFAULT_SESSION_ID = "default";

const SAVE_DEBOUNCE_MS = 1000;
const NEW_TITLE = "新会话";
const DEFAULT_TITLE = "默认会话";

export function truncateTitle(input: string, max = 30): string {
	const collapsed = input.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export class SessionManager extends EventEmitter {
	private sessions = new Map<string, TradingSession>();
	private metas = new Map<string, SessionMeta>();
	private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private refining = new Set<string>();

	constructor(
		private opts: {
			sessionsDir: string;
			createSession: (
				initialMessages?: AgentMessage[],
				hooks?: { onFirstPrompt?: (input: string) => void },
			) => TradingSession;
			refineTitle?: (messages: AgentMessage[]) => Promise<string | null>;
		},
	) {
		super();
	}

	async init(): Promise<void> {
		if (!existsSync(this.opts.sessionsDir)) mkdirSync(this.opts.sessionsDir, { recursive: true });
	}

	private filePath(id: string): string {
		return join(this.opts.sessionsDir, `${id}.json`);
	}

	private toMeta(file: SessionFile): SessionMeta {
		return {
			id: file.id,
			title: file.title,
			titleSource: file.titleSource,
			createdAt: file.createdAt,
			updatedAt: file.updatedAt,
			messageCount: Array.isArray(file.messages) ? file.messages.length : 0,
			system: file.system,
		};
	}

	async list(): Promise<SessionMeta[]> {
		const result: SessionMeta[] = [];
		if (!existsSync(this.opts.sessionsDir)) return result;
		const diskIds = new Set<string>();
		for (const name of readdirSync(this.opts.sessionsDir)) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -5);
			diskIds.add(id);
			// 内存 meta 是权威（落盘为防抖滞后）：已注册会话直接返回内存，
			// 避免磁盘旧值覆盖尚未落盘的标题/updatedAt 更新。
			const mem = this.metas.get(id);
			if (mem) {
				result.push(mem);
				continue;
			}
			try {
				const file = JSON.parse(readFileSync(join(this.opts.sessionsDir, name), "utf8")) as SessionFile;
				if (!file || typeof file.id !== "string") continue;
				const meta = this.toMeta(file);
				this.metas.set(file.id, meta);
				result.push(meta);
			} catch (err) {
				console.warn(`[SessionManager] Skipping corrupt session file ${name}:`, err);
			}
		}
		// 内存中存在但磁盘尚无文件（新建未落盘）的会话也要出现在列表
		for (const [id, meta] of this.metas) {
			if (!diskIds.has(id)) result.push(meta);
		}
		return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async has(id: string): Promise<boolean> {
		if (this.sessions.has(id)) return true;
		return existsSync(this.filePath(id));
	}

	async get(id: string): Promise<TradingSession | undefined> {
		const cached = this.sessions.get(id);
		if (cached) return cached;
		if (!existsSync(this.filePath(id))) return undefined;
		let file: SessionFile;
		try {
			file = JSON.parse(readFileSync(this.filePath(id), "utf8")) as SessionFile;
		} catch (err) {
			console.warn(`[SessionManager] Corrupt session file for ${id}:`, err);
			return undefined;
		}
		return this.register(id, file);
	}

	private register(id: string, file: SessionFile): TradingSession {
		const session = this.opts.createSession(Array.isArray(file.messages) ? (file.messages as AgentMessage[]) : [], {
			onFirstPrompt: (input) => this.handleFirstPrompt(id, input),
		});
		this.metas.set(id, this.toMeta(file));
		session.on("agent_event", (ev: any) => {
			if (ev?.type !== "agent_end") return;
			this.scheduleSave(id);
			this.maybeRefine(id);
		});
		this.sessions.set(id, session);
		return session;
	}

	async create(id?: string, system = false): Promise<{ session: TradingSession; meta: SessionMeta }> {
		if (id) {
			if (this.sessions.has(id) || existsSync(this.filePath(id))) {
				throw new Error(`Session "${id}" already exists`);
			}
		}
		const sessionId = id ?? crypto.randomUUID();
		const now = new Date().toISOString();
		const file: SessionFile = {
			id: sessionId,
			title: system ? DEFAULT_TITLE : NEW_TITLE,
			createdAt: now,
			updatedAt: now,
			system,
			messages: [],
		};
		writeFileSync(this.filePath(sessionId), JSON.stringify(file, null, "\t"));
		const session = this.register(sessionId, file);
		return { session, meta: this.metas.get(sessionId)! };
	}

	/** 保证默认（系统）会话存在；web 模式下 scheduler/sentiment/router 的目标 */
	async ensureDefault(): Promise<{ session: TradingSession; meta: SessionMeta }> {
		const existing = await this.get(DEFAULT_SESSION_ID);
		if (existing) return { session: existing, meta: this.metas.get(DEFAULT_SESSION_ID)! };
		return this.create(DEFAULT_SESSION_ID, true);
	}

	async delete(id: string): Promise<void> {
		const meta = this.metas.get(id) ?? (await this.list()).find((m) => m.id === id);
		if (meta?.system) throw new Error("系统会话不可删除");
		this.sessions.get(id)?.dispose();
		this.sessions.delete(id);
		this.metas.delete(id);
		const timer = this.saveTimers.get(id);
		if (timer) clearTimeout(timer);
		this.saveTimers.delete(id);
		this.refining.delete(id);
		if (existsSync(this.filePath(id))) rmSync(this.filePath(id));
		this.emit("session_deleted", { id });
	}

	private handleFirstPrompt(id: string, input: string): void {
		const meta = this.metas.get(id);
		if (!meta || meta.system) return;
		if (meta.title !== NEW_TITLE) return;
		meta.title = truncateTitle(input);
		meta.titleSource = "truncated";
		this.scheduleSave(id);
		this.emit("session_updated", { id, meta: { ...meta } });
	}

	private async maybeRefine(id: string): Promise<void> {
		const meta = this.metas.get(id);
		if (!meta || meta.system || meta.titleSource !== "truncated") return;
		if (this.refining.has(id) || !this.opts.refineTitle) return;
		this.refining.add(id);
		try {
			const session = this.sessions.get(id);
			if (!session) return;
			const title = await this.opts.refineTitle(session.messages as AgentMessage[]);
			const current = this.metas.get(id);
			if (!current || current.titleSource !== "truncated" || !title) return; // 已删除/已精炼
			current.title = title.slice(0, 30);
			current.titleSource = "refined";
			this.scheduleSave(id);
			this.emit("session_updated", { id, meta: { ...current } });
		} catch (err) {
			console.warn(`[SessionManager] Title refinement failed for ${id}:`, err);
		} finally {
			this.refining.delete(id);
		}
	}

	private scheduleSave(id: string): void {
		const existing = this.saveTimers.get(id);
		if (existing) clearTimeout(existing);
		this.saveTimers.set(
			id,
			setTimeout(() => {
				this.saveTimers.delete(id);
				this.save(id).catch((err) => console.error(`[SessionManager] Save failed for ${id}:`, err));
			}, SAVE_DEBOUNCE_MS),
		);
	}

	async save(id: string): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;
		const meta = this.metas.get(id);
		if (!meta) return;
		const file: SessionFile = {
			id,
			title: meta.title,
			titleSource: meta.titleSource,
			createdAt: meta.createdAt,
			updatedAt: new Date().toISOString(),
			system: meta.system,
			messages: session.messages as unknown[],
		};
		meta.updatedAt = file.updatedAt;
		meta.messageCount = file.messages.length;
		writeFileSync(this.filePath(id), JSON.stringify(file, null, "\t"));
	}

	async flush(id?: string): Promise<void> {
		if (id) {
			const timer = this.saveTimers.get(id);
			if (timer) {
				clearTimeout(timer);
				this.saveTimers.delete(id);
			}
			await this.save(id).catch(() => {});
			return;
		}
		for (const sid of [...this.saveTimers.keys()]) {
			const timer = this.saveTimers.get(sid);
			if (timer) clearTimeout(timer);
			this.saveTimers.delete(sid);
			await this.save(sid).catch(() => {});
		}
	}

	getMeta(id: string): SessionMeta | undefined {
		return this.metas.get(id);
	}
}
