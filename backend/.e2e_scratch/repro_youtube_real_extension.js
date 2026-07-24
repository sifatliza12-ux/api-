// Diagnostic-only repro: loads the REAL, UNMODIFIED extension (manifest.json,
// content.js, service-worker.js) into a REAL Chromium instance via Playwright's
// persistent context with --load-extension, so content.js runs in its actual
// production JS world (isolated world) rather than Playwright's
// addInitScript (which injects into the page's MAIN world and is therefore
// subject to the page's Trusted Types CSP in a way a real content script may
// not be). This is to check whether createWidget()'s innerHTML assignment
// actually throws under real extension conditions on youtube.com, and if
// not, to observe the real event sequence from a thumbnail click through to
// clicking "Stop & Save Recording".
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const path = require('path');
const { chromium } = require('playwright');

const EXT_PATH = 'c:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st\\extension';
const USER_DATA_DIR = path.join(__dirname, '..', '.tmp-ext-profile');

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    console.log('>> waiting for extension service worker to activate');
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }
    console.log('>> service worker url:', sw.url());
    const extensionId = new URL(sw.url()).host;
    console.log('>> extension id:', extensionId);

    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (msg) => { if (msg.text().includes('Recorder')) console.log('  [console]', msg.text()); });
    page.on('pageerror', (err) => console.log('  [pageerror]', err.message));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  [framenavigated]', f.url()); });

    console.log('>> navigating to youtube.com');
    await page.bringToFront();
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);

    console.log('>> invoking real startRecording(tabId) inside the real service worker');
    const startResult = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
      const tab = tabs[0];
      // startRecording is a top-level const in service-worker.js -- reachable
      // by name from code evaluated in this same service worker realm.
      const result = await startRecording(tab.id);
      return { tabId: tab.id, result };
    });
    console.log('>> startRecording result:', JSON.stringify(startResult));

    await page.waitForTimeout(1500);
    const widgetCount = await page.locator('#forgeflow-recorder-widget').count();
    console.log('>> [after real startRecording] widget count in DOM:', widgetCount);
    if (widgetCount > 0) {
      const box = await page.locator('#forgeflow-recorder-widget').boundingBox();
      console.log('>> widget boundingBox:', JSON.stringify(box));
    }

    // Now do a real search + real thumbnail click, exactly like a user would.
    console.log('>> searching for a query to reach a results page with thumbnails');
    await page.click('input#search, input[name="search_query"]');
    await page.fill('input#search, input[name="search_query"]', 'lofi hip hop radio');
    await page.press('input#search, input[name="search_query"]', 'Enter');
    await page.waitForURL('**results**', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const widgetCount2 = await page.locator('#forgeflow-recorder-widget').count();
    console.log('>> [on results page] widget count in DOM:', widgetCount2);
    let widgetBox2 = null;
    if (widgetCount2 > 0) {
      widgetBox2 = await page.locator('#forgeflow-recorder-widget').boundingBox();
      console.log('>> widget boundingBox on results page:', JSON.stringify(widgetBox2));
    }

    await page.waitForSelector('ytd-thumbnail a#thumbnail', { timeout: 15000 }).catch(() => {});
    const thumbs = page.locator('ytd-thumbnail a#thumbnail');
    const thumbCount = await thumbs.count();
    console.log('>> thumbnail count:', thumbCount);

    let clickedBox = null;
    for (let i = 0; i < Math.min(thumbCount, 20); i++) {
      const b = await thumbs.nth(i).boundingBox();
      if (b) {
        clickedBox = b;
        console.log(`>> clicking thumbnail #${i} at box`, JSON.stringify(b));
        await thumbs.nth(i).click({ timeout: 5000 }).catch((e) => console.log('thumbnail click threw:', e.message));
        break;
      }
    }

    await page.waitForTimeout(2000);
    console.log('>> now on watch page:', page.url());
    console.log('>> viewport size:', JSON.stringify(page.viewportSize()));
    await page.screenshot({ path: '.e2e_scratch/watch_page_debug.png', fullPage: false }).catch((e) => console.log('screenshot failed', e.message));

    const widgetBoxOnWatch = await page.locator('#forgeflow-recorder-widget').boundingBox().catch(() => null);
    console.log('>> widget boundingBox on watch page:', JSON.stringify(widgetBoxOnWatch));

    // The "up next" / recommendations sidebar renders compact thumbnails in
    // the right-hand column -- check whether any of them geometrically
    // overlap the fixed bottom-right widget.
    await page.waitForSelector('ytd-compact-video-renderer #thumbnail, ytd-thumbnail a#thumbnail', { timeout: 15000 }).catch(() => {});
    const sidebarThumbs = page.locator('ytd-compact-video-renderer #thumbnail, ytd-watch-next-secondary-results-renderer a#thumbnail');
    const sidebarCount = await sidebarThumbs.count();
    console.log('>> sidebar/up-next thumbnail count:', sidebarCount);

    const intersects = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

    let overlappingIndex = -1;
    let overlappingBox = null;
    for (let i = 0; i < Math.min(sidebarCount, 40); i++) {
      const b = await sidebarThumbs.nth(i).boundingBox();
      if (b && widgetBoxOnWatch && intersects(b, widgetBoxOnWatch)) {
        overlappingIndex = i;
        overlappingBox = b;
        break;
      }
    }
    console.log('>> sidebar thumbnail overlapping the widget:', overlappingIndex, JSON.stringify(overlappingBox));

    page.on('dialog', async (dialog) => {
      console.log('  [dialog]', dialog.type(), dialog.message());
      await dialog.dismiss().catch(() => {});
    });

    if (overlappingIndex >= 0) {
      console.log('>> attempting a REAL (non-forced) Playwright click on the overlapped sidebar thumbnail');
      await sidebarThumbs.nth(overlappingIndex).click({ timeout: 5000 })
        .then(() => console.log('>> click succeeded with no interception reported'))
        .catch((e) => console.log('>> click threw (this is the interception proof if it names the widget/button):', e.message));
    } else {
      console.log('>> no sidebar thumbnail currently overlaps the widget -- clicking directly at the widget\'s own screen coordinates instead, to confirm what a hit-test there resolves to');
      const cx = widgetBoxOnWatch.x + widgetBoxOnWatch.width / 2;
      const cy = widgetBoxOnWatch.y + widgetBoxOnWatch.height - 20; // near the stop button specifically
      const elementAtPoint = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).join('.');
        return s;
      }, { x: cx, y: cy });
      console.log(`>> document.elementFromPoint(${cx}, ${cy}) [widget's own Stop button area] =`, elementAtPoint);
    }

    await page.waitForTimeout(500);
    const stateAfter = await sw.evaluate(async () => {
      return await chrome.storage.session.get(null);
    });
    const eventsAfter = stateAfter['forgeflow.recorder.state']?.events || [];
    console.log('\n>> recorded event count before clicking the real Stop button:', eventsAfter.length);

    // Decisive check: click the REAL "Stop & Save Recording" button (inside
    // the widget's open shadow root -- Playwright's locator pierces open
    // shadow roots automatically) and see whether THIS click -- the
    // legitimate, intentional stop action -- itself leaks into the saved
    // event log as a bogus page-interaction event.
    console.log('\n>> clicking the REAL Stop & Save Recording button');
    await page.locator('[data-role="stop"]').click({ timeout: 5000 })
      .then(() => console.log('>> stop button click dispatched'))
      .catch((e) => console.log('>> stop button click threw:', e.message));
    await page.waitForTimeout(1000);

    const stateFinal = await sw.evaluate(async () => {
      return await chrome.storage.session.get(null);
    });
    const finalRec = stateFinal['forgeflow.recorder.state'];
    console.log('>> isRecording after stop click:', finalRec?.isRecording);
    const eventsFinal = finalRec?.events || [];
    console.log('>> total recorded events after stop click:', eventsFinal.length);
    console.log('>> ALL events whose selector mentions "pill" or "stop":');
    eventsFinal.forEach((e, i) => {
      if ((e.selector || '').toLowerCase().includes('stop') || (e.selector || '').toLowerCase().includes('pill')) {
        console.log(`  [${i}]`, JSON.stringify({ type: e.type, selector: e.selector, value: e.value, locators: e.locators }));
      }
    });
    console.log('\n>> last 5 events overall:');
    eventsFinal.slice(-5).forEach((e, i) => console.log(`  [${eventsFinal.length - 5 + i}]`, JSON.stringify({ type: e.type, selector: e.selector, value: typeof e.value === 'string' ? e.value.slice(0, 60) : e.value })));
    console.log('\n>> LAST 3 recorded events after the overlap-click attempt:');
    eventsAfter.slice(-3).forEach((e) => console.log('  ', JSON.stringify({ type: e.type, selector: e.selector, value: typeof e.value === 'string' ? e.value.slice(0, 60) : e.value })));

    process.exitCode = 0;
  } catch (err) {
    console.error('CRASH', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
