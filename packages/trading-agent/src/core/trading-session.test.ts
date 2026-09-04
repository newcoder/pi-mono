import { describe, expect, it, vi } from "vitest";
import { TradingSession, type TradingSessionOptions } from "./trading-session.js";

function makeSession(opts: Partial<TradingSessionOptions> = {}): TradingSession {
	// Agent 构造需要完整 config，测试只验证初始 messages 透传与钩子触发，
	// 故用最小可运行配置 + streamFn 永远拒绝（不会真正调用 LLM）。
	return new TradingSession({
		model: { provider: "test", id: "test-model" } as any,
		baseSystemPrompt: "system",
		tools: [],
		streamFn: (async () => {
			throw new Error("not used");
		}) as any,
		...opts,
	} as TradingSessionOptions);
}

describe("TradingSession resume + first-prompt hook", () => {
	it("seeds initialState.messages from initialMessages", () => {
		const seed = [{ role: "user", content: "旧问题", timestamp: 1 } as any];
		const session = makeSession({ initialMessages: seed });
		expect(session.messages).toEqual(seed);
	});

	it("fires onFirstPrompt once on the first prompt with the raw input", () => {
		const onFirstPrompt = vi.fn();
		const session = makeSession({ onFirstPrompt });
		// prompt() 入队即触发钩子；LLM 调用由 streamFn 抛错终止，promise reject 忽略
		session.prompt("请分析 600519").catch(() => {});
		session.prompt("第二次").catch(() => {});
		expect(onFirstPrompt).toHaveBeenCalledTimes(1);
		expect(onFirstPrompt).toHaveBeenCalledWith("请分析 600519");
	});

	it("does not fire onFirstPrompt when resuming a non-empty session", () => {
		const onFirstPrompt = vi.fn();
		const seed = [{ role: "user", content: "历史", timestamp: 1 } as any];
		const session = makeSession({ initialMessages: seed, onFirstPrompt });
		session.prompt("新问题").catch(() => {});
		expect(onFirstPrompt).not.toHaveBeenCalled();
	});

	it("dispose() rejects queued prompts so awaiting handlers do not hang", async () => {
		// streamFn 永不结束 → 第一个 prompt 持续 in-flight，第二个留在队列中
		const session = makeSession({
			streamFn: (() => new Promise(() => {})) as any,
		});
		session.prompt("第一个").catch(() => {});
		const queued = session.prompt("第二个");
		const rejected = expect(queued).rejects.toThrow("Session disposed");
		session.dispose();
		await rejected;
	});
});
