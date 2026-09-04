from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900})

    page.goto("http://localhost:3000")
    page.wait_for_timeout(3000)

    # Click first hot stock to open chart panel
    hot_stock = page.query_selector(".hot-stock-item")
    if hot_stock:
        hot_stock.click()

    page.wait_for_timeout(3000)

    page.screenshot(path="chart-intraday-test.png")
    print("Screenshot saved to chart-intraday-test.png")

    browser.close()
