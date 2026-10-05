// The Dashboard's load/refresh pipeline: reloadData / reloadViewed / fetchData
// and the fetchData effect (App.jsx's foreground-return refreshTick lands
// there). Two halves:
//  - BEHAVIOR: the pipeline's decisions live in src/loadPipeline.js (pure) —
//    which effect run pulls and drops the lazy caches (refreshTickPlan), what
//    a settled pull earns (pullFollowUp), and the capped `refreshing` hold
//    (createSyncHold) — and are unit-tested here as decision tables.
//  - WIRING: Dashboard is a component nothing in Node can mount, and these
//    failures are SILENT on every surface — a spinner that never comes down,
//    an old month's totals under the new month's header — so the rest is a
//    SOURCE-SCAN pin in the test/invalidationMatrix.test.js mold: comments
//    stripped (the reasoning next to the code names the very calls these
//    scans look for), and every slice anchored on a declaration string that
//    fails loudly if it moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refreshTickPlan, pullFollowUp, createSyncHold, SYNC_HOLD_CAP_MS, feedHealthVerdict, FEED_STALE_MS } from '../src/loadPipeline.js';

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

// --- F13: a failed explicit Refresh still says so ----------------------------
// The runSync catch paints the banner, but on sync:"refresh" a failed pull
// still earns the follow-up reload, whose FIRST statement is setError(null) —
// in the same tick, so React never painted the banner and cached numbers read
// as current exactly when the user asked for fresh ones.

test('the sync-failure copy lives in ONE constant', () => {
  assert.equal((code.match(/Bank sync failed/g) || []).length, 1,
    'the banner text must be defined once (SYNC_FAILED_MSG) so the catch and the re-assert cannot drift');
  assert.match(code, /const SYNC_FAILED_MSG="Bank sync failed\. Showing cached data\.";/);
});

