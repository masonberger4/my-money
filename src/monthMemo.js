// Per-reload memo of raw transaction-range fetches, so reloadData's parallel
// callers (getSpending / getTransactions / getOverview / getCashFlow) share one
// network read per distinct range instead of each refetching the same month.
// The spendCache precedent (dataAdapter.js): cleared by the SAME invalidation
// (`invalidateEnvelopeSpending`, called at the top of every dashboard reload —
// the only moment transactions can have moved), so within one reload the data
// is coherent and across reloads it is always refetched.
//
// Two load-bearing rules:
//
// 1. It memoizes the RAW fetch only, and hands every caller PER-ROW SHALLOW
//    COPIES (`getCopy`). The two per-model pipelines MUTATE rows in place —
//    `applyAccountRules` writes `t.mapped_category` and `markInternalTransfers`
//    writes `t._internal`, both TOP-LEVEL fields of a flat row object (the
//    nested `accounts` join object is read-only everywhere) — so a shallow
//    per-row copy is exactly deep enough. Sharing the same row objects would
//    let getCashFlow's transfer marks leak into the purchase-based model.
//
// 2. It stores the PROMISE, not the resolved rows: reloadData fires its calls
//    in parallel, so a value-cache would still double-fetch — the second
//    caller must join the in-flight request.
//
// Containment: a range fully inside another requested range is served by
// slicing that fetch's rows (same `date >= start && date <= end` predicate the
// query would have used, and rows arrive date-sorted, so the slice is
// byte-equivalent). All of reloadData's calls register SYNCHRONOUSLY in one
// burst (Promise.all's array construction), so each entry defers one microtask
// before deciding — by then the 6-month cash-flow range is registered and the
// current-month callers piggyback on it regardless of call order. Mutual-await
// deadlock is impossible: containment here is strict (a distinct entry can
// contain but never equal another — equal ranges share one key), so the await
// chain is a partial order that always bottoms out in a real fetch.
export function createRangeMemo(fetchRange) {
  const entries = new Map();

  function get(start, end) {
    const key = `${start}|${end}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { start, end };
      entry.promise = (async () => {
        // One microtask so every range requested in the same synchronous burst
        // is registered before supersets are chosen.
        await Promise.resolve();
        for (const other of entries.values()) {
          if (other !== entry && other.start <= start && other.end >= end) {
            const rows = await other.promise;
            return rows.filter(t => t.date >= start && t.date <= end);
          }
        }
        return fetchRange(start, end);
      })();
      // A rejected fetch must not poison the memo: evict the entry so the
      // next caller retries, but only if it is still the CURRENT entry for
      // this key (clear() may have replaced the map's contents meanwhile).
      // Callers already joined to this promise still see the rejection —
      // exactly what they'd have seen without the memo.
      entry.promise.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      entries.set(key, entry);
    }
    return entry.promise;
  }

  return {
    // Fresh array of fresh per-row shallow copies on EVERY call — callers may
    // sort the array and mutate rows (the pipelines do) without poisoning the
    // memo or each other.
    async getCopy(start, end) {
      const rows = await get(start, end);
      return rows.map(t => ({ ...t }));
    },
    // Invalidation drops entries outright (no write-back exists, so a stale
    // in-flight promise can never re-poison the map — consumers that already
    // hold its promise were started pre-invalidation, same as before the memo).
    clear() {
      entries.clear();
    },
  };
}
