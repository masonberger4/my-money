// Pure decisions for the "Remove bank" soft-hide / restore / permanent-delete
// flow (api/unlink-institution.js + api/simplefin-status.js). Zero imports so
// test/unlink.test.js can drive them plain-Node.
//
// The shape (decided by Mason, 2026-08-01 — option C, both halves):
//   - Remove = SOFT-HIDE: accounts hidden, institution disabled (the tombstone
//     that keeps the org out of re-pulls), nothing deleted. Restore un-disables
//     AND unhides — but only the accounts the soft-hide itself hid, because
//     hidden is user-owned state: an account the user deliberately hid before
//     removing the bank must stay hidden after Restore, and new SimpleFIN
//     accounts arriving hidden is a load-bearing rule (the type guess is
//     unconfirmed until the user unhides).
//   - "Delete permanently" is a separate explicit mode requiring BOTH
//     { permanent: true, confirm: 'delete' } — impossible to hit by accident.
//
// Since 2026-08-13 (Mason) the MANUAL "Imported" institution takes the same
// shape: remove soft-hides and records, and the cascade delete lives behind
// the same permanent+confirm literals. It cannot reuse the SimpleFIN
// tombstone, though — a manual institution is permanently `status='disabled'`
// by design (that status is what keeps it out of every sync path), so the
// RECORD ITSELF is the marker: a manual institution with an `unlink:<id>` row
// is removed, and restoring consumes the row. That is also why the key and
// the value parse moved to `src/unlinkRestore.js` — the client reads them to
// decide whether to offer Restore, and the two sides must agree exactly.
//
// The visible-at-hide-time set rides in the household-scoped `settings` table
// (no migration needed) under one key per institution.

import {
  UNLINK_SETTINGS_PREFIX,
  unlinkSettingsKey,
  parseRestoreIds,
  restorableIds,
} from '../../src/unlinkRestore.js';

export const PERMANENT_CONFIRM = 'delete';

// Re-exported under the names this route and test/unlink.test.js already use.
// One definition, two callers (api→src, the FEED_REACH_DAYS pattern).
export { UNLINK_SETTINGS_PREFIX, unlinkSettingsKey };
export const parseRestoreSet = parseRestoreIds;
export const restoreSet = restorableIds;

// Which account ids the soft-hide should record for a later Restore: exactly
// the ones VISIBLE at hide time. Hidden ones were hidden by the user (or are
// unconfirmed arrivals) and must stay that way through a remove/restore cycle.
export function visibleAccountIds(accounts) {
  return (accounts || []).filter(a => !a.hidden).map(a => a.id);
}

// The permanent-delete gate. `permanent` must be literal true and `confirm`
// the literal string 'delete' — not truthy, not case-insensitive. Anything
// else is the soft path or a rejection, never an accidental cascade.
export function isPermanentDeleteRequest(body) {
  return body?.permanent === true;
}

export function permanentDeleteAllowed(body) {
  return body?.permanent === true && body?.confirm === PERMANENT_CONFIRM;
}

// TOMBSTONE (2026-08-13): `manualDeleteAllowed` lived here for one PR. It
// gated the manual branch's hard delete behind a bare `confirm: 'delete'`
// while that branch still deleted by default. Now that removing a manual
// institution SOFT-HIDES like its SimpleFIN sibling, the only destructive
// manual path is the permanent one — already gated by
// `permanentDeleteAllowed` above, with the identical literal. A second
// predicate meaning the same thing is the duplication hazard PR #61 removed
// zero-caller predicates for, so it is gone rather than left as a synonym.
// Consequence, deliberate: a stale PWA client still sending the bare
// `{ institution_id, confirm: 'delete' }` body now gets a SOFT-HIDE — the
// safe direction, since `isPermanentDeleteRequest` needs `permanent: true`.

// The simplefin-status DELETE gate (forget the stored access URL). Same
// literal-string discipline as permanentDeleteAllowed: `confirm` must be
// exactly 'disconnect' — not truthy, not case-insensitive — so a bare
// authenticated DELETE (a replayed request, a curious client, a buggy retry)
// can never silently stop all syncing. Availability, not data loss, but the
// failure mode is the silent-stale-dashboard shape.
export const DISCONNECT_CONFIRM = 'disconnect';

export function disconnectAllowed(body) {
  return body?.confirm === DISCONNECT_CONFIRM;
}
