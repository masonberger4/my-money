export async function runSync() { return { ok: true, results: [] }; }
export function pullWasClean() { return true; }
export function setSyncCompletionHook() {}
// The smoke walk never backgrounds the page, so no foreground pull is due.
export function foregroundSyncDue() { return false; }
