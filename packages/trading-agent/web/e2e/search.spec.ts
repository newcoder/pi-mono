import { test, expect } from "@playwright/test";

test.describe("Stock Search & Recent Pool", () => {
	test.beforeEach(async ({ page }) => {
		// Wait for console log BEFORE navigating, since loadAllStocks fires during init
		const stocksLoadedPromise = page.waitForEvent("console", {
			predicate: (msg) => msg.text().includes("[Search] Loaded"),
			timeout: 60000,
		});
		await page.goto("/");
		await page.waitForSelector("#stock-search-input", { timeout: 15000 });
		await page.waitForSelector(".pool-card", { timeout: 15000 });
		await stocksLoadedPromise;
		// Small buffer for JS to finish processing
		await page.waitForTimeout(200);
	});

	test("search input is visible with correct placeholder", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await expect(input).toBeVisible();
		await expect(input).toHaveAttribute("placeholder", /搜索股票/);
	});

	test("typing stock code shows matching results in dropdown", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("600519");
		await page.waitForTimeout(300); // debounce

		const dropdown = page.locator("#search-dropdown");
		await expect(dropdown).not.toHaveClass(/hidden/);

		// Should show 贵州茅台 in results
		await expect(page.locator(".search-dropdown-item")).toContainText("600519");
		await expect(page.locator(".search-dropdown-item").first()).toContainText("贵州茅台");
	});

	test("typing stock name shows matching results", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("茅台");
		await page.waitForTimeout(300);

		const dropdown = page.locator("#search-dropdown");
		await expect(dropdown).not.toHaveClass(/hidden/);
		await expect(page.locator(".search-dropdown-item").first()).toContainText("贵州茅台");
	});

	test("pinyin search matches stock names", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("maotai");
		await page.waitForTimeout(300);

		const dropdown = page.locator("#search-dropdown");
		await expect(dropdown).not.toHaveClass(/hidden/);
		await expect(page.locator(".search-dropdown-item").first()).toContainText("贵州茅台");
	});

	test("first-letter pinyin search matches stock names", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("gzmt");
		await page.waitForTimeout(300);

		const dropdown = page.locator("#search-dropdown");
		await expect(dropdown).not.toHaveClass(/hidden/);
		await expect(page.locator(".search-dropdown-item").first()).toContainText("贵州茅台");
	});

	test("clicking dropdown item selects stock and shows chart", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("600519");
		await page.waitForTimeout(300);

		// Click first result
		await page.locator(".search-dropdown-item").first().click();

		// Dropdown should close
		await expect(page.locator("#search-dropdown")).toHaveClass(/hidden/);

		// Input should clear
		await expect(input).toHaveValue("");

		// Chart panel should appear with stock info
		await expect(page.locator("#stock-chart-panel")).toBeVisible();
		await expect(page.locator("#stock-chart-panel")).toContainText("600519");
	});

	test("keyboard Enter selects first match and shows chart", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("600519");
		await page.waitForTimeout(300);

		await input.press("Enter");

		// Chart panel should appear
		await expect(page.locator("#stock-chart-panel")).toBeVisible();
		await expect(page.locator("#stock-chart-panel")).toContainText("600519");
	});

	test("keyboard arrow navigation works in dropdown", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("600");
		await page.waitForTimeout(300);

		// Dropdown opens with first item already highlighted (index 0)
		const firstItem = page.locator(".search-dropdown-item").first();
		await expect(firstItem).toHaveClass(/highlighted/);

		// Press arrow down to move to second item
		await input.press("ArrowDown");
		const secondItem = page.locator(".search-dropdown-item").nth(1);
		await expect(secondItem).toHaveClass(/highlighted/);

		// Press Enter to select highlighted item
		await input.press("Enter");

		// Chart should show
		await expect(page.locator("#stock-chart-panel")).toBeVisible();
	});

	test("Escape closes dropdown", async ({ page }) => {
		const input = page.locator("#stock-search-input");
		await input.fill("600519");
		await page.waitForTimeout(300);

		await expect(page.locator("#search-dropdown")).not.toHaveClass(/hidden/);

		await input.press("Escape");

		await expect(page.locator("#search-dropdown")).toHaveClass(/hidden/);
	});

	test("selected stock is added to 最近访问 pool", async ({ page }) => {
		// First select a stock
		const input = page.locator("#stock-search-input");
		await input.fill("600519");
		await page.waitForTimeout(300);
		await input.press("Enter");

		// Wait for chart to appear
		await expect(page.locator("#stock-chart-panel")).toBeVisible();

		// Wait a bit for the async add-to-pool request
		await page.waitForTimeout(1500);

		// Click on 最近访问 pool to see if stock was added
		// Match only the real recent-visits pool card; backtest report pools may contain "最近访问" in their names.
		await page
			.locator(".pool-card")
			.filter({ has: page.locator(".pool-name", { hasText: /\[\d+\]\s*最近访问$/ }) })
			.click();

		// Wait for the pool items panel to show the selected stock
		await expect(page.locator("#pool-items .stock-item").filter({ hasText: "600519" })).toBeVisible({ timeout: 10000 });
	});

	test("market status bar is removed from UI", async ({ page }) => {
		await expect(page.locator("#market-status")).not.toBeVisible();
		await expect(page.locator(".market-status-bar")).not.toBeVisible();
		await expect(page.locator(".connection-badge")).not.toBeVisible();
	});
});
