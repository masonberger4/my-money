// TEMPORARY TROUBLESHOOTING AID — powers the Accounts tab's "Data coverage"
// panel so we can see, per account, what history the app actually holds
// (first/last tx date, row count, per-source breakdown). May be hidden or
// removed once the coverage questions are settled. Pure, zero imports.
//
// aggregateCoverage(rows): rows are [{account_id, date, source}] in any order.
// Returns a plain object keyed by account_id:
//   { first: 'YYYY-MM-DD'|null, last: 'YYYY-MM-DD'|null, count: n,
//     sources: { simplefin: n, csv: n, pdf: n, manual: n, ... } }
// Dates compare lexically (ISO strings), so no Date parsing is needed; a row
// with a missing date still counts but never moves first/last. A missing
// source lands under 'unknown' rather than being dropped — same visible-unknown
// rule as Uncategorized.
export function aggregateCoverage(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || r.account_id == null) continue;
    let a = out[r.account_id];
    if (!a) a = out[r.account_id] = { first: null, last: null, count: 0, sources: {} };
    a.count += 1;
    const d = typeof r.date === 'string' && r.date ? r.date.slice(0, 10) : null;
    if (d) {
      if (a.first === null || d < a.first) a.first = d;
      if (a.last === null || d > a.last) a.last = d;
    }
    const s = r.source || 'unknown';
    a.sources[s] = (a.sources[s] || 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feed reach / coverage shortfall — NOT temporary, unlike aggregateCoverage
// above. This is the tell for history the SimpleFIN feed can never fetch.
//
// THE ONE COPY of the feed's reach. api/_lib/simplefin.js imports it as the
// default for MAX_LOOKBACK_DAYS (the api → src direction is the established
// one for pure modules — categoryMap/txClassify/accountBalance are all imported
// by server code). A second hardcoded client copy would drift the moment
// SIMPLEFIN_MAX_LOOKBACK_DAYS is tuned, and the copy is what the USER-FACING
// sentence quotes.
export const FEED_REACH_DAYS = 88;

// THE ONE COPY of the incremental pull's re-read overlap, same pattern as
// FEED_REACH_DAYS above: api/_lib/simplefin.js imports it as the default for
// OVERLAP_DAYS, and CsvImport.jsx quotes it in the import-boundary math and the
// user-facing "last N days are still excluded" sentences. A hardcoded client
// mirror sat in CsvImport.jsx until 2026-08-11 and would have silently diverged
// the moment SIMPLEFIN_OVERLAP_DAYS was set (same accepted residual: the env
// override still desyncs the client, but now only via a deliberate env change).
export const FEED_OVERLAP_DAYS = 30;

// Slack on the upper bound. An account whose oldest row is comfortably NEWER
// than the day we linked it simply has no older history to miss (it was opened
// after we connected), so it must not nag; a few days of slack absorbs
// posted-date wobble around the link itself.
export const FEED_GRACE_DAYS = 7;

const DAY_MS = 86400000;

// Both inputs are compared at UTC-DAY granularity: `created_at` is a timestamp
// and `first` is a calendar date, so comparing raw milliseconds would put the
// wall half a day off and make the boundary case flip on the time of day the
// account happened to be linked.
function dayMs(v) {
  if (!v) return null;
  const t = Date.parse(typeof v === 'string' && v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) * DAY_MS : null;
}

// Which SimpleFIN-fed accounts have history the feed never fetched, derived
// from the LEDGER — never from the sync's transient `coverage_shortfall`, and
// never from `FIRST_PULL_DAYS > FEED_REACH_DAYS` (that inequality is always
// true, so it would be a permanent banner unrelated to reality).
//
// rows: [{ account_id, created_at, first }] — `first` is the account's oldest
// stored transaction date of ANY source, `created_at` the day the account row
// was first written (i.e. the day its first pull ran).
//
// Flagged when `first` lands inside the first pull's reachable window,
// [created_at − FEED_REACH_DAYS, created_at + FEED_GRACE_DAYS]: the oldest row
// we hold is one the first pull could have fetched, so the pull's own floor —
// not the account's age — is why nothing older is here.
//   • The LOWER bound makes the notice SELF-CLEAR with no invalidation
//     machinery: the moment a CSV/PDF backfill lands a row before the wall,
//     `first` drops below it and the row stops being flagged.
//   • `first` null (never synced, or an account with no rows at all) is NOT
//     flagged — never assert a gap you cannot see, the Uncategorized rule.
// Accepted false negatives, deliberately: an account that happened to be quiet
// for its first weeks, and an account whose very first pull failed outright.
// Both under-report, which is the safe direction — this must never render a
// gap that isn't there.
export function feedCoverageGaps(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || r.account_id == null) continue;
    const created = dayMs(r.created_at);
    const first = dayMs(r.first);
    if (created === null || first === null) continue;
    if (first < created - FEED_REACH_DAYS * DAY_MS) continue;
    if (first > created + FEED_GRACE_DAYS * DAY_MS) continue;
    out.push({ account_id: r.account_id, served_from: String(r.first).slice(0, 10) });
  }
  out.sort((a, b) =>
    a.served_from < b.served_from ? -1
      : a.served_from > b.served_from ? 1
        : String(a.account_id) < String(b.account_id) ? -1 : 1
  );
  return out;
}
