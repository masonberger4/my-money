// The render gate. Boots the smoke harness, loads it in a real browser, and
// asserts the Dashboard actually mounted — then VISITS EVERY TAB.
//
// This exists because `npm test` and `vite build` both pass on an app that
// cannot render: neither one evaluates Dashboard.jsx in a browser. A
// use-before-declaration there throws a ReferenceError on first render and
// every user gets the ErrorBoundary. That shipped once. This is the only
// automated check that would have caught it.
//
// Why every tab, not just the landing one: the original gate proved the tab
// BAR existed and stopped. But each tab renders a different slice of a ~5,000
// line component, so the exact bug class this file was written for — a TDZ
// ReferenceError, a bad hook order, a null deref in one tab's JSX — still
// shipped green everywhere except Overview. Clicking through is the cheap
// part; not clicking through was the gap.
//
// Silence is not success: the assertions below fail on a crashed render, an
// ErrorBoundary, a pageerror, or a missing tab bar — not merely on a timeout.
//
// Usage: node test/smoke/render.mjs   (expects a server on PORT, default 5199)
// Resolve whichever driver is present: CI installs `playwright` (which manages
// its own browser download); a local sandbox may only have `playwright-core`
// plus a browser on disk, pointed at by CHROMIUM_PATH.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('playwright-core'));
}

const PORT = process.env.SMOKE_PORT || '5199';
const URL = `http://localhost:${PORT}`;
const EXPECTED_TABS = 10;

const fail = msg => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};

const launchOpts = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : {};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

// pageerror = an uncaught exception. That is the failure this gate exists for,
// so it is fatal wherever it happens. `where` is stamped as we go so the
// message names the tab instead of just the stack's first line.
let where = 'initial load';
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(`[${where}] ${String(e).split('\n')[0]}`));

// console.error is NOT fatal: the mock adapter deliberately rejects some reads
// (receipts, for one) so the error paths render, and failing on those would
// make the gate lie about what it proves. Collected and printed as context for
// whatever did fail.
const consoleErrors = [];
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(`[${where}] ${m.text().slice(0, 200)}`);
});

let gotoError = null;
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Wait for the thing we are asserting on rather than a fixed sleep: React
  // mounts when the module graph settles, and a hardcoded delay is either
  // slower than needed or flaky on a loaded CI runner.
  await page.waitForSelector('.tab', { timeout: 30_000 });
} catch (e) {
  gotoError = e.message;
}

const bodyHasBoundary = async () =>
  /something broke|reload the page/i.test(
    await page.evaluate(() => document.body.innerText || '').catch(() => '')
  );

const tabCount = await page.$$eval('.tab', els => els.length).catch(() => 0);
const boundaryAtStart = await bodyHasBoundary();

// Visit each tab by INDEX, re-reading the handle each time: clicking re-renders
// the tab strip, so handles captured up front go stale.
const visited = [];
if (!gotoError && tabCount >= EXPECTED_TABS) {
  for (let i = 0; i < tabCount; i++) {
    const tabs = await page.$$('.tab');
    if (!tabs[i]) break;
    const label = (await tabs[i].innerText().catch(() => `#${i}`)).trim() || `#${i}`;
    where = `tab: ${label}`;
    try {
      await tabs[i].click({ timeout: 10_000 });
    } catch (e) {
      await browser.close();
      fail(`could not click tab "${label}" — ${e.message}`);
    }
    // Let the tab's effects run and paint. A lazy tab (trends/recurring/debt/
    // tax) resolves a promise before it renders anything real.
    await page.waitForTimeout(600);
    if (await bodyHasBoundary()) {
      await browser.close();
      fail(
        `the ErrorBoundary rendered on the "${label}" tab — that tab crashed.\n` +
          (consoleErrors.length ? `  console: ${consoleErrors.slice(-5).join('\n  console: ')}` : '')
      );
    }
    visited.push(label);
  }
}

await browser.close();

if (gotoError) fail(`could not load ${URL} — ${gotoError}`);
if (pageErrors.length) {
  fail(
    `uncaught page error(s):\n  ${pageErrors.join('\n  ')}` +
      (consoleErrors.length ? `\n  console: ${consoleErrors.slice(-5).join('\n  console: ')}` : '')
  );
}
if (boundaryAtStart) fail('the ErrorBoundary rendered — the app crashed on first render');
if (tabCount < EXPECTED_TABS) {
  fail(`expected ${EXPECTED_TABS} tabs, found ${tabCount} — the Dashboard did not mount`);
}
if (visited.length < EXPECTED_TABS) {
  fail(`only visited ${visited.length}/${EXPECTED_TABS} tabs — the tab strip changed mid-run`);
}

console.log(`SMOKE OK: ${visited.length} tabs rendered, no page errors, no ErrorBoundary.`);
console.log(`  visited: ${visited.join(' · ')}`);
if (consoleErrors.length) {
  console.log(`  (${consoleErrors.length} console error(s), non-fatal — the mock rejects some reads on purpose)`);
}
