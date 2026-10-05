// Runtime tests for public/sw.js — the REAL worker run in node:vm against a
// fake CacheStorage, network and clock (test/helpers/fakeCacheStorage.js).
// test/lockstep.test.js pins the worker's TEXT guards; this pins behavior:
//
//  F48  a CACHE_VERSION bump no longer wipes the fingerprinted assets, and the
//       precache paths are served from the shell cache — the first offline
//       launch after a bump boots instead of painting only the background.
//  F85  with a cached shell, a hung network serves it after SHELL_TIMEOUT_MS
//       while the fetch finishes in the background (under waitUntil).
//  F86  the /assets prune spares every URL the live shell references, so the
//       byte-stable vendor/runtime chunks aren't evicted as "oldest".
//  F45  a fingerprinted path answered with HTML (a rewrite's index.html) or a
//       404 is never cached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHarness, flush, state, bodyOf } from './helpers/fakeCacheStorage.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = readFileSync(join(root, 'public/sw.js'), 'utf8');
const MAX_ASSET_ENTRIES = Number(SW.match(/const MAX_ASSET_ENTRIES = (\d+);/)?.[1]);
const SHELL_TIMEOUT_MS = Number(SW.match(/const SHELL_TIMEOUT_MS = (\d+);/)?.[1]);
// A later sw.js release: same logic, CACHE_VERSION bumped.
const bumped = src => src.replace(/^const CACHE_VERSION = '([^']+)';/m, "const CACHE_VERSION = '$1-next';");

const STATIC = ['/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png',
  '/icon-maskable-512.png', '/fonts/inter.woff2'];

// Publishes deploy `id`: its index.html (entry + CSS + modulepreloaded stable
// chunks, Vite's shape) and a lazy chunk the shell does NOT reference. The
// network then serves only this deploy's /assets/* — older chunks are 404s.
function deploy(h, id, { stable = ['vendor-react-STABLE.js', 'rolldown-runtime-STABLE.js'] } = {}) {
  const entry = `/assets/index-${id}.js`;
  const css = `/assets/index-${id}.css`;
  const preloads = stable.map(s => `/assets/${s}`);
  const html = `<!doctype html><html><head>
    <script type="module" crossorigin src="${entry}"></script>
    ${preloads.map(p => `<link rel="modulepreload" crossorigin href="${p}">`).join('\n    ')}
    <link rel="stylesheet" crossorigin href="${css}">
  </head><body><div id="root"></div><!-- deploy ${id} --></body></html>`;
  for (const p of [...h.net.files.keys()]) if (p.startsWith('/assets/')) h.net.files.delete(p);
  h.net.serve('/', html, 'text/html');
  for (const p of STATIC) h.net.serve(p, `static:${p}`, 'application/octet-stream');
  for (const p of [entry, ...preloads]) h.net.serve(p, `js:${p}`);
  h.net.serve(css, `css:${css}`, 'text/css');
  const lazy = `/assets/CsvImport-${id}.js`;
  h.net.serve(lazy, `js:${lazy}`);
  return { html, assets: [entry, ...preloads, css], lazy };
}

const bodyFor = p => (p.endsWith('.css') ? `css:${p}` : `js:${p}`);

// One app launch: the navigation (awaiting its background work), then every
// /assets/* the RETURNED shell references, plus the font. → { html, got }.
async function launch(w, extra = []) {
  const nav = w.fetch('/', { mode: 'navigate' });
  assert.ok(nav.responded, 'navigations are always answered by the worker');
  const html = await bodyOf(nav.response);
  await nav.settled();
  const refs = [...html.matchAll(/["'](\/assets\/[^"']+)["']/g)].map(m => m[1]);
  const got = {};
  for (const p of [...refs, '/fonts/inter.woff2', ...extra]) {
    const ev = w.fetch(p);
    got[p] = ev.responded ? await bodyOf(ev.response) : 'PASSTHROUGH';
  }
  return { html, refs, got };
}

async function freshWorker(h, source = SW) {
  const w = h.loadWorker(source);
  await w.install();
  await w.activate();
  return w;
}

const shellName = h => h.caches.names().find(n => n.startsWith('shell-'));
const cachedAnywhere = (h, path) => h.caches.names().some(n => h.caches.peek(n).has(path));

// --- F48 --------------------------------------------------------------------

test('F48: precached files resolve offline straight after install', async () => {
  const h = createHarness();
  deploy(h, 'A');
  const w = await freshWorker(h);
  h.net.mode = 'offline';
  for (const p of STATIC) {
    const ev = w.fetch(p);
    assert.ok(ev.responded, `${p} must be handled by the worker`);
    assert.equal(await bodyOf(ev.response), `static:${p}`, `${p} must come from the precache, offline`);
  }
});

