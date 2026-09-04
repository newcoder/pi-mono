import { describe, expect, it } from "vitest";
import type { PortfolioTradeRow } from "../data/types.js";
import { replayHoldings } from "./engine.js";

describe("replayHoldings", () => {
	it("should calculate weighted average cost correctly for multiple buys", () => {
		const trades: PortfolioTradeRow[] = [
			{
				id: 1,
				portfolio_id: 1,
				trade_date: "2024-01-01",
				code: "600519",
				market: 1,
				direction: "buy",
				quantity: 100,
				price: 10,
				adjust: "bfq",
			},
			{
				id: 2,
				portfolio_id: 1,
				trade_date: "2024-01-02",
				code: "600519",
				market: 1,
				direction: "buy",
				quantity: 100,
				price: 20,
				adjust: "bfq",
			},
		];
		const { cashDelta, holdings } = replayHoldings(trades, "2024-01-02");
		const holding = holdings.get("600519:1");
		expect(holding).toBeDefined();
		expect(holding!.quantity).toBe(200);
		expect(holding!.avgCost).toBe(15);
		expect(cashDelta).toBe(-3000);
	});

	it("should keep avgCost unchanged on partial sell", () => {
		const trades: PortfolioTradeRow[] = [
			{
				id: 1,
				portfolio_id: 1,
				trade_date: "2024-01-01",
				code: "600519",
				market: 1,
				direction: "buy",
				quantity: 100,
				price: 10,
				adjust: "bfq",
			},
			{
				id: 2,
				portfolio_id: 1,
				trade_date: "2024-01-02",
				code: "600519",
				market: 1,
				direction: "buy",
				quantity: 100,
				price: 20,
				adjust: "bfq",
			},
			{
				id: 3,
				portfolio_id: 1,
				trade_date: "2024-01-03",
				code: "600519",
				market: 1,
				direction: "sell",
				quantity: 50,
				price: 25,
				adjust: "bfq",
			},
		];
		const { cashDelta, holdings } = replayHoldings(trades, "2024-01-03");
		const holding = holdings.get("600519:1");
		expect(holding).toBeDefined();
		expect(holding!.quantity).toBe(150);
		expect(holding!.avgCost).toBe(15);
		expect(cashDelta).toBe(-3000 + 1250);
	});

	it("should remove holding on full sell", () => {
		const trades: PortfolioTradeRow[] = [
			{
				id: 1,
				portfolio_id: 1,
				trade_date: "2024-01-01",
				code: "600519",
				market: 1,
				direction: "buy",
				quantity: 100,
				price: 10,
				adjust: "bfq",
			},
			{
				id: 2,
				portfolio_id: 1,
				trade_date: "2024-01-02",
				code: "600519",
				market: 1,
				direction: "sell",
				quantity: 100,
				price: 15,
				adjust: "bfq",
			},
		];
		const { cashDelta, holdings } = replayHoldings(trades, "2024-01-02");
		expect(holdings.has("600519:1")).toBe(false);
		expect(cashDelta).toBe(500);
	});

	it("should handle multiple stocks", () => {
		const trades: PortfolioTradeRow[] = [
			{
				id: 1,
				portfolio_id: 1,
				trade_date: "2024-01-01",
				code: "600519",
				market: 1,
				direction: "buy",
				quantity: 100,
				price: 10,
				adjust: "bfq",
			},
			{
				id: 2,
				portfolio_id: 1,
				trade_date: "2024-01-01",
				code: "000001",
				market: 0,
				direction: "buy",
				quantity: 200,
				price: 5,
				adjust: "bfq",
			},
		];
		const { holdings } = replayHoldings(trades, "2024-01-01");
		expect(holdings.size).toBe(2);
		expect(holdings.get("600519:1")!.quantity).toBe(100);
		expect(holdings.get("000001:0")!.quantity).toBe(200);
	});

	it("should handle fees in weighted average cost", () => {
		const trades: PortfolioTradeRow[] = [
			{
				id: 1,
				portfolio_id: 1,
				trade_date: "2024-01-01",
				code: "600519",
				market: 1,
				direction: "buy",
				quantity: 100,
				price: 10,
				adjust: "bfq",
				commission: 10,
				tax: 5,
			},
		];
		const { cashDelta, holdings } = replayHoldings(trades, "2024-01-01");
		const holding = holdings.get("600519:1");
		expect(holding!.avgCost).toBe((1000 + 15) / 100);
		expect(cashDelta).toBe(-1015);
	});
});
