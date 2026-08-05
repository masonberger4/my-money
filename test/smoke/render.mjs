// The render gate. Boots the smoke harness, loads it in a real browser, and
// asserts the Dashboard actually mounted.
//
// This exists because `npm test` and `vite build` both pass on an app that
// cannot render: neither one evaluates Dashboard.jsx in a browser. A
// use-before-declaration there throws a ReferenceError on first render and
// every user gets the ErrorBoundary. That shipped once. This is the only
// automated check that would have caught it.
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

const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));

let gotoError = null;
try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
} catch (e) {
  gotoError = e.message;
}
// React mounts after the module graph settles; give it a beat.
await page.waitForTimeout(2500);

const tabs = await page.$$eval('.tab', els => els.length).catch(() => 0);
const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
const boundary = /something broke|reload the page/i.test(bodyText);

await browser.close();

if (gotoError) fail(`could not load ${URL} — ${gotoError}`);
if (pageErrors.length) fail(`uncaught page error(s):\n  ${pageErrors.join('\n  ')}`);
if (boundary) fail('the ErrorBoundary rendered — the app crashed on first render');
if (tabs < EXPECTED_TABS) {
  fail(`expected ${EXPECTED_TABS} tabs, found ${tabs} — the Dashboard did not mount`);
}

console.log(`SMOKE OK: ${tabs} tabs rendered, no page errors, no ErrorBoundary.`);
