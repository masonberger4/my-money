// F45 — a stale lazy chunk after a deploy. The pure core (withChunkReload)
// reloads the app ONCE, guarded by a sessionStorage flag, and the call sites
// are pinned by source scan: every lazy() in src/ goes through the helper, and
// every lazy MODAL renders inside LazyModal's scoped boundary, so a second
// failure can't reach App's boundary and blank the whole Dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { withChunkReload, CHUNK_RELOAD_KEY } from '../src/lazyWithReload.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    has: k => m.has(k),
  };
}

// Resolves to 'pending' when the promise hasn't settled after the microtask
// queue drains — how a never-settling post-reload promise is observed.
async function settleState(p) {
  const marker = Symbol('pending');
  const r = await Promise.race([
    p.then(v => ({ v }), e => ({ e })),
    new Promise(res => setImmediate(() => res(marker))),
  ]);
  return r === marker ? 'pending' : r;
}

test('a successful import resolves the module and clears the reload flag', async () => {
  const store = memStore({ [CHUNK_RELOAD_KEY]: '1' });
  let reloads = 0;
  const mod = { default: () => null };
  const load = withChunkReload(() => Promise.resolve(mod), { storage: () => store, reload: () => reloads++ });
  assert.equal(await load(), mod);
  assert.equal(store.has(CHUNK_RELOAD_KEY), false, 'a load that worked re-arms the one reload');
  assert.equal(reloads, 0);
});

test('the first failure sets the flag, reloads once, and never settles', async () => {
  const store = memStore();
  let reloads = 0;
  const err = new TypeError('Failed to fetch dynamically imported module');
  const load = withChunkReload(() => Promise.reject(err), { storage: () => store, reload: () => reloads++ });
  const state = await settleState(load());
  assert.equal(state, 'pending', 'Suspense keeps its fallback up until the page goes away');
  assert.equal(reloads, 1);
  assert.equal(store.getItem(CHUNK_RELOAD_KEY), '1');
});

test('a failure with the flag already set rethrows and does NOT reload (no loop)', async () => {
  const store = memStore({ [CHUNK_RELOAD_KEY]: '1' });
  let reloads = 0;
  const err = new TypeError('Importing a module script failed.');
  const load = withChunkReload(() => Promise.reject(err), { storage: () => store, reload: () => reloads++ });
  await assert.rejects(load(), e => e === err);
  assert.equal(reloads, 0);
});

test('unreadable storage rethrows with no reload — a guard it cannot record must not loop', async () => {
  const err = new Error('chunk 404');
  for (const storage of [
    () => { throw new DOMException('denied', 'SecurityError'); },
    () => null,
    () => ({ getItem: () => { throw new Error('nope'); }, setItem() {}, removeItem() {} }),
    () => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} }),
  ]) {
    let reloads = 0;
    const load = withChunkReload(() => Promise.reject(err), { storage, reload: () => reloads++ });
    await assert.rejects(load(), e => e === err);
    assert.equal(reloads, 0);
  }
});

test('a success after a throwing storage still returns the module', async () => {
  const mod = { default: 1 };
  const load = withChunkReload(() => Promise.resolve(mod), { storage: () => { throw new Error('x'); }, reload() {} });
  assert.equal(await load(), mod);
});

// --- call-site pins ---------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|jsx)$/.test(full)) out.push(full);
  }
  return out;
}

test('every lazy() in src/ goes through lazyWithReload', () => {
  const offenders = [];
  let wrapped = 0;
  for (const file of walk(join(root, 'src'))) {
    const rel = relative(root, file);
    if (rel === join('src', 'lazyWithReload.js')) continue;
    const text = readFileSync(file, 'utf8');
    if (/\blazy\s*\(/.test(text)) offenders.push(rel); // React.lazy( too
    wrapped += (text.match(/lazyWithReload\(\s*\(\)\s*=>\s*import\(/g) || []).length;
  }
  assert.deepEqual(offenders, [], `bare React.lazy — a stale chunk after a deploy would not reload:\n${offenders.join('\n')}`);
  assert.ok(wrapped >= 4, `expected the four lazy call sites to use lazyWithReload (found ${wrapped})`);
});

test('every lazy modal renders inside LazyModal, never a bare Suspense', () => {
  const sites = [
    ['src/components/Dashboard.jsx', 'CsvImport'],
    ['src/components/Dashboard.jsx', 'SimpleFinConnect'],
    ['src/components/AddAccount.jsx', 'SimpleFinConnect'],
  ];
  for (const [file, comp] of sites) {
    const text = read(file);
    assert.match(
      text,
      new RegExp(`<LazyModal\\b[^\\n]*onClose=[^\\n]*\\n\\s*<${comp}\\b`),
      `${file}: <${comp}> must sit directly inside <LazyModal onClose=…> so a failed load stays scoped to the modal`
    );
    assert.doesNotMatch(text, /<Suspense\b/, `${file}: a bare <Suspense> leaves a failed load to App's whole-screen boundary`);
  }
});

// The failed-load card is an overlay like any other, so it gets the overlay
// trio's Escape-to-close. The modal's own Escape handler can't stand in: it
// lives in the chunk that failed to load.
test('the failed-load card closes on Escape', () => {
  const text = read('src/components/ErrorBoundary.jsx');
  const start = text.indexOf('function ModalLoadFailed');
  assert.ok(start >= 0, 'ModalLoadFailed not found');
  const end = text.indexOf('\nexport function LazyModal', start);
  assert.ok(end > start, 'LazyModal must follow ModalLoadFailed');
  const body = text.slice(start, end);
  assert.match(body, /role="alertdialog"[^>]*aria-modal="true"/, 'dialog semantics');
  assert.match(body, /e\.key !== "Escape"\) return;\s*e\.stopImmediatePropagation\(\);\s*onClose\(\);/,
    'an Escape keydown must call onClose (and claim the press, one layer per press)');
  assert.match(body, /window\.addEventListener\("keydown", h\);/);
  assert.match(body, /return \(\) => window\.removeEventListener\("keydown", h\);\s*\}, \[onClose\]\);/,
    'the listener is torn down on close and re-registered with the current onClose');
});
