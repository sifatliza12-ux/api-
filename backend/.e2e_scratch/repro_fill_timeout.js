// Focused repro: is locator.fill({timeout:3000}) on Wikipedia's real search
// input actually bounded to ~3s, or does it sometimes hang far longer?
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.goto('https://en.wikipedia.org/wiki/Main_Page', { waitUntil: 'domcontentloaded' });
  await page.click('#searchInput');

  for (let i = 1; i <= 5; i += 1) {
    const started = Date.now();
    try {
      await page.locator('#searchInput').fill(`Marie Curie attempt ${i}`, { timeout: 3000 });
      console.log(`attempt ${i}: fill() OK in ${Date.now() - started}ms`);
    } catch (error) {
      console.log(`attempt ${i}: fill() THREW after ${Date.now() - started}ms — ${error.message.split('\n')[0]}`);
    }
    await page.waitForTimeout(500);
  }

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('CRASHED:', err);
  process.exit(1);
});
