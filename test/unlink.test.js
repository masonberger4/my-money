// The "Remove bank" soft-hide / restore / permanent-delete pure decisions
// (api/_lib/unlink.js). The route wiring is thin; these are the parts that
// decide what gets hidden, unhidden, or irreversibly deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unlinkSettingsKey,
  visibleAccountIds,
  parseRestoreSet,
  restoreSet,
  isPermanentDeleteRequest,
  permanentDeleteAllowed,
  PERMANENT_CONFIRM,
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

test('isPermanentDeleteRequest is literal-true only', () => {
  assert.equal(isPermanentDeleteRequest({ permanent: true }), true);
  assert.equal(isPermanentDeleteRequest({ permanent: 'true' }), false);
  assert.equal(isPermanentDeleteRequest({}), false);
  assert.equal(isPermanentDeleteRequest(undefined), false);
});
