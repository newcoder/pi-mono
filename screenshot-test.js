const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto('http://localhost:3000');
  await page.waitForTimeout(3000);

  // Click on first hot stock to show chart panel
  const hotStock = await page.$('.hot-stock-item');
  if (hotStock) await hotStock.click();

  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'chart-intraday-test.png', fullPage: false });
  console.log('Screenshot saved to chart-intraday-test.png');

  await browser.close();
})();
