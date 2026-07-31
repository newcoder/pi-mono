import { test, expect } from "@playwright/test";

test.describe("Weekly Kline Fallback", () => {
	test("should fetch and render weekly klines from mootdx fallback when DB is empty", async ({ page }) => {
		page.on("response", async (res) => {
			if (res.url().includes("/api/klines")) {
				try {
					const json = await res.json();
					console.log(`[API] ${res.url()} -> ${json.length} bars`);
				} catch {
					console.log(`[API] ${res.url()} -> non-json`);
				}
			}
		});

		await page.goto("/");
		await page.waitForSelector("#stock-search-input", { timeout: 30000 });

		// Use a stock that likely has no week data in DB to trigger mootdx fallback
		await page.fill("#stock-search-input", "001237");
		await page.waitForTimeout(500);
		await page.click(".search-dropdown-item");

		await page.waitForSelector(".stock-chart-panel", { timeout: 15000 });
		await page.waitForSelector("#kline-chart-container", { timeout: 15000 });
		await page.waitForTimeout(1500);

		const weekBtn = page.locator('[data-period="week"]');
		await expect(weekBtn).toBeVisible();
		await weekBtn.click();

		// Wait longer for mootdx fallback
		await page.waitForTimeout(4000);

		const emptyMsg = page.locator(".chart-empty");
		await expect(emptyMsg).toHaveCount(0);
	});
});
