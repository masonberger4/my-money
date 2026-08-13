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
// The visible-at-hide-time set rides in the household-scoped `settings` table
// (no migration needed) under one key per institution.

export const UNLINK_SETTINGS_PREFIX = 'unlink:';
export const PERMANENT_CONFIRM = 'delete';

export function unlinkSettingsKey(institutionId) {
  return `${UNLINK_SETTINGS_PREFIX}${institutionId}`;
}

// Which account ids the soft-hide should record for a later Restore: exactly
// the ones VISIBLE at hide time. Hidden ones were hidden by the user (or are
// unconfirmed arrivals) and must stay that way through a remove/restore cycle.
export function visibleAccountIds(accounts) {
  return (accounts || []).filter(a => !a.hidden).map(a => a.id);
}

// Parse the stored settings value back into the set of ids to unhide.
// Tolerant: a missing/garbled value means "unhide none" — Restore still
// re-enables the institution; the user can unhide by hand in Accounts. Never
// throws (a corrupt settings row must not make Restore 500).
export function parseRestoreSet(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(v => typeof v === 'string' || typeof v === 'number');
  } catch {
    return [];
  }
}

// Restore only unhides ids that (a) were recorded at hide time AND (b) still
// exist under the institution — the disabled tombstone kept the sync away, but
// defend anyway: never unhide an id the record doesn't name.
export function restoreSet(recordedIds, currentAccountIds) {
  const current = new Set(currentAccountIds || []);
  return (recordedIds || []).filter(id => current.has(id));
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

// The manual-institution gate (parity fix, 2026-08-13). That branch
// HARD-DELETES: it cascades away every account and transaction under the
// "Imported" institution — i.e. the entire CSV/PDF statement backfill — yet it
// was the one destructive path a bare `{ institution_id }` POST could reach
// while both of its siblings above demanded a literal. Same discipline:
// `confirm` must be exactly 'delete' (the PERMANENT_CONFIRM literal — one
// spelling of the word across both destructive gates), not truthy, not
// case-insensitive. A stale PWA client that predates this gate fails CLOSED
// with a 400 until its service worker refreshes — the right direction for a
// destructive action.
export function manualDeleteAllowed(body) {
  return body?.confirm === PERMANENT_CONFIRM;
}

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
