// The Reflect hub's pure cores (PR F of the YNAB redesign, 2026-08-16).
// Zero imports. Two shapes feed it, both already computed elsewhere:
// spendingGroups' output for the breakdown card, and getCashFlow's periods
// for the income-vs-spending insight — this layer only ARRANGES numbers the
// shared model produced; it never re-derives spending or income.

// The Spending Breakdown card's stacked bar + top list: the biggest `max`
// positive groups plus one "All Others" bucket carrying the rest, each with
// its share of the total. Conservation by construction: the segments sum to
// exactly the positive groups' total, so the bar can never show more or less
// money than the month had (pinned in test/reflect.test.js).
export function breakdownSegments(groups, { max = 6 } = {}) {
  const positive = (groups || []).filter(g => g && Number(g.amount) > 0);
  const total = positive.reduce((s, g) => s + g.amount, 0);
  if (!total) return { total: 0, segments: [] };
  const top = positive.slice(0, max);
  const rest = positive.slice(max);
  const segments = top.map(g => ({ label: g.label, amount: g.amount, share: g.amount / total, others: false }));
  if (rest.length) {
    const amount = rest.reduce((s, g) => s + g.amount, 0);
    segments.push({ label: 'All Others', amount, share: amount / total, others: true });
  }
  return { total, segments };
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
