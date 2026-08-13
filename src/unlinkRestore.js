// The remove/restore RECORD — the one definition of the settings key and its
// value shape, shared by the client and the server.
//
// Zero imports, pure, so both sides can have it: `api/_lib/unlink.js` imports
// it (the api→src direction `api/_lib/simplefin.js` already uses for
// FEED_REACH_DAYS) and re-exports the names its route and tests already know,
// while `src/dataAdapter.js` reads the same key to tell the Accounts tab that
// a removed "Imported" institution can be brought back.
//
// WHY ONE COPY: this key and this parse are a contract between two processes.
// The server writes the record under service_role at hide time; the client
// reads it to decide whether to offer Restore. A second, drifting copy of
// either half fails in the quietest possible way — the button simply never
// appears, and the accounts look permanently gone. That is the same
// absence-has-no-alarm shape CLAUDE.md records for the SimpleFIN watermark.

export const UNLINK_SETTINGS_PREFIX = 'unlink:';

export function unlinkSettingsKey(institutionId) {
  return `${UNLINK_SETTINGS_PREFIX}${institutionId}`;
}

// Parse the stored value back into the set of ids to unhide. Tolerant by
// contract: a missing or garbled record means "unhide none", never a throw —
// a corrupt settings row must not break Restore (the server still re-enables
// what it can) and must never 500 the Accounts tab that reads it.
export function parseRestoreIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(v => typeof v === 'string' || typeof v === 'number');
  } catch {
    return [];
  }
}

// Which recorded ids may actually be unhidden: recorded ∩ still-present.
// Both halves are load-bearing. An id that no longer exists is skipped rather
// than written blindly, and — the rule that gives this its shape — only ids
// RECORDED at hide time are ever unhidden, so an account the user had
// deliberately hidden before the removal, or one that arrived afterwards
// (a fresh import lands under the same "Imported" institution), stays hidden
// through a remove/restore cycle.
export function restorableIds(recordedIds, currentAccountIds) {
  const current = new Set(currentAccountIds || []);
  return (recordedIds || []).filter(id => current.has(id));
}
