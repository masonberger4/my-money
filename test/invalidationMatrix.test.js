// The month-navigation caching invalidation matrix (Mason, 2026-08-04).
//
// Plain month switching reuses the dataAdapter's memoised rows (rangeMemo) and
// envelope spend sums (spendCache); the caches drop ONLY at the four moments
// transactions can actually have moved: a client write, a completed sync, a
// CSV/PDF import, and the explicit Refresh (which syncs). That contract lives
// across three files and none of it can be driven end-to-end from Node (the
// adapter's write paths need a real client and Dashboard is a component), so
// this is a SOURCE-SCAN pin — the lockstep.test.js / noPlaid.test.js
// precedent: the failure mode being guarded (a write path that leaves a warm
// cache serving pre-edit rows) is silent on every surface, which is exactly
// the class of failure this repo refuses to leave untested.
//
// The sync-hook MECHANISM is behaviorally tested in test/sync.test.js; this
// file pins the WIRING.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refreshTickPlan } from '../src/loadPipeline.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = readFileSync(join(root, 'src', 'dataAdapter.js'), 'utf8');
const dashboard = readFileSync(join(root, 'src', 'components', 'Dashboard.jsx'), 'utf8');
const sync = readFileSync(join(root, 'src', 'sync.js'), 'utf8');

// Comments mention the invalidator by name (deliberately — the reasoning
// should live next to the code), so scans that assert ABSENCE must look at
// code only.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Slice one `export (async) function NAME(...)` body out of the module: from
// its declaration to the next top-of-file export (or EOF). Coarse, but every
// scanned function is module-top-level, so the slice always CONTAINS the whole
// body — a containment assertion never false-passes on a shorter slice.
function exportedFunction(src, name) {
  const start = src.search(new RegExp(`^export (async )?function ${name}\\b`, 'm'));
  assert.notEqual(start, -1, `fixture assumption: ${name} is an exported function`);
  const rest = src.slice(start + 1);
  const next = rest.search(/^export /m);
  return src.slice(start, next === -1 ? src.length : start + 1 + next);
}

// --- dataAdapter: every write path that touches transactions/accounts --------

const WRITE_PATHS = [
  'updateTransaction', // recategorise / rename / exclude / tax fields
  'updateAccount', // hidden + type gate what the raw fetch returns & how rows classify
  'applyCategoryRuleToHistory', // learned rule rewrites mapped_category on old rows
  'importCsvTransactions', // CSV/PDF import inserts rows
  'addManualTransaction', // quick-add inserts a row
];

for (const name of WRITE_PATHS) {
  test(`write path ${name} invalidates the caches itself (reloadData no longer does)`, () => {
    const body = stripComments(exportedFunction(adapter, name));
    assert.ok(
      body.includes('invalidateEnvelopeSpending()'),
      `${name} must call invalidateEnvelopeSpending() — a warm rangeMemo/spendCache would serve pre-write rows to every tab`
    );
  });
}

test('invalidateEnvelopeSpending is the ONE invalidator: no bare rangeMemo.clear() anywhere else', () => {
  // A site that clears only the range memo strands spendCache on pre-edit
  // sums (or vice versa). Exactly one clear() call exists — inside the
  // invalidator itself.
  const code = stripComments(adapter);
  const clears = code.match(/rangeMemo\.clear\(\)/g) || [];
  assert.equal(clears.length, 1, 'rangeMemo.clear() may appear only inside invalidateEnvelopeSpending');
  const invalidator = stripComments(exportedFunction(adapter, 'invalidateEnvelopeSpending'));
  assert.ok(invalidator.includes('rangeMemo.clear()'), 'the one clear() lives in the invalidator');
  assert.ok(invalidator.includes('spendCache.clear()'), 'the invalidator drops the spend sums (the whole range-keyed Map)');
  assert.ok(invalidator.includes('spendGen++'), 'the invalidator bumps the generation (in-flight fetch guard)');
});

// --- the sync completion wiring ----------------------------------------------

test('dataAdapter registers invalidateEnvelopeSpending as the sync completion hook', () => {
  const code = stripComments(adapter);
  assert.ok(
    /setSyncCompletionHook\(invalidateEnvelopeSpending\)/.test(code),
    'a completed sync (incl. the Refresh button and forced re-syncs) must drop the caches'
  );
});

