import { test, expect } from "@playwright/test";

test.describe("Weekly Kline Chart", () => {
	test("should render weekly klines when switching to week period", async ({ page }) => {
		// Capture API responses for diagnosis
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

		// Wait for the app to load
		await page.waitForSelector("#stock-search-input", { timeout: 30000 });

		// Search for a known stock
		await page.fill("#stock-search-input", "600519");
		await page.waitForTimeout(500);
		await page.click(".search-dropdown-item");

		// Wait for chart panel
		await page.waitForSelector(".stock-chart-panel", { timeout: 15000 });
		await page.waitForSelector("#kline-chart-container", { timeout: 15000 });

		// Wait for daily klines to render
		await page.waitForTimeout(1500);

		// Click week button
		const weekBtn = page.locator('[data-period="week"]');
		await expect(weekBtn).toBeVisible();
		await weekBtn.click();

		// Wait for weekly data to load and render
		await page.waitForTimeout(2000);

		// Chart container should not show the empty placeholder
		const emptyMsg = page.locator(".chart-empty");
		await expect(emptyMsg).toHaveCount(0);
	});
});
