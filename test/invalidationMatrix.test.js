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
  assert.ok(invalidator.includes('spendCache = null'), 'the invalidator drops the spend sums');
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
