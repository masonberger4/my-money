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
