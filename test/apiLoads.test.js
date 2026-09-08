// Every serverless route must be importable.
//
// WHY THIS EXISTS
// Nothing else in this repo ever loads `api/`. `vite build` bundles only what
// `src/main.jsx` reaches, and no file under src/ imports api/ — the client talks
// to those routes over HTTP. The rest of `test/` covers the pure cores. So the
// entire serverless half of the deployed app has no compile-time net at all: a
// leftover `import { getPlaidClient } from './_lib/plaid.js'` after that file is
// deleted passes `npm test`, passes `npm run build`, and ships green. It only
// surfaces as a 500 on the first real request — and if that request is
// /api/sync, the bank feed is simply dead until someone notices the numbers
// have stopped moving.
//
// That is not hypothetical: removing Plaid deletes three modules that four
// routes imported. This test is what makes that deletion checkable.
//
// It also can't be replaced by grepping for a route's 404, which is the obvious
// deploy probe: Vercel's router answers a 404 for a deleted file WITHOUT ever
// loading any other function, so a broken sync.js sails past it.
//
// Deliberately NOT asserted here: that a handler behaves correctly. This is a
// load-bearing smoke test — module-scope evaluation and the export shape. Those
// are exactly the two things a refactor breaks and nothing else checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
const routes = readdirSync(apiDir)
  .filter(f => f.endsWith('.js'))
  .sort();

test('there are routes to check (guards against a silently empty glob)', () => {
  assert.ok(routes.length > 0, 'no .js files found in api/');
});

for (const file of routes) {
  // Imported with NO environment variables set. Anything that reads config at
  // module scope rather than inside the handler would throw here — which is the
  // correct outcome, because on Vercel that same throw is a
  // FUNCTION_INVOCATION_FAILED on every request to the route, not a
  // configuration error the app can report. (getServiceClient in
  // api/_lib/supabase.js is lazy for exactly this reason.)
  test(`api/${file} imports cleanly and exports a handler`, async () => {
    const mod = await import(pathToFileURL(join(apiDir, file)).href);
    assert.equal(
      typeof mod.default,
      'function',
      `api/${file} must default-export a handler function`
    );
  });
}

// --- 2026-09-04 audit: the assistant runs on the CALLER's day ---------------
// UTC rolled the month over hours before the phones did, so "what did we spend
// this month?" was answered about a month with no rows. The client now sends
// its local day and the route validates it — strictly, because the value
// shapes queries.
test('resolveToday accepts a valid nearby day and refuses everything else', async () => {
  const { resolveToday } = await import('../api/assistant.js');
  const now = Date.parse('2026-10-01T04:00:00Z'); // 9pm Sep 30 in US Pacific

  assert.equal(resolveToday('2026-09-30', now), '2026-09-30', 'the phone is still in September');
  assert.equal(resolveToday('2026-10-01', now), '2026-10-01');
  assert.equal(resolveToday('2026-10-02', now), '2026-10-02', 'a day ahead is a real timezone');

  const utc = '2026-10-01';
  assert.equal(resolveToday('2026-06-01', now), utc, 'an arbitrary past date is refused');
  assert.equal(resolveToday('2027-01-01', now), utc, 'an arbitrary future date is refused');
  assert.equal(resolveToday(undefined, now), utc, 'no value falls back to UTC');
  assert.equal(resolveToday('not-a-date', now), utc);
  assert.equal(resolveToday('2026-13-45', now), utc, 'shaped but impossible');
  assert.equal(resolveToday(20260930, now), utc, 'a non-string is refused');
});