test('F48: a CACHE_VERSION bump keeps the fingerprinted assets — the first offline launch after it boots', async () => {
  const h = createHarness();
  deploy(h, 'A');
  const w1 = await freshWorker(h);
  await launch(w1); // deploy A, online
  const B = deploy(h, 'B');
  const online = await launch(w1); // the session that picks up deploy B and the new worker
  assert.ok(online.html.includes('deploy B'));

  const w2 = await freshWorker(h, bumped(SW)); // installs + activates mid-session
  h.net.mode = 'offline';
  const off = await launch(w2);
  assert.ok(off.html.includes('deploy B'), 'offline navigation serves the new shell');
  for (const p of B.assets) assert.equal(off.got[p], bodyFor(p), `${p} must survive the bump`);
  assert.equal(off.got['/fonts/inter.woff2'], 'static:/fonts/inter.woff2');
});

test('F48: the v7 → v8 activate migrates the legacy assets-v7 entries instead of wiping them', async () => {
  const h = createHarness();
  const A = deploy(h, 'A');
  // What a v7 worker left behind: a versioned shell and asset cache (the
  // asset cache also held the stable-URL font it served cache-first).
  const shell7 = await h.caches.open('shell-v7');
  await shell7.put('/', h.net.respond('/'));
  const assets7 = await h.caches.open('assets-v7');
  for (const p of [...A.assets, '/fonts/inter.woff2']) await assets7.put(p, h.net.respond(p));

  const w = await freshWorker(h);
  const names = h.caches.names();
  assert.ok(!names.includes('assets-v7') && !names.includes('shell-v7'), `legacy caches deleted (left: ${names})`);
  const assets = h.caches.peek('assets');
  assert.ok(assets, 'the unversioned asset cache exists');
  assert.deepEqual(assets.paths(), A.assets, 'every legacy /assets/* entry carried over, oldest first; nothing else');

  h.net.mode = 'offline';
  const off = await launch(w);
  for (const p of A.assets) assert.notEqual(off.got[p], 'ERR', `${p} must resolve offline after the migration`);
  assert.notEqual(off.got['/fonts/inter.woff2'], 'ERR');
});

test('/api/*, cross-origin and non-GET requests pass straight through', async () => {
  const h = createHarness();
  deploy(h, 'A');
  const w = await freshWorker(h);
  assert.equal(w.fetch('/api/sync').responded, false);
  assert.equal(w.fetch('/api/accounts', { mode: 'navigate' }).responded, false);
  assert.equal(w.fetch('https://x.supabase.co/rest/v1/transactions').responded, false);
  assert.equal(w.fetch('/', { mode: 'navigate', method: 'POST' }).responded, false);
});

// --- F85 --------------------------------------------------------------------

test('F85: SHELL_TIMEOUT_MS is a few seconds', () => {
  assert.ok(SHELL_TIMEOUT_MS >= 1000 && SHELL_TIMEOUT_MS <= 5000, `got ${SHELL_TIMEOUT_MS}`);
});

test('F85: with a cached shell, a hung network serves it after the timeout — and the late fetch still updates it', async () => {
  const h = createHarness();
  const A = deploy(h, 'A');
  const w = await freshWorker(h);
  h.net.mode = 'hang';
  const nav = w.fetch('/', { mode: 'navigate' });
  await flush();
  h.clock.advance(SHELL_TIMEOUT_MS - 1);
  assert.equal(await state(nav.response), 'pending', 'the network still gets its full window');
  h.clock.advance(1);
  const s = await state(nav.response);
  assert.notEqual(s, 'pending', 'lie-fi must fall back to the cached shell once the timeout passes');
  assert.equal(await s.v.text(), A.html);

  // The fetch lands later with a new deploy: the background update (under
  // waitUntil) replaces the shell and prunes against the NEW shell.
  const B = deploy(h, 'B');
  assert.equal(h.net.pending.length, 1);
  h.net.pending[0].resolve(h.net.respond('/'));
  await nav.settled();
  const stored = await (await h.caches.open(shellName(h))).match('/');
  assert.equal(await stored.text(), B.html);
});

test('F85: with NO cached shell, a hung network is waited on — never a timeout to nothing', async () => {
  const h = createHarness();
  const A = deploy(h, 'A');
  const w = h.loadWorker(SW); // never installed: no shell cached
  h.net.mode = 'hang';
  const nav = w.fetch('/', { mode: 'navigate' });
  await flush();
  h.clock.advance(SHELL_TIMEOUT_MS * 10);
  assert.equal(await state(nav.response), 'pending');
  h.net.pending[0].resolve(h.net.respond('/'));
  assert.equal(await bodyOf(nav.response), A.html);
});

