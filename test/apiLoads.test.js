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
