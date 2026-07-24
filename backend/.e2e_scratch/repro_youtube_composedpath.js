// Diagnostic-only repro: does NOT modify extension/content/content.js.
// Injects the REAL content.js (unmodified) into a real Playwright page on
// real youtube.com, plus a SEPARATE diagnostic capture-phase click listener
// on document that independently logs event.target, event.composedPath(),
// and what content.js's own getStableEventTarget() would have picked --
// re-implemented here read-only, verbatim from content.js's algorithm, purely
// for observation. Then clicks an actual YouTube thumbnail and reports.
process.env.FORGEFLOW_HEADLESS = 'true';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CONTENT_JS_PATH = path.join(__dirname, '..', '..', '..', '..', '..', '..', '..', 'extension', 'content', 'content.js');
// Resolve relative to repo, not scratchpad depth guesswork -- use absolute known repo path instead.
const REPO_CONTENT_JS = 'c:\\Users\\DELL\\OneDrive\\Desktop\\vibe coding 1st\\extension\\content\\content.js';
const CONTENT_JS_SOURCE = fs.readFileSync(REPO_CONTENT_JS, 'utf8');
const TOP_FRAME_ONLY_CONTENT_JS = `if (window.top === window.self) {\n${CONTENT_JS_SOURCE}\n}`;

const DIAGNOSTIC_SCRIPT = `
(function () {
  if (window.top !== window.self) return;
  const NATIVE_INTERACTIVE_TAGS = new Set(['a','button','input','select','textarea','option','label']);
  const INTERACTIVE_ARIA_ROLES = new Set(['button','link','checkbox','radio','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','combobox','slider','spinbutton','searchbox','textbox']);
  const isInteractiveElement = (el) => {
    if (!(el instanceof Element)) return false;
    if (NATIVE_INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ARIA_ROLES.has(role.toLowerCase())) return true;
    if (el.hasAttribute('onclick') || typeof el.onclick === 'function') return true;
    if (el.isContentEditable) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    return false;
  };
  const describe = (node) => {
    if (node === window) return 'Window';
    if (node === document) return '#document';
    if (node instanceof ShadowRoot) return 'ShadowRoot(host=' + describe(node.host) + ')';
    if (!(node instanceof Element)) return String(node);
    let s = node.tagName.toLowerCase();
    if (node.id) s += '#' + node.id;
    if (node.className && typeof node.className === 'string' && node.className.trim()) {
      s += '.' + node.className.trim().split(/\\s+/).join('.');
    }
    return s;
  };
  document.addEventListener('click', function (event) {
    const originalTarget = event.target;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    let pickedIndex = -1;
    let pickedNode = originalTarget;
    let reason = 'original event.target was already interactive (or not an Element) -- returned unchanged';
    if (originalTarget instanceof Element && !isInteractiveElement(originalTarget)) {
      reason = 'no interactive ancestor found in composedPath before body/html -- returned original target unchanged';
      for (let i = 0; i < path.length; i++) {
        const node = path[i];
        if (node === originalTarget || !(node instanceof Element)) continue;
        if (node === document.body || node === document.documentElement) {
          reason = 'walk reached <body>/<html> without finding an interactive ancestor -- stopped, returned original target';
          break;
        }
        if (isInteractiveElement(node)) {
          pickedIndex = i;
          pickedNode = node;
          reason = 'first interactive node encountered walking composedPath() from index ' + i;
          break;
        }
      }
    }
    window.__ffDiag__({
      url: location.href,
      originalTarget: describe(originalTarget),
      composedPath: path.map(describe),
      pickedIndex,
      picked: describe(pickedNode),
      reason
    });
  }, true);
})();
`;