test('fetchData re-asserts the sync-failure banner after the follow-up reload of a failed pull', () => {
  const { body } = slice(...FETCH);
  const follow = body.indexOf('await reloadViewed()');
  assert.ok(follow > 0, 'fixture assumption: the follow-up reload goes through reloadViewed');
  assert.ok(body.slice(0, follow).includes('SYNC_FAILED_MSG'), 'the runSync catch paints the banner');
  assert.match(body.slice(0, follow), /const next=pullFollowUp\(sync,res\);\s*if\(next\.reload\)\{/,
    'the follow-up reload runs exactly when pullFollowUp says so');
  assert.match(body.slice(follow), /if\(next\.reassertError&&live!==false\)setError\([^;]*SYNC_FAILED_MSG/,
    'after the follow-up reload (which cleared the error), a failed Refresh must set the banner again');
});

test('pullFollowUp: a failed explicit Refresh still reloads, then re-asserts the banner', () => {
  assert.deepEqual(pullFollowUp('refresh', null), { reload: true, reassertError: true, bumpExpected: true });
  // A Refresh that pulled (or was merely throttled) has no failure to show.
  for (const res of [{ results: [{ institution: 'a' }] }, { results: [{ skipped: 'throttled' }] }, { results: [] }]) {
    const next = pullFollowUp('refresh', res);
    assert.equal(next.reload, true, 'the explicit Refresh always earns its fresh read');
    assert.equal(next.reassertError, false, `no banner for ${JSON.stringify(res)}`);
  }
});

// --- F17: the Budget tab's typed income is MONTH-TAGGED ----------------------
// Its siblings (actualInc, envelopes) carry their month; `income` did not, so
// a transient getBudgetIncome failure after paging — or an envelope write
// settling after a month tap, which supersedes the reload's envelope-state
// commit — left the PREVIOUS month's figure feeding Ready to Assign.

test('every setIncome commit carries the month it was read for', () => {
  const calls = [...code.matchAll(/\bsetIncome\(/g)];
  assert.ok(calls.length >= 2, 'fixture assumption: reloadData and doEnvelopeWrite both commit income');
  for (const m of calls) {
    const arg = code.slice(m.index, code.indexOf(';', m.index));
    assert.match(arg, /^setIncome\(\{\.\.\.\w+,y(:\w+)?,m(:\w+)?\}\)/,
      `setIncome must commit {...inc,y,m} — an untagged figure renders under whatever month is viewed: ${arg}`);
  }
});

test('the income state is read only through the month-checked accessor', () => {
  const def = /const incomeForMonth=income&&income\.y===year&&income\.m===month\?income:null;/;
  assert.match(code, def, 'incomeForMonth must reject a figure tagged for another month');
  const defLine = code.match(def)[0];
  const stripped = code.replace(defLine, '');
  assert.doesNotMatch(stripped, /(?<![.\w])income\??\.\w/,
    'a raw income./income?. read bypasses the month tag — read incomeForMonth instead');
});

test('an envelope write that lands after a month tap re-reads the viewed month\'s income too', () => {
  const { body } = slice('async function doEnvelopeWrite', 'const saveBudget=');
  const elseBranch = body.slice(body.indexOf('}else{'));
  assert.ok(elseBranch.includes('getEnvelopes('), 'fixture assumption: the month-moved branch re-reads envelopes');
  assert.ok(elseBranch.includes('getBudgetIncome('),
    'the month-moved branch bumps envSeq, which makes the in-flight reload skip setIncome — it must re-read income itself');
});

// --- F15: an hour-plus foreground return re-pulls (quietly) ------------------
// The refreshTick re-run passed sync:false, so a PWA opened at 8am and
// foregrounded at 6pm re-read the DB but never pulled the day's charges, and
// a feed that broke at noon raised no banner (the status check sat behind
// syncFirst). The deferred item's one constraint: the hour-gated pull must
// NOT paint the sync-failure banner — the user didn't ask for it.

const EFFECT = ['const syncFirst=!didInitialSync.current', '},[year,month,ready,refreshTick,fetchData]'];

test('refreshTickPlan: only a foreground return over an hour after the last pull starts the quiet "foreground" sync', () => {
  // Startup always pulls (true — the loud mode: its failure paints the banner).
  assert.equal(refreshTickPlan({ syncFirst: true, tick: false, due: false }).sync, true);
  assert.equal(refreshTickPlan({ syncFirst: true, tick: true, due: true }).sync, true);
  // A foreground return: the hour gate decides, and the pull is QUIET.
  assert.equal(refreshTickPlan({ syncFirst: false, tick: true, due: true }).sync, 'foreground');
  assert.equal(refreshTickPlan({ syncFirst: false, tick: true, due: false }).sync, false);
  // Plain month navigation never pulls, however long ago the last pull was.
  assert.equal(refreshTickPlan({ syncFirst: false, tick: false, due: true }).sync, false);
});

test('the effect asks refreshTickPlan with the hour gate and runs fetchData on its plan', () => {
  const { body } = slice(...EFFECT);
  assert.match(body,
    /const \{sync,invalidate,bumpExpectedNow\}=refreshTickPlan\(\{syncFirst,tick,\s*due:foregroundSyncDue\(lastSyncAt\.current,Date\.now\(\)\)\}\);/,
    'the effect must ask the pure plan, with the hour gate fed the last pull\'s start time');
  assert.ok(body.indexOf('refreshTickPlan(') < body.indexOf('fetchData('), 'the plan is made before fetchData runs');
  assert.match(body, /fetchData\(year,month,\{sync,invalidate\}\)/, 'fetchData runs the planned sync mode and cache drop');
  const { body: fetch } = slice(...FETCH);
  assert.match(fetch, /if\(sync\)\{?lastSyncAt\.current=Date\.now\(\)/,
    'every pull fetchData starts (startup, Refresh, foreground) restarts the hour');
});

test('a failed foreground pull never paints the sync-failure banner', () => {
  const { body } = slice(...FETCH);
  assert.match(body, /if\(sync!=="foreground"\)setError\(SYNC_FAILED_MSG\)/,
    'the runSync catch must skip the banner for the quiet foreground pull');
  // ...and nothing after it puts the banner back: a failed (null) pull earns
  // the follow-up and its re-assert on the explicit Refresh only.
  for (const sync of [true, 'foreground']) {
    const next = pullFollowUp(sync, null);
    assert.equal(next.reload, false, `a failed ${sync} pull wrote nothing — no follow-up reload`);
    assert.equal(next.reassertError, false, `a failed ${sync} pull re-asserts nothing`);
  }
});

// --- pullFollowUp: what a settled pull earns ---------------------------------
// res shapes runSync resolves with (src/sync.js pullWasClean lists them), plus
// null for a rejected pull (fetchData's catch maps it).
const REAL = { results: [{ institution: 'a' }] };
const MIXED = { results: [{ skipped: 'throttled' }, { institution: 'b' }] };
const THROTTLED = { results: [{ skipped: 'throttled' }] };
const NO_URL = { results: [] };

test('pullFollowUp: only a real pull earns the follow-up reload — except the explicit Refresh', () => {
  for (const sync of [true, 'foreground']) {
    assert.equal(pullFollowUp(sync, REAL).reload, true, `${sync}: a real pull wrote rows`);
    assert.equal(pullFollowUp(sync, MIXED).reload, true, `${sync}: one real bank in a throttled set still wrote rows`);
    for (const res of [THROTTLED, NO_URL, null]) {
      assert.equal(pullFollowUp(sync, res).reload, false, `${sync}: ${JSON.stringify(res)} wrote nothing`);
    }
  }
  for (const res of [REAL, MIXED, THROTTLED, NO_URL, null]) {
    assert.equal(pullFollowUp('refresh', res).reload, true, `refresh: ${JSON.stringify(res)} still reloads`);
  }
});

test('pullFollowUp: the auto-match re-runs after every follow-up, and after ANY settle of a foreground pull', () => {
  for (const res of [REAL, MIXED]) {
    for (const sync of [true, 'refresh', 'foreground']) {
      assert.equal(pullFollowUp(sync, res).bumpExpected, true, `${sync}: the pulled rows may match a bill`);
    }
  }
  for (const res of [THROTTLED, NO_URL, null]) {
    // The foreground return deferred its pass to this settle — it must run.
    assert.equal(pullFollowUp('foreground', res).bumpExpected, true, `foreground: ${JSON.stringify(res)}`);
    // The startup pass already ran at mount, against the same rows.
    assert.equal(pullFollowUp(true, res).bumpExpected, false, `startup: ${JSON.stringify(res)}`);
  }
});

test('one foreground return runs exactly ONE auto-match pass, whatever its pull does', () => {
  // The F12 overlap: the refreshTick branch bumped the epoch AND the pull's
  // follow-up bumped it again — a pre-pull pass plus a post-pull one, each
  // writing matches and roll-forwards, possibly overlapping.
  for (const due of [false, true]) {
    const plan = refreshTickPlan({ syncFirst: false, tick: true, due });
    const settles = plan.sync ? [REAL, MIXED, THROTTLED, NO_URL, null] : [undefined];
    for (const res of settles) {
      const passes = (plan.bumpExpectedNow ? 1 : 0) + (plan.sync ? (pullFollowUp(plan.sync, res).bumpExpected ? 1 : 0) : 0);
      assert.equal(passes, 1, `due=${due} res=${JSON.stringify(res)}: ${passes} passes`);
    }
  }
  // Plain month navigation runs none (the epoch is already consumed).
  assert.equal(refreshTickPlan({ syncFirst: false, tick: false, due: true }).bumpExpectedNow, false);
});

test('the effect bumps the auto-match epoch only on the plan\'s say-so, and fetchData only on pullFollowUp\'s', () => {
  const { body } = slice(...EFFECT);
  const bumps = body.match(/[^;{}]*setExpEpoch\(/g) || [];
  assert.deepEqual(bumps.map(b => b.trim()), ['if(bumpExpectedNow)setExpEpoch('],
    'one bump in the effect, gated on refreshTickPlan — an ungated one is the second, pre-pull pass');
  const { body: fetch } = slice(...FETCH);
  const fbumps = fetch.match(/[^;{}]*setExpEpoch\(/g) || [];
  assert.deepEqual(fbumps.map(b => b.trim()), ['if(next.bumpExpected)setExpEpoch('],
    'one bump in fetchData, gated on pullFollowUp — it must also fire on a throttled/failed foreground settle');
});

test('feed health is re-checked after any effect-started pull, and a healthy answer clears the banner', () => {
  const { body } = slice(...EFFECT);
  assert.ok(body.includes('getSimpleFinStatus()'), 'fixture assumption: the status check lives in the effect');
  assert.ok(!/if\(!syncFirst\)return;/.test(body),
    'gating the status check on syncFirst alone means a foreground pull never re-checks feed health');
  assert.match(body, /getSimpleFinStatus\(\)\.then\(s=>setFeedHealth\(feedHealthVerdict\(s,Date\.now\(\)\)\)\)/,
    'every status answer replaces the banner through feedHealthVerdict — no early return that skips the set');
});

test('feedHealthVerdict: an error or a stale pull raises the banner; healthy clears it', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const fresh = new Date(now - 3_600_000).toISOString();
  const old = new Date(now - FEED_STALE_MS - 60_000).toISOString();
  assert.equal(FEED_STALE_MS, 3 * 86_400_000, 'three days without a pull is stale');
  assert.deepEqual(feedHealthVerdict({ connected: true, last_pulled_at: fresh, last_error: 'bank asked to re-authenticate' }, now),
    { last_pulled_at: fresh, last_error: 'bank asked to re-authenticate' });
  assert.deepEqual(feedHealthVerdict({ connected: true, last_pulled_at: old, last_error: null }, now),
    { last_pulled_at: old, last_error: null });
  assert.equal(feedHealthVerdict({ connected: true, last_pulled_at: fresh, last_error: null }, now), null);
  // No watermark yet and no error: nothing to say (an unparseable date neither).
  assert.equal(feedHealthVerdict({ connected: true, last_pulled_at: null, last_error: null }, now), null);
  assert.equal(feedHealthVerdict({ connected: true, last_pulled_at: 'not a date', last_error: null }, now), null);
});

test('REGRESSION: feedHealthVerdict clears the banner once the feed is no longer connected', () => {
  // The re-check used to `return` on !connected BEFORE setting anything, so a
  // banner an earlier check raised stayed up after a disconnect until the
  // next app load. A disconnected feed has nothing left to be unhealthy.
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(feedHealthVerdict({ connected: false }, now), null);
  assert.equal(feedHealthVerdict({ connected: false, migration_pending: true }, now), null);
  assert.equal(feedHealthVerdict({ connected: false, last_error: 'stale error from before' }, now), null);
});

// --- F72: the refresh spinners last until the bank pull settles --------------
// `loading` drops after the first (cache) read, while the pull a Refresh
// started is still running; the pull chip and the gear's spinner settled on
// it, and the pulled rows painted seconds later with no signal.

test('fetchData holds `refreshing` for the whole pull, released in a finally', () => {
  const { body } = slice(...FETCH);
  assert.match(body, /const release=sync\?holdRefreshing\(\):null;/,
    'a pull takes a hold on refreshing (counted — the startup pull and a Refresh can overlap)');
  assert.match(body, /finally\{\s*release\?\.\(\);\s*\}/,
    'the release must ride a finally (every early return included)');
  assert.ok(body.indexOf('holdRefreshing()') < body.indexOf('runSync('), 'refreshing is raised before the pull starts');
  assert.match(code, /const \[holdRefreshing\]=useState\(\(\)=>createSyncHold\(setRefreshing\)\);/,
    'ONE hold for the component\'s life, on the default (capped) createSyncHold');
  assert.ok(!/setRefreshing\(/.test(code),
    'refreshing moves only through the hold — a direct setRefreshing has no cap and can strand the controls');
});

// --- createSyncHold: the counted, capped `refreshing` flag -------------------
function harness() {
  const busy = [];
  const timers = new Map();
  let id = 0;
  const hold = createSyncHold(v => busy.push(v), {
    capMs: 1000,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: t => { timers.delete(t); },
  });
  const fire = t => { const x = timers.get(t); assert.ok(x, `timer ${t} is pending`); timers.delete(t); x.fn(); };
  return { busy, timers, hold, fire, last: () => busy[busy.length - 1] };
}

test('createSyncHold: one hold raises the flag and its release drops it, once', () => {
  const h = harness();
  const release = h.hold();
  assert.equal(h.last(), true);
  release();
  assert.equal(h.last(), false);
  assert.equal(h.timers.size, 0, 'a release clears its own cap timer');
  release();
  assert.deepEqual(h.busy, [true, false], 'a second release is a no-op');
});

test('createSyncHold: overlapping holds keep the flag up until the LAST lets go', () => {
  const h = harness();
  const a = h.hold();
  const b = h.hold();
  a();
  assert.equal(h.last(), true, 'the startup pull settling must not stop a Refresh still pulling');
  a();
  assert.equal(h.last(), true, 'a repeated release cannot release someone else\'s hold');
  b();
  assert.equal(h.last(), false);
});

test('createSyncHold: a hold that never settles lets go by itself at the cap', () => {
  const h = harness();
  const hung = h.hold();
  assert.equal([...h.timers.values()][0].ms, 1000, 'the cap timer runs for capMs');
  h.fire([...h.timers.keys()][0]);
  assert.equal(h.last(), false, 'a hung pull no longer disables Refresh and pull-to-refresh');
  // The hung pull settling much later is harmless, and the next hold works.
  hung();
  assert.deepEqual(h.busy, [true, false]);
  const next = h.hold();
  assert.equal(h.last(), true);
  hung();
  assert.equal(h.last(), true, 'the old hold\'s late release cannot drop the new hold');
  next();
  assert.equal(h.last(), false);
});

test('createSyncHold: a capped hold and a live one — the live one still owns the flag', () => {
  const h = harness();
  h.hold();
  const live = h.hold();
  h.fire([...h.timers.keys()][0]);
  assert.equal(h.last(), true, 'one hold capped out; the other pull is still running');
  live();
  assert.equal(h.last(), false);
});

test('createSyncHold: the default cap is a minute, on the real timers', () => {
  assert.equal(SYNC_HOLD_CAP_MS, 60_000);
  const busy = [];
  const release = createSyncHold(v => busy.push(v))();
  release();   // clears the real timer — the test process must not wait a minute
  assert.deepEqual(busy, [true, false]);
});

test('the pull chip, its gate and the gear\'s Refresh read loading||refreshing; page skeletons stay on loading', () => {
  assert.match(code, /<PullRefresh blocked=\{anySheetOpen\|\|loading\|\|refreshing\} loading=\{loading\|\|refreshing\}/,
    'PullRefresh settles its chip (and re-arms) only once the pull it started has finished');
  assert.match(code, /<GearMenu[^>]*loading=\{loading\|\|refreshing\}/,
    'the gear\'s Refresh row spins and stays disabled until the pull settles');
});

// --- F54: async writers outside their effects keep the effects' guards -------
// refetchOpenLists (after teaching a merchant rule) wrote searchRes and
// acctTxs with no sequence/id check, after several round trips: open account
// B meanwhile and A's rows landed under B's header; type a new query and the
// old query's page clobbered it. The Debt load set its snapshot and net-worth
// series OUTSIDE its debtSeq check, so a superseded load could overwrite a
// newer one's chart data.

test('refetchOpenLists writes search results only for the query it was asked about', () => {
  const { body } = slice('const refetchOpenLists=useCallback', 'async function learnMerchant');
  assert.match(body, /^const refetchOpenLists=useCallback\(async\(sid=searchSeq\.current\)=>/,
    'refetchOpenLists takes the searchSeq its caller captured (default: now)');
  assert.match(body, /if\(searchSeq\.current===sid\)setSearchRes\(/,
    'a query typed since (which bumps searchSeq) must win over this refetch');
  assert.ok(!/\bthen\(setSearchRes\)/.test(body), 'no unguarded .then(setSearchRes)');
  const { body: learn } = slice('async function learnMerchant', 'function patchAllTxLists');
  const cap = learn.indexOf('const sid=searchSeq.current');
  assert.ok(cap > 0 && cap < learn.indexOf('await '),
    'learnMerchant captures searchSeq BEFORE its first await — the query its closure holds is the one at that moment');
  assert.ok(learn.includes('refetchOpenLists(sid)'), 'and hands it to refetchOpenLists');
});

test('refetchOpenLists refetches the account open NOW and writes only if it is still open', () => {
  const { body } = slice('const refetchOpenLists=useCallback', 'async function learnMerchant');
  assert.match(body, /const aid=selAcctIdRef\.current;/,
    'read the committed open account at refetch time, never the closure\'s selAcct');
  assert.ok(!/\bselAcct\b/.test(body), 'no selAcct snapshot read inside refetchOpenLists');
  assert.match(body, /if\(selAcctIdRef\.current===aid\)\{?setAcctTxs\(/,
    'an account page switched while the fetch ran must not receive the old account\'s rows');
  assert.match(code, /selAcctIdRef\.current=selAcctId;/, 'the ref mirrors the committed selAcctId');
});

test('the Debt load commits snapshots, the net-worth series and the debts together under debtSeq', () => {
  const { body } = slice('if(tab!=="debt"||debtData)return;', '},[tab,debtData,debtEpoch]);');
  const guard = 'if(seq===debtSeq.current){';
  const open = body.indexOf(guard);
  assert.ok(open > 0, 'the success path commits inside one debtSeq-guarded block');
  const block = body.slice(open, body.indexOf('}', open + guard.length));
  const outside = body.slice(0, open) + body.slice(open + block.length);
  for (const set of ['setDebtSnaps(', 'setNwSeries(', 'setDebtData(d)']) {
    assert.ok(block.includes(set), `${set} must be inside the debtSeq-guarded commit`);
  }
  for (const set of ['setDebtSnaps(', 'setNwSeries(']) {
    assert.ok(!outside.includes(set), `${set} outside the guard lets a superseded load overwrite a newer one`);
  }
});
