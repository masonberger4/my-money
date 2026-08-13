// The Categories-tab teach-queue's POPULATION, pure and zero-import (the
// unhideConfirm.js / categoryList.js pattern) so test/teachQueue.test.js can
// cover it under plain `node --test`.
//
// WHY THIS EXISTS AS ITS OWN MODULE (2026-08-05). Post-wipe the queue stopped
// being a cleanup aid for a classifier that got most rows right and became the
// PRIMARY onboarding surface: nothing is guessed, so every transaction sits in
// Uncategorized until a merchant is taught. At that size its old grouping was
// wrong in three ways that all had the same root — it never split on `counted`:
//
//   1. It listed paychecks, internal-transfer legs and card payments beside
//      real merchants, because every Uncategorized row in the month went in.
//   2. An income-only merchant rendered as "· $0", because the group's total
//      summed positive amounts only. A paycheck is not a $0 merchant.
//   3. The category row's "N txns" (spendingGroups, isSpend-filtered) and the
//      queue header's merchant count counted DIFFERENT populations, so two
//      adjacent numbers on the same card disagreed by construction.
//
// THE DECIDED FIX (and why): the queue ranks merchants by their COUNTED
// spending — the same `counted` flag the adapter stamps from the ONE isSpend()
// predicate, split on rather than re-derived (the CategorySheet rule). That
// makes the queue answer the question it is actually for: "whose spending do I
// want categorized". But money is never hidden to get there — this codebase's
// standing rule is that unknowns stay VISIBLE and sized (the Uncategorized
// lesson, the amber tax bucket). So merchants with no counted spending are not
// dropped: they come back in a second, clearly labelled group with their real
// money in / money out totals, reachable and teachable, instead of being
// silently filtered or rendered as "$0".
//
// Ordering inside the spending group deliberately stays COUNT-first (spend as
// the tie-break), the rationale the queue shipped with: teaching writes a rule
// that fires forever, so repetition — not size — is what makes a merchant worth
// the tap. What changed is the population each number is computed over, not
// that rationale.

const round2 = (v) => Math.round(v * 100) / 100;

// toTxShape rows carry `transaction_date`; tolerate a raw row's `date` so this
// never depends on which side of the adapter handed it over.
function rowDate(t) {
  return String((t && (t.transaction_date || t.date)) || '');
}

function newer(a, b) {
  return !b || rowDate(a) > rowDate(b);
}

// rows:  the viewed month's Uncategorized transactions in toTxShape form —
//        { amount, counted, transaction_date, ... }. `counted` is the stamped
//        isSpend() verdict; this module never re-derives it.
// keyOf: descriptor → merchant key (Dashboard injects
//        merchantKey(txDescriptor(t)), the SAME key the classifier learns on,
//        so a rule taught here fires on the next pull). Injected rather than
//        imported to keep this module zero-import and its tests trivial.
//        A falsy key means "no descriptor to teach from" — those rows are
//        skipped, exactly as before.
//
// Returns { spending, other }, both fully sorted and NEVER capped here — the
// caller slices (the Show-more paging raises its slice bound over these full
// lists, so capping them in this module would silently break it; the old
// "N more behind these" remainder sentence read its counts off them too).
//   spending: at least one counted row. { spendCount, spent } are that row set;
//             `otherCount` records how many of the group's rows sat outside the
//             total, so a mixed merchant is not silently trimmed.
//   other:    no counted row at all. { moneyIn, otherOut } carry the real
//             amounts (paychecks, washed transfer legs, card payments,
//             hand-excluded rows) so the UI can label them instead of printing
//             a meaningless $0.
// `tx` is the row tapping the group opens: the most recent COUNTED row when
// there is one (teaching from a purchase, not from its refund), else the most
// recent row in the group.
export function teachQueueGroups(rows, keyOf) {
  const key = typeof keyOf === 'function' ? keyOf : () => '';
  const groups = new Map();

  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t) continue;
    let k = '';
    try {
      k = key(t) || '';
    } catch {
      k = '';
    }
    if (!k) continue;

    let g = groups.get(k);
    if (!g) {
      g = { key: k, spendCount: 0, spent: 0, otherCount: 0, moneyIn: 0, otherOut: 0, tx: null, spendTx: null };
      groups.set(k, g);
    }
    const amount = Number(t.amount) || 0;
    if (t.counted) {
      g.spendCount += 1;
      g.spent += amount;
      if (newer(t, g.spendTx)) g.spendTx = t;
    } else {
      g.otherCount += 1;
      if (amount < 0) g.moneyIn += -amount;
      else g.otherOut += amount;
    }
    if (newer(t, g.tx)) g.tx = t;
  }

  const all = [];
  for (const g of groups.values()) {
    all.push({
      key: g.key,
      spendCount: g.spendCount,
      spent: round2(g.spent),
      otherCount: g.otherCount,
      moneyIn: round2(g.moneyIn),
      otherOut: round2(g.otherOut),
      tx: g.spendTx || g.tx,
    });
  }

  // Alphabetical final tie-break in both lists (the biggestMovers rule): the
  // same data must always render the same order, or the row under the thumb
  // moves between renders.
  const spending = all
    .filter((g) => g.spendCount > 0)
    .sort((a, b) => b.spendCount - a.spendCount || b.spent - a.spent || a.key.localeCompare(b.key));
  const other = all
    .filter((g) => g.spendCount === 0)
    .sort(
      (a, b) =>
        b.otherCount - a.otherCount ||
        b.moneyIn + b.otherOut - (a.moneyIn + a.otherOut) ||
        a.key.localeCompare(b.key)
    );

  return { spending, other };
}

// The retraining progress meter's core: what fraction of the month's COUNTED
// spending already carries a real category. `groups` is the spendingGroups
// output ({ label, amount } rows — the isSpend() fold, so transfer legs, card
// payments and Returns can never dilute the share); the Uncategorized label is
// INJECTED to keep this module zero-import (the keyOf pattern above). Returns
// a 0..1 fraction, or null when the month has no positive counted spending —
// a meter with no denominator must render NOTHING, never a fake 100%.
export function categorizedShare(groups, uncategorizedLabel) {
  let total = 0;
  let uncat = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g) continue;
    const amount = Number(g.amount) || 0;
    total += amount;
    if (g.label === uncategorizedLabel) uncat += amount;
  }
  if (!(total > 0)) return null;
  // Clamp: a negative-net group (refunds exceeding spend under one label) can
  // push the raw ratio outside [0,1]; the meter stays a fraction.
  return Math.min(1, Math.max(0, 1 - uncat / total));
}

// The label a non-spending group renders INSTEAD of a dollar total — the fix
// for "· $0". `fmt` is the caller's money formatter (Dashboard's fmt), injected
// so this stays pure. A group with rows but no amounts (a $0 posting) says so
// rather than printing $0 as if that were its size.
export function nonSpendLabel(group, fmt) {
  const f = typeof fmt === 'function' ? fmt : (v) => String(v);
  const inn = (group && group.moneyIn) || 0;
  const out = (group && group.otherOut) || 0;
  if (inn > 0 && out > 0) return `${f(inn)} in / ${f(out)} out`;
  if (inn > 0) return `${f(inn)} in`;
  if (out > 0) return `${f(out)} out`;
  return 'no amount';
}
