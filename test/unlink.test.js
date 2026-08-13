// The "Remove bank" soft-hide / restore / permanent-delete pure decisions
// (api/_lib/unlink.js). The route wiring is thin; these are the parts that
// decide what gets hidden, unhidden, or irreversibly deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  unlinkSettingsKey,
  visibleAccountIds,
  parseRestoreSet,
  restoreSet,
  isPermanentDeleteRequest,
  permanentDeleteAllowed,
  PERMANENT_CONFIRM,
  disconnectAllowed,
  DISCONNECT_CONFIRM,
} from '../api/_lib/unlink.js';

test('unlinkSettingsKey namespaces per institution', () => {
  assert.equal(unlinkSettingsKey('abc-123'), 'unlink:abc-123');
});

test('visibleAccountIds records only accounts visible at hide time', () => {
  const accounts = [
    { id: 'a1', hidden: false },
    { id: 'a2', hidden: true }, // user hid this on purpose — must stay hidden through remove/restore
    { id: 'a3', hidden: false },
  ];
  assert.deepEqual(visibleAccountIds(accounts), ['a1', 'a3']);
  assert.deepEqual(visibleAccountIds([]), []);
  assert.deepEqual(visibleAccountIds(null), []);
});

test('parseRestoreSet round-trips the stored value', () => {
  assert.deepEqual(parseRestoreSet(JSON.stringify(['a1', 'a3'])), ['a1', 'a3']);
});

test('parseRestoreSet never throws on garbage — Restore must not 500', () => {
  assert.deepEqual(parseRestoreSet(null), []);
  assert.deepEqual(parseRestoreSet(''), []);
  assert.deepEqual(parseRestoreSet('not json'), []);
  assert.deepEqual(parseRestoreSet('{"a":1}'), []); // non-array JSON
  // Non-id junk inside an array is dropped, ids kept.
  assert.deepEqual(parseRestoreSet('["a1", {"x":1}, "a2"]'), ['a1', 'a2']);
});

test('restoreSet unhides only recorded ids that still exist', () => {
  // a3 was deleted since the hide; a9 exists but was never recorded (arrived
  // hidden after the remove — the new-accounts-arrive-hidden rule holds).
  assert.deepEqual(restoreSet(['a1', 'a3'], ['a1', 'a2', 'a9']), ['a1']);
  assert.deepEqual(restoreSet([], ['a1']), []);
  assert.deepEqual(restoreSet(null, null), []);
});

test('permanent delete requires BOTH permanent:true and the literal confirm', () => {
  assert.equal(permanentDeleteAllowed({ permanent: true, confirm: 'delete' }), true);
  assert.equal(PERMANENT_CONFIRM, 'delete');
  // Every near-miss is rejected — no accidental cascade.
  assert.equal(permanentDeleteAllowed({ permanent: true }), false);
  assert.equal(permanentDeleteAllowed({ permanent: true, confirm: 'DELETE' }), false);
  assert.equal(permanentDeleteAllowed({ permanent: true, confirm: true }), false);
  assert.equal(permanentDeleteAllowed({ permanent: 'true', confirm: 'delete' }), false);
  assert.equal(permanentDeleteAllowed({ permanent: 1, confirm: 'delete' }), false);
  assert.equal(permanentDeleteAllowed({ confirm: 'delete' }), false);
  assert.equal(permanentDeleteAllowed({}), false);
  assert.equal(permanentDeleteAllowed(null), false);
});

test('disconnect (forget the access URL) requires the literal confirm', () => {
  assert.equal(DISCONNECT_CONFIRM, 'disconnect');
  assert.equal(disconnectAllowed({ confirm: 'disconnect' }), true);
  // Every near-miss is rejected — a bare authenticated DELETE (replay, buggy
  // retry) must never silently stop all SimpleFIN syncing.
  assert.equal(disconnectAllowed({}), false);
  assert.equal(disconnectAllowed(null), false);
  assert.equal(disconnectAllowed(undefined), false);
  assert.equal(disconnectAllowed({ confirm: 'DISCONNECT' }), false);
  assert.equal(disconnectAllowed({ confirm: true }), false);
  assert.equal(disconnectAllowed({ confirm: 'delete' }), false);
});

test('simplefin-status wires the disconnect gate ahead of the DELETE, and the client sends the confirm', () => {
  // Source scan (the assistantModels precedent): the guard only guards if the
  // route actually calls it before touching simplefin_access, and the UI only
  // works if apiClient sends the literal string the server demands.
  const route = readFileSync(fileURLToPath(new URL('../api/simplefin-status.js', import.meta.url)), 'utf8');
  const gateAt = route.indexOf('disconnectAllowed(req.body)');
  const deleteAt = route.indexOf(".from('simplefin_access')\n        .delete()");
  assert.ok(gateAt > 0, 'route must call disconnectAllowed(req.body)');
  assert.ok(deleteAt > gateAt, 'the gate must run before the simplefin_access delete');
  const client = readFileSync(fileURLToPath(new URL('../src/apiClient.js', import.meta.url)), 'utf8');
  assert.ok(client.includes("request('DELETE', '/api/simplefin-status', { confirm: 'disconnect' })"),
    'disconnectSimpleFin must send the literal confirm body');
});