test('sync.js notifies the hook from a finally — success AND failure paths', () => {
  const code = stripComments(sync);
  assert.ok(code.includes('setSyncCompletionHook'), 'sync.js exposes the registration');
  assert.ok(
    /finally\s*\{\s*notifySyncCompletion\(\);/.test(code),
    'the notification must ride a finally: a rejected pull may still have written rows server-side'
  );
});

// --- Dashboard: month navigation must NOT invalidate; server-side mutations must

test('reloadData no longer invalidates — plain month navigation reuses the caches', () => {
  const start = dashboard.indexOf('const reloadData=useCallback');
  const end = dashboard.indexOf('const fetchData=useCallback');
  assert.ok(start !== -1 && end > start, 'fixture assumption: reloadData precedes fetchData');
  const body = stripComments(dashboard.slice(start, end));
  assert.ok(
    !body.includes('invalidateEnvelopeSpending'),
    'reloadData must not call invalidateEnvelopeSpending — that call is what made every month tap refetch the whole envelope walk'
  );
});

test('the server-side mutations reloadData no longer covers invalidate at their call sites', () => {
  const code = stripComments(dashboard);
  // handleUnlink: the server hid/deleted the bank rows without a sync.
  const unlinkStart = code.indexOf('async function handleUnlink');
  assert.notEqual(unlinkStart, -1, 'fixture assumption: handleUnlink exists');
  const unlinkBody = code.slice(unlinkStart, code.indexOf('const cats=', unlinkStart));
  assert.ok(
    unlinkBody.includes('invalidateEnvelopeSpending()'),
    'handleUnlink must invalidate — the removed bank rows would otherwise keep counting out of a warm memo'
  );
  // The SimpleFIN modal's onConnected: permanent delete / disconnect mutate
  // server-side with NO sync, so the callback invalidates for all outcomes.
  const onConnected = code.indexOf('onConnected={()=>{');
  assert.notEqual(onConnected, -1, 'fixture assumption: onConnected is a block callback');
  const cbBody = code.slice(onConnected, code.indexOf('}}', onConnected));
  assert.ok(
    cbBody.includes('invalidateEnvelopeSpending()'),
    'onConnected must invalidate — permanent delete and disconnect run no sync'
  );
});

// --- Foreground return (review fix, 2026-08-04) -------------------------------
// App.jsx's visibilitychange/focus handler bumps refreshTick precisely for the
// stale-PWA case — ANOTHER device's writes (or the server sync landing rows
// via its session) while this screen was frozen. None of the four invalidation
// moments fire on THIS device for that, so the refreshTick-driven fetchData
// effect must drop the caches itself, or it replays the warm rangeMemo/
// spendCache while the un-memoised balance reads freshen (visible disagreement
// with no alarm anywhere — the silent class again).

test('the fetchData effect invalidates on a refreshTick bump (foreground return)', () => {
  const code = stripComments(dashboard);
  const start = code.indexOf('const syncFirst=!didInitialSync.current');
  assert.notEqual(start, -1, 'fixture assumption: the fetchData effect gates on didInitialSync');
  const body = code.slice(start, code.indexOf('},[year,month,ready,refreshTick,fetchData]', start));
  assert.ok(body.length > 0 && body.length < 4000, 'fixture assumption: effect body sliced');
  // Ref-compared: a tick CHANGE invalidates; plain month-nav re-runs must not.
  assert.ok(
    /refreshTick!==lastRefreshTick\.current/.test(body),
    'the effect must compare refreshTick against the last acted-on tick — invalidating unconditionally would defeat month-navigation cache reuse'
  );
  const guarded = body.slice(body.indexOf('refreshTick!==lastRefreshTick.current'));
  assert.ok(
    guarded.includes('invalidateEnvelopeSpending()'),
    'a changed refreshTick must drop the caches before fetchData, or the reload is served the pre-background rows from the warm memo'
  );
  assert.ok(
    guarded.indexOf('invalidateEnvelopeSpending()') < guarded.indexOf('fetchData('),
    'the invalidation must precede fetchData in the effect'
  );
});

test('lastRefreshTick is seeded with the mount-time tick (initial load does not invalidate)', () => {
  const code = stripComments(dashboard);
  assert.ok(
    /const lastRefreshTick=useRef\(refreshTick\)/.test(code),
    'seed the ref with the prop so only a subsequent bump — not mount — invalidates'
  );
});

test('App.jsx still bumps refreshTick on visibility return (the signal this wiring rides)', () => {
  const app = stripComments(readFileSync(join(root, 'src', 'App.jsx'), 'utf8'));
  assert.ok(app.includes('visibilitychange'), 'the foreground-return listener exists');
  assert.ok(/setRefreshTick\(t\s*=>\s*t\s*\+\s*1\)/.test(app), 'and it bumps the tick Dashboard consumes');
});

// --- Lists outside reloadData's reach on a pull / foreground return ----------
// Two lazily-loaded surfaces are epoch-driven and reloadData never touches
// them: the open account page's 500-row list (acctTxEpoch — not
// month-scoped, so a month tap must not refetch it) and the expected-bill
// auto-match pass (expEpoch — getExpectedTransactions runs the match). Both
// must move when rows may have arrived: after a real pull's follow-up reload
// and on a foreground return (the other phone's writes / its server sync).
// Before, the account page showed the new balance over stale rows (Wave C
// #20's foreground half), and the match pass ran once per session, racing
// the startup pull, so a bill that posted overnight stayed "due" all day.

function fetchEffectTickBranch() {
  const code = stripComments(dashboard);
  const start = code.indexOf('const syncFirst=!didInitialSync.current');
  assert.notEqual(start, -1, 'fixture assumption: the fetchData effect gates on didInitialSync');
  const body = code.slice(start, code.indexOf('},[year,month,ready,refreshTick,fetchData]', start));
  return body.slice(body.indexOf('refreshTick!==lastRefreshTick.current'));
}

test('a foreground return (refreshTick) refetches the open account list and re-runs the expected-bill match', () => {
  const guarded = fetchEffectTickBranch();
  const fetchAt = guarded.indexOf('fetchData(');
  const tickBranch = guarded.slice(guarded.indexOf('if(tick){'));
  const acct = tickBranch.indexOf('setAcctTxEpoch(');
  assert.ok(acct !== -1 && acct < tickBranch.indexOf('fetchData('),
    'the refreshTick branch must call setAcctTxEpoch(…) before fetchData — reloadData never refreshes that surface');
  // The auto-match pass: at once when this return does not pull, otherwise
  // after the pull settles (fetchData) — refreshTickPlan's bumpExpectedNow,
  // behavior-tested in test/loadPipeline.test.js. Never both.
  const exp = guarded.indexOf('if(bumpExpectedNow)setExpEpoch(');
  assert.ok(exp !== -1 && exp < fetchAt,
    'the effect must bump the expected epoch (gated on the plan) before fetchData');
});

test('a real pull\'s follow-up reload refetches the open account list and re-runs the expected-bill match', () => {
  const code = stripComments(dashboard);
  const start = code.indexOf('const fetchData=useCallback');
  const end = code.indexOf('const refreshNow=useCallback', start);
  assert.ok(start !== -1 && end > start, 'fixture assumption: fetchData precedes refreshNow');
  const body = code.slice(start, end);
  const followUp = body.indexOf('await reloadViewed()');
  assert.ok(followUp > 0, 'fixture assumption: the follow-up reload goes through reloadViewed');
  const after = body.slice(followUp);
  assert.ok(after.includes('setAcctTxEpoch('), 'the pull may have written rows onto the open account');
  assert.ok(after.includes('setExpEpoch('),
    'the auto-match pass must re-run against the pulled rows — the startup pass raced the pull');
});

// --- The lazy TAB caches survive plain month navigation (F92) ----------------
// Extends the 2026-08-04 ruling from the adapter memo to the Dashboard's lazy
// tab caches: Recurring (a ~40-month read anchored on TODAY), Debt (accounts +
// snapshots), Tax (its own taxYear) and Trends' cash flow (anchored on the
// CURRENT month) depend on no viewed month, yet every month tap dropped all
// four and re-ran the app's heaviest reads on the next visit. reloadData now
// takes {invalidate}: plain navigation passes false; startup, the foreground
// return, Refresh, a pull's follow-up and every post-write reload keep the
// default (true). Movers are month-tagged and refetch on their own.

const LAZY_DROPS = ['invalidateTax()', 'invalidateTrends()', 'setRecEpoch(', 'setDebtEpoch('];

test('reloadData drops the lazy tab caches only inside an if(invalidate) block', () => {
  const code = stripComments(dashboard);
  const start = code.indexOf('const reloadData=useCallback');
  const end = code.indexOf('const reloadViewed=useCallback', start);
  assert.ok(start !== -1 && end > start, 'fixture assumption: reloadData precedes reloadViewed');
  const body = code.slice(start, end);
  assert.match(body, /^const reloadData=useCallback\(async\(y,m,\{invalidate=true\}=\{\}\)=>/,
    'invalidate defaults to TRUE — every caller that says nothing (post-write reloads) keeps invalidating');
  const open = body.indexOf('if(invalidate){');
  assert.ok(open > 0, 'reloadData must gate the lazy-cache drops on invalidate');
  const close = body.indexOf('}', open + 'if(invalidate){'.length);
  const block = body.slice(open, close);
  const outside = body.slice(0, open) + body.slice(close);
  for (const drop of LAZY_DROPS) {
    assert.ok(block.includes(drop), `${drop} must sit inside if(invalidate){…}`);
    assert.ok(!outside.includes(drop), `${drop} must not ALSO run unconditionally`);
  }
});

test('only plain month navigation skips the drop: the effect invalidates on startup and on a refreshTick bump', () => {
  const code = stripComments(dashboard);
  const start = code.indexOf('const syncFirst=!didInitialSync.current');
  const body = code.slice(start, code.indexOf('},[year,month,ready,refreshTick,fetchData]', start));
  assert.match(body, /const tick=refreshTick!==lastRefreshTick\.current;/,
    'fixture assumption: the tick comparison is computed once');
  assert.match(body, /const \{sync,invalidate,bumpExpectedNow\}=refreshTickPlan\(\{syncFirst,tick,/,
    'the effect takes `invalidate` from refreshTickPlan, fed syncFirst and the tick');
  assert.match(body, /fetchData\(year,month,\{sync,invalidate\}\)/, 'and hands it to fetchData');
  assert.deepEqual(
    [[true, false], [false, true], [true, true], [false, false]].map(([syncFirst, tick]) =>
      refreshTickPlan({ syncFirst, tick, due: true }).invalidate),
    [true, true, true, false],
    'the effect must invalidate exactly when it is NOT plain navigation (startup or a foreground return)');
  const fstart = code.indexOf('const fetchData=useCallback');
  const fbody = code.slice(fstart, code.indexOf('const refreshNow=useCallback', fstart));
  assert.match(fbody, /^const fetchData=useCallback\(async\(y,m,\{sync=false,invalidate=true\}=\{\}\)=>/,
    'fetchData defaults to invalidating (Refresh says nothing and must drop the caches)');
  assert.ok(fbody.includes('reloadData(y,m,{invalidate})'), 'fetchData threads invalidate into its first load');
  assert.ok(!/invalidate:false/.test(code),
    'no caller hard-codes invalidate:false — the follow-up, reloadViewed and Refresh must keep the default');
});

// --- The Accounts tab's lazy panels are epoch-driven too (F19) ---------------
// "Does it add up?" and Data coverage fetched once per LAUNCH: reconData was
// fetched only while null (and getReconciliation's ok:false is non-null, so a
// failure stuck), covErr blocked every retry, and nothing ever reset either —
// yet the copy says "try Refresh" and tells the user to fix the listed pairs.
// Now an invalidating reload bumps an epoch per panel; an open panel refetches
// at once, a closed one on its next expand, and a failed read retries.

test('an invalidating reload bumps both panel epochs', () => {
  const code = stripComments(dashboard);
  const start = code.indexOf('const reloadData=useCallback');
  const body = code.slice(start, code.indexOf('const reloadViewed=useCallback', start));
  const open = body.indexOf('if(invalidate){');
  assert.ok(open > 0, 'fixture assumption: reloadData gates its cache drops on invalidate');
  const block = body.slice(open, body.indexOf('}', open + 'if(invalidate){'.length));
  for (const bump of ['setReconEpoch(e=>e+1)', 'setCovEpoch(e=>e+1)']) {
    assert.ok(block.includes(bump), `reloadData must ${bump} with the other lazy caches — "try Refresh" has to refetch`);
  }
});

test('each panel fetches from an effect keyed on [open, epoch], seq-guarded, and a failure can retry', () => {
  const code = stripComments(dashboard);
  for (const [open, epoch, seq, loaded, fetcher] of [
    ['reconOpen', 'reconEpoch', 'reconSeq', 'reconLoaded', 'getReconciliation()'],
    ['covOpen', 'covEpoch', 'covSeq', 'covLoaded', 'getDataCoverage()'],
  ]) {
    const deps = `},[${open},${epoch}]);`;
    const end = code.indexOf(deps);
    assert.ok(end > 0, `the ${fetcher} effect must re-run on ${open} and ${epoch}`);
    const body = code.slice(code.lastIndexOf('useEffect(()=>{', end), end);
    assert.ok(body.includes(fetcher), `fixture assumption: the [${open},${epoch}] effect fetches ${fetcher}`);
    assert.match(body, new RegExp(`if\\(!${open}\\|\\|${loaded}\\.current===${epoch}\\)return;`),
      'fetch only while open, once per epoch (a collapse/expand alone is not a refetch)');
    assert.match(body, new RegExp(`const s=\\+\\+${seq}\\.current;`), 'each fetch mints a sequence');
    assert.match(body, new RegExp(`s===${seq}\\.current|s!==${seq}\\.current`), 'and a stale response is dropped');
    assert.match(body, new RegExp(`${loaded}\\.current=-1`),
      'a failed read RETURNS the epoch (the expected-tx rule), so re-expanding retries');
  }
  assert.ok(!/covData===null&&!covErr/.test(code),
    'gating the coverage fetch on !covErr is what made one transient error permanent until relaunch');
});
