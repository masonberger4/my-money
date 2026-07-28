import { runServerSync } from './apiClient.js';

// The sync itself runs server-side (api/sync.js): the server holds the Plaid
// access tokens and the SimpleFIN access URL, and writes accounts/transactions
// straight to Supabase. This wrapper just triggers it and keeps the
// single-flight behavior the UI relies on.

let syncInFlight = null;

async function execute(force) {
  const { results } = await runServerSync({ force });
  const failures = (results || []).filter(r => r.error);
  for (const f of failures) {
    console.warn('[sync] institution failed:', f.institution, f.error);
  }
  return { results, failures };
}

// Did this sync actually READ the feed, end to end?
//
// `runSync` RESOLVES on a failed pull — api/sync.js deliberately answers HTTP
// 200 carrying a per-result error, so the dashboard can show "this bank is
// broken" without the whole request failing. So "the promise didn't reject" is
// not evidence of anything, and callers that need to reason about what the feed
// holds must ask this instead. Four shapes all resolve:
//
//   * a thrown pull        -> results[].error
//   * a partial bank error -> results[].warnings (and NO error key)
//   * the once-an-hour throttle -> results[].skipped === 'throttled'
//   * no access URL at all -> results === []
//
// A partial failure counts as unclean even when the bank that failed is not the
// one the caller cares about, and that is NOT over-cautious. `last_pulled_at`
// lives on simplefin_access — one row per ACCESS URL, covering every bank — and
// api/sync.js only advances it when `errors.length === 0` across the whole
// pull. So one broken bank means the watermark did not move, which means the
// NEXT pull still reaches back FIRST_PULL_DAYS (730) for everything. Any caller
// reasoning about "what dates can the feed still deliver?" gets the same answer
// whichever bank broke.
//
// Pure and exported so the rule is testable — it gates whether statement import
// will insert rows over dates a later pull will re-fetch.
export function pullWasClean({ results, failures } = {}) {
  if (!Array.isArray(results) || results.length === 0) return false;
  if (failures && failures.length > 0) return false;
  return results.every(r => r && !r.error && !r.skipped && !(r.warnings && r.warnings.length));
}

// opts.force bypasses the server-side SimpleFIN pull throttle (a pull is
// normally skipped if one ran in the last hour — SimpleFIN only refreshes bank
// data about once a day). Forced syncs also skip the single-flight dedupe:
// they're deliberate user actions like "I just connected a bank", and folding
// one into an already-running background sync would silently drop the force.
export function runSync({ force = false } = {}) {
  if (force) return execute(true);
  if (syncInFlight) return syncInFlight;
  syncInFlight = execute(false).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}
