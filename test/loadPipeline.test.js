// The Dashboard's load/refresh pipeline: reloadData / reloadViewed / fetchData
// and the fetchData effect (App.jsx's foreground-return refreshTick lands
// there). Dashboard is a component nothing in Node can mount, and these
// failures are SILENT on every surface — a spinner that never comes down, an
// old month's totals under the new month's header — so this is a SOURCE-SCAN
// pin in the test/invalidationMatrix.test.js mold: comments stripped (the
// reasoning next to the code names the very calls these scans look for), and
// every slice anchored on a declaration string that fails loudly if it moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = readFileSync(join(root, 'src', 'components', 'Dashboard.jsx'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const code = stripComments(dashboard);

// From one declaration anchor to the next — the anchors are consecutive
// declarations in the file, so the slice is exactly one callback's body.
function slice(fromAnchor, toAnchor) {
  const start = code.indexOf(fromAnchor);
  assert.notEqual(start, -1, `fixture assumption: "${fromAnchor}" exists — update this test's anchor`);
  const end = code.indexOf(toAnchor, start + fromAnchor.length);
  assert.ok(end > start, `fixture assumption: "${toAnchor}" follows "${fromAnchor}"`);
  return { start, end, body: code.slice(start, end) };
}
const RELOAD = ['const reloadData=useCallback', 'const reloadViewed=useCallback'];
const VIEWED = ['const reloadViewed=useCallback', 'const fetchData=useCallback'];
const FETCH = ['const fetchData=useCallback', 'const refreshNow=useCallback'];

// --- F03: the load that WINS loadSeq owns the spinner ------------------------
// fetchData raises `loading`; the clear used to be fetchData's own, gated on
// ITS reload winning. Any newer reloadData (the startup pull's follow-up, a
// post-write reload) superseded it and never cleared the flag, so the Home
// tiles stayed skeletons and Refresh/pull-to-refresh stayed disabled.

test('reloadData clears loading right after each loadSeq guard it survives', () => {
  const { body } = slice(...RELOAD);
  const guards = body.match(/if\(seq!==loadSeq\.current\)return false;/g) || [];
  assert.equal(guards.length, 2, 'fixture assumption: one guard on the success path, one on the catch');
  const owned = body.match(/if\(seq!==loadSeq\.current\)return false;\s*setLoading\(false\);/g) || [];
  assert.equal(owned.length, 2,
    'both the success and the catch path must setLoading(false) once the seq check passes — the winning load owns the spinner');
});

test('fetchData no longer clears loading on behalf of its own (possibly superseded) reload', () => {
  const { body } = slice(...FETCH);
  assert.ok(body.includes('setLoading(true)'), 'fetchData still raises the spinner');
  assert.ok(!body.includes('setLoading(false)'),
    'a clear gated on fetchData\'s own reload winning is the stuck-spinner bug — reloadData clears it');
});

// --- F04: post-await reloads read the month on screen NOW -------------------
// Every write path awaited something (a write, a forced re-sync) and then
// reloaded the render-closure year/month; a month tap in that window minted
// the newest loadSeq for the OLD month, which won and painted its totals and
// rows under the new month's header.

test('no reload is keyed on the render-closure year/month', () => {
  assert.ok(!/reloadData\(year,month\)/.test(code),
    'reloadData(year,month) after an await reloads the month that WAS on screen — use reloadViewed()');
});

test('reloadViewed reads monthRef and is the only reload besides fetchData\'s own first load', () => {
  const viewed = slice(...VIEWED);
  assert.ok(/monthRef\.current/.test(viewed.body), 'reloadViewed must read the committed month (monthRef)');
  const fetch = slice(...FETCH);
  const calls = [...code.matchAll(/\breloadData\(/g)].map(m => m.index);
  assert.ok(calls.length >= 2, 'fixture assumption: reloadData is called');
  for (const i of calls) {
    const inViewed = i > viewed.start && i < viewed.end;
    const inFetch = i > fetch.start && i < fetch.end;
    assert.ok(inViewed || inFetch,
      `a reloadData( call outside reloadViewed/fetchData (at offset ${i}) — post-await reloads go through reloadViewed()`);
  }
  // fetchData's first load is the one reload that legitimately takes the
  // caller's y/m (the effect just committed it); exactly one call there.
  assert.equal((fetch.body.match(/\breloadData\(/g) || []).length, 1,
    'fetchData calls reloadData once (its first load); the follow-up goes through reloadViewed()');
  assert.ok(fetch.body.includes('reloadViewed()'), 'the sync follow-up reloads through reloadViewed()');
});

// --- F11: "current month" is decided with a FRESH date ------------------------
// reloadData is a []-dep useCallback, so a render-time `now` in its body is
// the FIRST render's date forever. A PWA or laptop tab left open across a
// month end then treated the new month as past (no overview: the balance
// tile and "vs last month" read "—") and the old month as current (comparing
// it against itself). Wave A #12's "take a fresh date inside the load".

test('reloadData takes a fresh date, never the mount-time `now`', () => {
  const { body } = slice(...RELOAD);
  assert.ok(/new Date\(\)/.test(body), 'reloadData must construct its own Date for the current-month test');
  assert.ok(!/\bnow\./.test(body),
    'a `now.` read inside the []-dep reloadData is the mount-time date — stale after a month rollover');
});