test('isPermanentDeleteRequest is literal-true only', () => {
  assert.equal(isPermanentDeleteRequest({ permanent: true }), true);
  assert.equal(isPermanentDeleteRequest({ permanent: 'true' }), false);
  assert.equal(isPermanentDeleteRequest({}), false);
  assert.equal(isPermanentDeleteRequest(undefined), false);
});


// --- The manual "Imported" institution: soft-hide, not delete (2026-08-13) ---
// Removing it used to cascade away every imported account and transaction —
// the household's whole statement backfill, rebuilt from files that live on a
// laptop, not in the app. It now takes the SimpleFIN shape: hide, record, and
// restore. These pins are the route wiring (the pure decisions above are
// shared by both branches) and the ONE-COPY contract between the two
// processes that read the record.

test('the manual branch soft-hides by default; the cascade sits behind the permanent gate', () => {
  const route = readFileSync(fileURLToPath(new URL('../api/unlink-institution.js', import.meta.url)), 'utf8');
  const manualAt = route.indexOf('const isManualInstitution =');
  const permanentAt = route.indexOf('if (permanent) {', manualAt);
  const deleteAt = route.indexOf(".from('institutions')\n        .delete()", manualAt);
  const softHideAt = route.indexOf('softHideInstitution(supabase, user.householdId, inst.id)', manualAt);
  assert.ok(manualAt > 0, 'the manual branch must still be reached by an ABSENT org id');
  assert.ok(permanentAt > manualAt, 'the manual branch must test `permanent` before deleting');
  assert.ok(deleteAt > permanentAt, 'the institutions delete must live INSIDE the permanent branch');
  assert.ok(softHideAt > deleteAt, 'the default (fall-through) manual path must be the soft-hide');
  // The manual institution is permanently status='disabled' (that status is
  // what keeps it out of every sync path), so the soft-hide must not restate
  // it the way the SimpleFIN branch does — its RECORD is the removed marker.
  const manualTail = route.slice(softHideAt);
  assert.ok(!manualTail.includes("status: 'disabled'"),
    'the manual soft-hide must leave institutions.status alone');
});

test('the restore branch is scoped to manual institutions and consumes the record', () => {
  const route = readFileSync(fileURLToPath(new URL('../api/unlink-institution.js', import.meta.url)), 'utf8');
  const restoreAt = route.indexOf('if (restore_institution_id) {');
  assert.ok(restoreAt > 0, 'the route must handle restore_institution_id');
  const branch = route.slice(restoreAt, route.indexOf('if (!institution_id)'));
  assert.ok(branch.includes(".is('simplefin_org_id', null)"),
    'restore here must refuse a SimpleFIN org — that restore lives in simplefin-status, which also clears the tombstone');
  assert.ok(branch.includes(".from('settings')\n        .delete()"),
    'the record must be consumed, or a second Restore replays a stale snapshot');
  const client = readFileSync(fileURLToPath(new URL('../src/apiClient.js', import.meta.url)), 'utf8');
  assert.ok(client.includes("{ restore_institution_id: institutionId }"),
    'apiClient must send the restore body the route reads');
  // The retired one-PR gate must be gone from BOTH sides, not just unused:
  // its literal is now `permanentDeleteAllowed`'s, and a synonym predicate is
  // the duplication hazard (the PR #61 rule).
  const lib = readFileSync(fileURLToPath(new URL('../api/_lib/unlink.js', import.meta.url)), 'utf8');
  assert.ok(!/export function manualDeleteAllowed/.test(lib),
    'manualDeleteAllowed must be retired, not left as a synonym of permanentDeleteAllowed');
  assert.ok(!client.includes('confirmDelete'),
    'the client option that fed it must go with it');
});

test('ONE COPY of the restore record: api/_lib/unlink.js re-exports the shared pure module', async () => {
  // The server writes the record; the client reads it to decide whether to
  // offer Restore. A drifting second copy of the key or the parse fails
  // silently — the button just never appears (absence has no alarm).
  const shared = await import('../src/unlinkRestore.js');
  assert.equal(shared.unlinkSettingsKey('abc-123'), unlinkSettingsKey('abc-123'));
  assert.equal(parseRestoreSet, shared.parseRestoreIds);
  assert.equal(restoreSet, shared.restorableIds);
  const lib = readFileSync(fileURLToPath(new URL('../api/_lib/unlink.js', import.meta.url)), 'utf8');
  assert.ok(lib.includes("from '../../src/unlinkRestore.js'"),
    'api must import the shared module, not redeclare the key or the parse');
  const adapter = readFileSync(fileURLToPath(new URL('../src/dataAdapter.js', import.meta.url)), 'utf8');
  assert.ok(adapter.includes("from './unlinkRestore.js'"),
    'the client read must come from the same module');
});

test('restorableIds is what the Restore button may promise: recorded ∩ still-hidden', async () => {
  const { restorableIds } = await import('../src/unlinkRestore.js');
  // a2 was unhidden by hand since the removal — restoring it is a no-op, so
  // it must not be counted in what the button says it will bring back.
  assert.deepEqual(restorableIds(['a1', 'a2', 'a3'], ['a1', 'a3']), ['a1', 'a3']);
  assert.deepEqual(restorableIds(['a1'], []), []);
});
