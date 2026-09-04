import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDataStore, getDataStore, setDataStore } from "../data/index.js";
import { managePortfolioTool } from "./portfolio.js";

// Helper to call the tool
async function callTool(action: string, extra: Record<string, any> = {}) {
	const result = await managePortfolioTool.execute("test-call-id", { action, ...extra } as any);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	return { text, details: result.details };
}

describe("manage_portfolio tool integration", () => {
	const testDir = join(tmpdir(), `pi-portfolio-test-${Date.now()}`);
	let portfolioId: number;

	beforeAll(async () => {
		mkdirSync(testDir, { recursive: true });
		const store = createDataStore(testDir);
		await store.init();
		setDataStore(store);
	});

	afterAll(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("should create a portfolio", async () => {
		const { text, details } = await callTool("create", {
			name: "测试组合",
			initial_cash: 1_000_000,
			description: "用于测试的组合",
		});
		expect(text).toContain("创建成功");
		expect(text).toContain("1,000,000");
		expect(details.portfolio).toBeDefined();
		portfolioId = details.portfolio!.id;
		expect(portfolioId).toBeGreaterThan(0);
	});

	it("should reject duplicate portfolio name", async () => {
		const { text, details } = await callTool("create", {
			name: "测试组合",
			initial_cash: 500_000,
		});
		expect(text).toContain("已存在");
		expect(details.error).toBe("portfolio exists");
	});

	it("should list portfolios", async () => {
		const { text, details } = await callTool("list");
		expect(text).toContain("测试组合");
		expect(text).toContain("1,000,000");
		expect(details.portfolios).toBeInstanceOf(Array);
		expect(details.portfolios!.length).toBeGreaterThan(0);
	});

	it("should record a buy trade", async () => {
		const { text, details } = await callTool("trade", {
			id: portfolioId,
			trade_date: "2024-06-01",
			code: "600519",
			market: 1,
			direction: "buy",
			quantity: 100,
			price: 1500,
			commission: 10,
		});
		expect(text).toContain("买入");
		expect(text).toContain("600519.SH");
		expect(text).toContain("100股");
		expect(details.tradeId).toBeGreaterThan(0);
	});

	it("should record another buy trade for same stock", async () => {
		const { text, details } = await callTool("trade", {
			id: portfolioId,
			trade_date: "2024-06-02",
			code: "600519",
			market: 1,
			direction: "buy",
			quantity: 100,
			price: 1600,
		});
		expect(text).toContain("买入");
		expect(details.tradeId).toBeGreaterThan(0);
	});

	it("should reject buy with non-integer quantity", async () => {
		const { text, details } = await callTool("trade", {
			id: portfolioId,
			trade_date: "2024-06-03",
			code: "600519",
			market: 1,
			direction: "buy",
			quantity: 100.5,
			price: 1500,
		});
		expect(text).toContain("正整数");
		expect(details.error).toBe("invalid trade params");
	});

	it("should show holdings with weighted avg cost", async () => {
		const { text, details } = await callTool("show", { id: portfolioId });
		expect(text).toContain("测试组合");
		expect(text).toContain("初始资金");
		expect(text).toContain("600519.SH");
		// Weighted avg cost: (100*1500 + 100*1600) / 200 = 1550
		expect(text).toContain("1550");
		expect(text).toContain("200股");
		expect(details.holdings).toBeInstanceOf(Array);
		expect(details.holdings!.length).toBe(1);
		expect(details.holdings![0].quantity).toBe(200);
		expect(details.holdings![0].avgCost).toBeCloseTo(1550, 0);
	});

	it("should record a partial sell", async () => {
		const { text, details } = await callTool("trade", {
			id: portfolioId,
			trade_date: "2024-06-03",
			code: "600519",
			market: 1,
			direction: "sell",
			quantity: 50,
			price: 1700,
		});
		expect(text).toContain("卖出");
		expect(details.tradeId).toBeGreaterThan(0);
	});

	it("should reject sell with insufficient shares", async () => {
		const { text, details } = await callTool("trade", {
			id: portfolioId,
			trade_date: "2024-06-04",
			code: "600519",
			market: 1,
			direction: "sell",
			quantity: 1000,
			price: 1700,
		});
		expect(text).toContain("不足");
		expect(details.error).toBe("insufficient shares");
	});

	it("should show updated holdings after partial sell", async () => {
		const { text, details } = await callTool("show", { id: portfolioId });
		// After selling 50 from 200, should have 150 left
		// avgCost should still be 1550 (weighted avg doesn't change on sell)
		expect(text).toContain("150股");
		expect(text).toContain("1550");
		expect(details.holdings![0].quantity).toBe(150);
		expect(details.holdings![0].avgCost).toBeCloseTo(1550, 0);
	});

	it("should show trade history", async () => {
		const { text, details } = await callTool("history", { id: portfolioId });
		expect(text).toContain("买入");
		expect(text).toContain("卖出");
		expect(text).toContain("600519.SH");
		expect(details.trades).toBeInstanceOf(Array);
		expect(details.trades!.length).toBe(3); // 2 buys + 1 sell
	});

	it("should record a full sell", async () => {
		const { text } = await callTool("trade", {
			id: portfolioId,
			trade_date: "2024-06-05",
			code: "600519",
			market: 1,
			direction: "sell",
			quantity: 150,
			price: 1800,
		});
		expect(text).toContain("卖出");
	});

	it("should show empty holdings after full sell", async () => {
		const { text, details } = await callTool("show", { id: portfolioId });
		expect(text).toContain("暂无持仓");
		expect(details.holdings!.length).toBe(0);
	});

	it("should delete portfolio", async () => {
		const { text, details } = await callTool("delete", { id: portfolioId });
		expect(text).toContain("已删除");
		expect(details.deleted).toBe(portfolioId);
	});

	it("should confirm portfolio is gone after delete", async () => {
		const { text, details } = await callTool("show", { id: portfolioId });
		expect(text).toContain("不存在");
		expect(details.error).toBe("portfolio not found");
	});

	it("should also delete all trades when portfolio is deleted", async () => {
		// Create a new portfolio, add a trade, delete it, then check trades are gone
		const createResult = await callTool("create", {
			name: "删除测试",
			initial_cash: 100_000,
		});
		const tempId = createResult.details.portfolio!.id;

		await callTool("trade", {
			id: tempId,
			trade_date: "2024-06-01",
			code: "000001",
			market: 0,
			direction: "buy",
			quantity: 100,
			price: 10,
		});

		const store = getDataStore()!;
		const tradesBefore = await store.getPortfolioTrades(tempId);
		expect(tradesBefore.length).toBe(1);

		await callTool("delete", { id: tempId });

		const tradesAfter = await store.getPortfolioTrades(tempId);
		expect(tradesAfter.length).toBe(0);
	});
});
