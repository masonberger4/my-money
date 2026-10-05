// The Dashboard's load/refresh pipeline DECISIONS, pulled out of Dashboard.jsx
// so they are tested as behavior (test/loadPipeline.test.js) rather than only
// as source text. Pure, zero imports: plain data in, a plan out. The callers
// are fetchData (one reload plus, optionally, a bank pull) and the fetchData
// effect (startup, plain month navigation, and App.jsx's foreground-return
// refreshTick) — Dashboard does what the plan says, in its own order.

// What a fetchData-effect run does.
//   syncFirst — the first run once `ready` (startup).
//   tick      — refreshTick moved since the last run (a foreground return).
//   due       — foregroundSyncDue(...) (src/sync.js): over an hour since this
//               device last started a pull.
// Returns:
//   sync       — true (the startup pull) | "foreground" (the hour-gated QUIET
//                pull: a failure logs, never a banner — nobody asked for it)
//                | false.
//   invalidate — drop the lazy tab caches (Recurring/Debt/Tax/Trends and the
//                Accounts-tab panels). Every run but plain month navigation:
//                none of those caches depends on the viewed month.
//   bumpExpectedNow — re-run the expected-bill auto-match pass at once. Only
//                a foreground return that does NOT pull: one that pulls
//                defers its pass to the pull's settle (pullFollowUp's
//                bumpExpected), so one return runs ONE pass, against the
//                pulled rows — bumping here as well ran a second pass that
//                read pre-pull rows and could overlap the first (each pass
//                writes matches and roll-forwards).
export function refreshTickPlan({ syncFirst, tick, due }) {
  const sync = syncFirst ? true : (tick && due ? 'foreground' : false);
  return { sync, invalidate: !!(syncFirst || tick), bumpExpectedNow: !!tick && !sync };
}

// What fetchData does once the pull it started settles. `sync` is the mode it
// was called with (true | "refresh" | "foreground"); `res` is runSync's
// resolution, or null when the pull rejected.
//   reload — the follow-up reload of the month on screen. Only a real pull
//            earns it: a throttled pull (the server ran within the hour) wrote
//            nothing, and vacuously neither did an empty results array (no
//            access URL) or a failed pull. EXCEPT the explicit Refresh
//            ("refresh"): its contract is a genuinely fresh read (the sync's
//            completion hook just dropped the caches), and skipping the
//            follow-up there served the warm memo from before the drop.
//   reassertError — the follow-up's first act clears the error banner, so a
//            FAILED Refresh would never show its failure (it was painted and
//            cleared in the same tick): re-assert it after the reload.
//   bumpExpected — re-run the auto-match pass: after any follow-up (the pull
//            may have brought a bill's charge), and after EVERY settle of a
//            foreground return's pull, which deferred its pass to here
//            (refreshTickPlan) — the other phone's writes still need one.
export function pullFollowUp(sync, res) {
  const allThrottled = !res || (res.results || []).every(r => r?.skipped === 'throttled');
  const reload = !allThrottled || sync === 'refresh';
  return { reload, reassertError: reload && !res, bumpExpected: reload || sync === 'foreground' };
}

// A COUNTED busy flag with a per-hold cap — Dashboard's `refreshing`, which
// keeps the pull chip, its gate and the gear's Refresh spinning until the pull
// a refresh started has settled. `hold()` raises the flag and returns an
// idempotent `release`; the flag drops when the LAST hold lets go, because
// pulls overlap (the startup pull and a Refresh that joins runSync's
// single-flight). Every hold also lets go BY ITSELF after `capMs`: runSync has
// no client timeout and its single-flight hands each later caller the SAME
// promise, so one request that never settles (in flight when iOS suspended
// the PWA) would otherwise leave Refresh and pull-to-refresh disabled for the
// rest of the session. The cap only stops the spinner — the pull is not
// cancelled, and its follow-up still runs if it ever settles.
export const SYNC_HOLD_CAP_MS = 60_000;
export function createSyncHold(setBusy, { capMs = SYNC_HOLD_CAP_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let held = 0;
  return function hold() {
    if (held++ === 0) setBusy(true);
    let done = false;
    let timer = null;
    const release = () => {
      if (done) return;
      done = true;
      clearTimer(timer);
      if (--held === 0) setBusy(false);
    };
    timer = setTimer(release, capMs);
    return release;
  };
}