(async () => {
  const diagLog = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  await page.exposeFunction('__ffDiag__', (info) => diagLog.push(info));
  await page.exposeFunction('__ffCaptureEvent__', () => {});
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'recorder-event' && msg.event) {
            window.__ffCaptureEvent__(msg.event);
          }
          if (cb) cb({ ok: true, state: { isRecording: true, events: [], startedAt: new Date().toISOString() } });
        },
        onMessage: { addListener: () => {} },
        lastError: undefined
      }
    };
  });
  // Diagnostic listener registered first, then the real unmodified content.js.
  await page.addInitScript({ content: DIAGNOSTIC_SCRIPT });
  await page.addInitScript({ content: TOP_FRAME_ONLY_CONTENT_JS });
  // Must be attached BEFORE navigation -- content.js's earliest logs
  // ("loaded", "recording started") fire within the first paint, well
  // before a post-navigation listener would ever catch them.
  page.on('console', (msg) => { if (msg.text().includes('Recorder')) console.log('  [console]', msg.text()); });
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  [framenavigated]', f.url()); });

  try {
    console.log('>> navigating to youtube.com');
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    await page.screenshot({ path: '.e2e_scratch/yt_debug_1.png', fullPage: false }).catch(() => {});
    console.log('>> page title:', await page.title());
    console.log('>> frames:', page.frames().map((f) => f.url()));
    console.log('>> [homepage] widget count:', await page.locator('#forgeflow-recorder-widget').count());

    // Try to dismiss consent dialog if present (best-effort, non-fatal).
    try {
      const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
      if (await consentBtn.isVisible({ timeout: 5000 })) {
        console.log('>> dismissing consent dialog');
        await consentBtn.click();
        await page.waitForTimeout(1000);
      } else {
        console.log('>> no consent dialog visible');
      }
    } catch (e) { console.log('>> consent check error', e.message); }

    // Homepage has no recommendations when logged out (empty "try searching"
    // state) -- go through search results instead, which reliably renders
    // thumbnails, same as backend/.e2e_scratch/repro_youtube.js does.
    console.log('>> searching for a query to reach a results page with thumbnails');
    await page.click('input#search, input[name="search_query"]');
    await page.fill('input#search, input[name="search_query"]', 'lofi hip hop radio');
    await page.press('input#search, input[name="search_query"]', 'Enter');
    await page.waitForURL('**results**', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    console.log('>> [results, +1.5s] widget count:', await page.locator('#forgeflow-recorder-widget').count());
    await page.waitForTimeout(2000);
    console.log('>> [results, +3.5s] widget count:', await page.locator('#forgeflow-recorder-widget').count());

    await page.screenshot({ path: '.e2e_scratch/yt_debug_2.png', fullPage: false }).catch(() => {});
    await page.waitForSelector('ytd-thumbnail a#thumbnail', { timeout: 15000 }).catch(() => {});
    const thumbCount = await page.locator('ytd-thumbnail a#thumbnail').count();
    console.log('>> thumbnail count found:', thumbCount);

    if (thumbCount > 0) {
      // Pick a thumbnail that is actually visible in the viewport without
      // scrolling, so its on-screen position can be compared directly
      // against the fixed-position recorder widget's own bounding box.
      const thumbs = page.locator('ytd-thumbnail a#thumbnail');
      let thumb = null;
      let box = null;
      const n = Math.min(thumbCount, 20);
      for (let i = 0; i < n; i++) {
        const candidate = thumbs.nth(i);
        const b = await candidate.boundingBox();
        if (b) { thumb = candidate; box = b; break; }
      }
      console.log('>> chosen thumbnail boundingBox:', JSON.stringify(box));

      const widgetCount = await page.locator('#forgeflow-recorder-widget').count();
      console.log('>> recorder widget host count in DOM:', widgetCount);
      const widgetBox = await page.locator('#forgeflow-recorder-widget').boundingBox().catch(() => null);
      console.log('>> recorder widget host boundingBox:', JSON.stringify(widgetBox));
      if (widgetCount > 0) {
        const widgetInfo = await page.evaluate(() => {
          const host = document.getElementById('forgeflow-recorder-widget');
          if (!host) return null;
          const cs = getComputedStyle(host);
          return {
            display: cs.display, visibility: cs.visibility, position: cs.position,
            width: cs.width, height: cs.height, opacity: cs.opacity,
            rect: host.getBoundingClientRect().toJSON ? host.getBoundingClientRect().toJSON() : { ...host.getBoundingClientRect() },
            hasShadow: !!host.shadowRoot,
            shadowChildCount: host.shadowRoot ? host.shadowRoot.childElementCount : null
          };
        });
        console.log('>> recorder widget computed style/rect:', JSON.stringify(widgetInfo));
      }

      if (thumb) {
        // Deliberately NOT force:true here -- a real user's click is subject
        // to real hit-testing (whatever element is actually topmost at that
        // pixel receives it), and Playwright's normal actionability check
        // will itself report which element intercepts the pointer if the
        // widget is actually on top of this thumbnail on screen.
        await thumb.click({ timeout: 5000 }).catch((e) => console.log('non-forced click() threw:', e.message));
        await page.waitForTimeout(500);
      }
    }

    console.log('\\n=== DIAGNOSTIC CLICK LOG (' + diagLog.length + ' click(s) observed) ===');
    diagLog.forEach((entry, i) => {
      console.log(`\\n--- click #${i} on ${entry.url} ---`);
      console.log('event.target (as seen by document capture listener):', entry.originalTarget);
      console.log('event.composedPath() full ancestor chain, in order:');
      entry.composedPath.forEach((node, idx) => {
        const marker = idx === entry.pickedIndex ? '  <== getStableEventTarget() SELECTS THIS NODE' : '';
        console.log(`  [${idx}] ${node}${marker}`);
      });
      console.log('picked node:', entry.picked);
      console.log('reason:', entry.reason);
    });
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
})().catch((err) => { console.error('CRASH', err); process.exit(1); });