test('F85: offline with a cached shell answers at once (no timer wait)', async () => {
  const h = createHarness();
  const A = deploy(h, 'A');
  const w = await freshWorker(h);
  h.net.mode = 'offline';
  const nav = w.fetch('/', { mode: 'navigate' });
  const s = await state(nav.response);
  assert.notEqual(s, 'pending', 'a rejected fetch must not wait out the timeout');
  assert.equal(await s.v.text(), A.html);
  assert.equal(h.clock.pendingCount(), 0, 'no timer left behind');
});

test('F85: a fast network answer wins the race and leaves no timer', async () => {
  const h = createHarness();
  deploy(h, 'A');
  const w = await freshWorker(h);
  const B = deploy(h, 'B');
  const nav = w.fetch('/', { mode: 'navigate' });
  assert.equal(await bodyOf(nav.response), B.html);
  await nav.settled();
  assert.equal(h.clock.pendingCount(), 0);
});

test('F85: a non-ok navigation response is returned but never becomes the offline shell', async () => {
  const h = createHarness();
  const A = deploy(h, 'A');
  const w = await freshWorker(h);
  h.net.serve('/', 'upstream error', 'text/html', 500);
  const nav = w.fetch('/', { mode: 'navigate' });
  const res = await nav.response;
  assert.equal(res.status, 500);
  await nav.settled();
  const stored = await (await h.caches.open(shellName(h))).match('/');
  assert.equal(await stored.text(), A.html);
});

// --- F86 --------------------------------------------------------------------

test('F86: across 45 deploys the prune never evicts an asset the live shell references', async () => {
  assert.ok(MAX_ASSET_ENTRIES > 0, 'MAX_ASSET_ENTRIES must be readable from sw.js');
  const h = createHarness();
  deploy(h, 'd0');
  const w = await freshWorker(h);
  // A stray non-/assets entry in the asset cache: the prune must never touch it.
  await (await h.caches.open('assets')).put('/fonts/stray.woff2', new Response('stray'));

  for (let d = 1; d <= 45; d++) {
    const D = deploy(h, `d${d}`);
    // The launch opens the import modal too, so a lazy chunk lands each deploy.
    const { got } = await launch(w, [D.lazy]);
    for (const p of D.assets) assert.notEqual(got[p], 'ERR', `deploy ${d}: ${p} failed online`);
    const assets = h.caches.peek('assets');
    for (const p of D.assets) assert.ok(assets.has(p), `deploy ${d}: live-shell asset ${p} was evicted`);
    const unreferenced = assets.paths().filter(p => p.startsWith('/assets/') && !D.assets.includes(p));
    // The prune runs at navigation, before this launch's own lazy chunk lands.
    assert.ok(unreferenced.length <= MAX_ASSET_ENTRIES + 1, `deploy ${d}: ${unreferenced.length} unreferenced entries`);
    assert.ok(assets.has('/fonts/stray.woff2'), 'non-/assets keys are never pruned');
  }
  // The byte-stable chunks were downloaded ONCE in 45 deploys.
  assert.equal(h.net.calls.get('/assets/vendor-react-STABLE.js'), 1);
  assert.equal(h.net.calls.get('/assets/rolldown-runtime-STABLE.js'), 1);
});

test('F86: the prune still caps unreferenced entries (old deploys do go)', async () => {
  const h = createHarness();
  deploy(h, 'd0');
  const w = await freshWorker(h);
  for (let d = 1; d <= 30; d++) {
    const D = deploy(h, `d${d}`);
    await launch(w, [D.lazy]);
  }
  const assets = h.caches.peek('assets');
  assert.ok(!assets.has('/assets/index-d1.js'), 'the oldest deploy\'s entry chunk was pruned');
  const unreferenced = assets.paths().filter(p => !p.includes('-d30.') && !p.includes('STABLE'));
  assert.ok(unreferenced.length <= MAX_ASSET_ENTRIES + 1);
});

// --- F45 --------------------------------------------------------------------

test('F45: an /assets/* miss answered with HTML or a 404 is returned but never cached', async () => {
  const h = createHarness();
  deploy(h, 'A');
  const w = await freshWorker(h);
  // The pre-fix rewrite: a dead chunk came back as index.html with a 200.
  h.net.serve('/assets/CsvImport-OLD.js', '<!doctype html><html></html>', 'text/html; charset=utf-8');
  const ev = w.fetch('/assets/CsvImport-OLD.js');
  assert.equal((await ev.response).status, 200);
  assert.equal(cachedAnywhere(h, '/assets/CsvImport-OLD.js'), false, 'HTML must never be cached under a .js URL');
  // The post-fix rewrite: a 404.
  const gone = w.fetch('/assets/SimpleFinConnect-OLD.js');
  assert.equal((await gone.response).status, 404);
  assert.equal(cachedAnywhere(h, '/assets/SimpleFinConnect-OLD.js'), false);
});
