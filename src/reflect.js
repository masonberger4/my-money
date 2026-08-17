// The Reflect hub's pure cores (PR F of the YNAB redesign, 2026-08-16).
// Zero imports. Two shapes feed it, both already computed elsewhere:
// spendingGroups' output for the breakdown card, and getCashFlow's periods
// for the income-vs-spending insight and the income drill-in — this layer only
// ARRANGES numbers the shared model produced; it never re-derives spending or
// income.

// The Spending Breakdown card's stacked bar + top list: the biggest `max`
// positive groups plus one "All Others" bucket carrying the rest, each with
// its share of the GROSS total. Conservation by construction: the segments sum
// to exactly the positive groups' total, so the bar can never show more or
// less money than the month had (pinned in test/reflect.test.js).
//
// `returned` closes the gap refund netting opened (2026-08-17). A stacked bar
// cannot draw a negative slice, so negative groups are excluded from the
// segments — but the card's headline is the month's NET spending, and without
// this the bar and the list would silently sum to more than the headline with
// no row explaining the difference. Reporting it lets the card show the
// subtraction (net = total − returned) instead of hiding it, which is the same
// unknowns-stay-visible instinct as the tax worksheet's amber bucket.
export function breakdownSegments(groups, { max = 6 } = {}) {
  const all = (groups || []).filter(g => g && Number.isFinite(Number(g.amount)));
  const positive = all.filter(g => Number(g.amount) > 0);
  const returned = all.reduce((s, g) => (g.amount < 0 ? s - g.amount : s), 0);
  const total = positive.reduce((s, g) => s + g.amount, 0);
  if (!total) return { total: 0, segments: [], returned };
  const top = positive.slice(0, max);
  const rest = positive.slice(max);
  const segments = top.map(g => ({ label: g.label, amount: g.amount, share: g.amount / total, others: false }));
  if (rest.length) {
    const amount = rest.reduce((s, g) => s + g.amount, 0);
    segments.push({ label: 'All Others', amount, share: amount / total, others: true });
  }
  return { total, segments, returned };
}

// The income drill-in's arrangement: getCashFlow's periods → NEWEST-FIRST
// month sections, each carrying that month's income rows and the month's own
// income figure, plus the window's total and row count.
//
// Two rules, both deliberate:
//   • The section total is the period's OWN `income.amount` — the number the
//     chart drew — never a re-fold of the rows. The adapter derives both from
//     one isIncome() pass, so they cannot disagree; reading the measured
//     figure is what makes that guarantee visible rather than coincidental.
//     Same reasoning as toTxShape's `counted`: the list behind a number must
//     not be able to contradict the number that opened it.
//   • Months with NO income are KEPT, not filtered out. "$0 measured in March"
//     is the answer to a real question (a month the ledger doesn't reach, or a
//     paycheck that washed against a transfer); dropping the row would hide it
//     and make the window look shorter than it is — the unknowns-stay-visible
//     rule that `Uncategorized` and the amber tax bucket encode elsewhere.
export function incomeSections(periods) {
  const sections = (periods || []).map(p => ({
    label: (p && p.label) || '',
    start: (p && p.start) || null,
    amount: Number(p && p.income && p.income.amount) || 0,
    // getCashFlow attaches the rows already ordered newest-first (the range
    // fetch orders date desc, id desc and the bucketing fold preserves it) —
    // the caller's sort IS the display order, groupByDay's contract.
    rows: (p && p.income && p.income.transactions) || [],
  }));
  // getCashFlow emits oldest→newest (chart order); a ledger reads newest-first.
  sections.reverse();
  const total = sections.reduce((s, x) => s + x.amount, 0);
  return {
    total,
    // The per-month rate — the SAME arithmetic incomeVsSpendingInsight does
    // (sum ÷ period count, no months dropped), so the figure printed on the
    // card is the figure the sheet it opens quotes back. Two reviewers read
    // the $26,100 header as contradicting the $4,350/mo they tapped; stating
    // both, from one derivation, is what makes the link legible instead of
    // arithmetic the reader has to do. Pinned equal in test/reflect.test.js.
    average: sections.length ? total / sections.length : 0,
    count: sections.reduce((s, x) => s + x.rows.length, 0),
    sections,
  };
}

// The Income vs. Spending card's plain-language sentence. Averages over the
// supplied periods (getCashFlow's shape: {income, spending}); the ±10% band
// keeps the wording honest at the boundary — "about as much as you make"
// rather than flip-flopping between less/more on a rounding error. Returns
// null when there is nothing honest to say (no periods, or no measured
// income at all — a sentence about spending vs income needs an income).
export function incomeVsSpendingInsight(periods, { band = 0.1 } = {}) {
  // getCashFlow's periods nest the figures ({income:{amount}}); plain
  // {income, spending} numbers are accepted too so the tests read naturally.
  const num = v => Number(v && typeof v === 'object' ? v.amount : v);
  const rows = (periods || []).filter(p => p && Number.isFinite(num(p.income)) && Number.isFinite(num(p.spending)));
  if (!rows.length) return null;
  const income = rows.reduce((s, p) => s + num(p.income), 0) / rows.length;
  const spending = rows.reduce((s, p) => s + num(p.spending), 0) / rows.length;
  if (income <= 0) return null;
  const ratio = spending / income;
  const kind = ratio < 1 - band ? 'less' : ratio > 1 + band ? 'more' : 'about';
  const sentence =
    kind === 'less' ? "On average, you're spending less than you make."
    : kind === 'more' ? "On average, you're spending more than you make."
    : "On average, you're spending about as much as you make.";
  return { kind, sentence, avgIncome: income, avgSpending: spending };
}
