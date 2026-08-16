// The Reflect hub's pure cores (src/reflect.js): the stacked bar must
// conserve the month's total exactly, All-Others must bucket the tail, the
// insight sentence must band honestly — including saying NOTHING when there is
// no measured income to compare against — and the income drill-in's sections
// must read the chart's own numbers rather than re-adding the rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdownSegments, incomeVsSpendingInsight, incomeSections } from '../src/reflect.js';

const g = (label, amount) => ({ label, amount, transaction_count: 1, percent_of_total: 0 });

test('segments conserve the positive total exactly and shares sum to 1', () => {
  const groups = [g('Mortgage', 2070.48), g('Rent', 1800), g('Loan', 1079.1), g('Memberships', 791.02),
    g('Food', 404.81), g('Gas', 300), g('Coffee', 120.5), g('Misc', 55.09)];
  const { total, segments } = breakdownSegments(groups, { max: 5 });
  const segSum = segments.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(segSum - total) < 1e-9, 'segments sum to the total');
  assert.ok(Math.abs(segments.reduce((s, x) => s + x.share, 0) - 1) < 1e-9, 'shares sum to 1');
  assert.equal(segments.length, 6, 'five top + All Others');
  const others = segments[segments.length - 1];
  assert.equal(others.label, 'All Others');
  assert.ok(others.others);
  assert.ok(Math.abs(others.amount - (300 + 120.5 + 55.09)) < 1e-9, 'tail bucketed');
});

test('no All Others bucket when the list fits; zero/negative groups dropped', () => {
  const { segments } = breakdownSegments([g('A', 10), g('B', 5), g('Zero', 0), g('Neg', -3)], { max: 6 });
  assert.deepEqual(segments.map(s => s.label), ['A', 'B']);
  assert.ok(segments.every(s => !s.others));
});

test('empty/garbage input degrades to an empty bar, never throws', () => {
  assert.deepEqual(breakdownSegments([]), { total: 0, segments: [] });
  assert.deepEqual(breakdownSegments(null), { total: 0, segments: [] });
  assert.deepEqual(breakdownSegments([g('Zero', 0)]), { total: 0, segments: [] });
});

test('insight bands: less / about / more, ±10%', () => {
  const mk = (income, spending) => [{ income, spending }];
  assert.equal(incomeVsSpendingInsight(mk(1000, 800)).kind, 'less');
  assert.equal(incomeVsSpendingInsight(mk(1000, 950)).kind, 'about');
  assert.equal(incomeVsSpendingInsight(mk(1000, 1050)).kind, 'about');
  assert.equal(incomeVsSpendingInsight(mk(1000, 1200)).kind, 'more');
  assert.match(incomeVsSpendingInsight(mk(1000, 950)).sentence, /about as much as you make/);
});

test('insight averages across periods', () => {
  const out = incomeVsSpendingInsight([
    { income: 1000, spending: 400 },
    { income: 1000, spending: 500 },
  ]);
  assert.equal(out.kind, 'less');
  assert.equal(out.avgSpending, 450);
});

test('insight reads getCashFlow\'s nested shape ({income:{amount}})', () => {
  const out = incomeVsSpendingInsight([
    { label: 'Jul', income: { amount: 1000 }, spending: { amount: 400 } },
  ]);
  assert.equal(out.kind, 'less');
});

test('insight says NOTHING without measured income (never a claim from $0)', () => {
  assert.equal(incomeVsSpendingInsight([]), null);
  assert.equal(incomeVsSpendingInsight(null), null);
  assert.equal(incomeVsSpendingInsight([{ income: 0, spending: 500 }]), null);
});

// --- incomeSections: the income drill-in's arrangement -----------------------

const period = (label, amount, rows = []) => ({
  label, start: `2026-${label}-01`, spending: { amount: 100 },
  income: { amount, transactions: rows },
});
const inRow = (id, amount) => ({ id, amount, transaction_date: '2026-07-15' });

test('sections run newest-first and carry the period\'s OWN income figure', () => {
  // getCashFlow emits oldest→newest (chart order); a ledger reads newest-first.
  const out = incomeSections([
    period('06', 4200, [inRow('a', -4200)]),
    period('07', 4500, [inRow('b', -2200), inRow('c', -2300)]),
    period('08', 2200, [inRow('d', -2200)]),
  ]);
  assert.deepEqual(out.sections.map(s => s.label), ['08', '07', '06']);
  assert.deepEqual(out.sections.map(s => s.amount), [2200, 4500, 4200]);
  assert.equal(out.total, 10900);
  assert.equal(out.count, 4);
  assert.deepEqual(out.sections[1].rows.map(r => r.id), ['b', 'c'], 'row order is preserved, not re-sorted');
});

test('the sheet quotes back the SAME rate the card was showing when it was tapped', () => {
  // The number on the Reflect card is incomeVsSpendingInsight's avgIncome; the
  // sheet it opens headlines the window TOTAL. Both reviewers of this feature
  // read that as a contradiction, so the sheet states the rate too — and it
  // must be the same derivation, not a second one that can drift.
  const periods = [
    period('06', 4200, [inRow('a', -4200)]),
    period('07', 4500, [inRow('b', -4500)]),
    period('08', 2100, [inRow('c', -2100)]),
  ];
  assert.equal(incomeSections(periods).average, incomeVsSpendingInsight(periods).avgIncome);
  // …including over $0 months, which BOTH divide by (neither drops a period).
  const withGap = [period('06', 0), ...periods];
  assert.equal(incomeSections(withGap).average, incomeVsSpendingInsight(withGap).avgIncome);
  assert.equal(incomeSections([]).average, 0, 'no periods is 0, never NaN');
});

test('a section total is the MEASURED figure, never a re-fold of the rows', () => {
  // The whole point: the adapter derives amount and rows from one isIncome()
  // pass, so the sheet quotes the number the bar drew instead of recomputing
  // it. If the two ever disagreed, silently re-adding the rows would hide the
  // bug — and the drill-in would contradict the chart it was opened from.
  const out = incomeSections([period('07', 4500, [inRow('b', -1)])]);
  assert.equal(out.sections[0].amount, 4500);
  assert.equal(out.total, 4500);
});

test('a month with NO income is KEPT, not filtered away', () => {
  // "$0 measured in March" is an answer — the ledger may not reach back that
  // far, or a paycheck may have washed against a transfer. Dropping the
  // section would make the window read shorter than it is.
  const out = incomeSections([period('03', 0), period('04', 2200, [inRow('a', -2200)])]);
  assert.deepEqual(out.sections.map(s => s.label), ['04', '03']);
  assert.equal(out.sections[1].rows.length, 0);
  assert.equal(out.count, 1);
  assert.equal(out.total, 2200);
});

test('empty/garbage input degrades to an empty report, never throws', () => {
  const empty = { total: 0, average: 0, count: 0, sections: [] };
  assert.deepEqual(incomeSections([]), empty);
  assert.deepEqual(incomeSections(null), empty);
  assert.deepEqual(incomeSections(undefined), empty);
  // A pre-drill-in cashFlow payload (no `transactions` key) still reads: the
  // totals survive and the row lists are simply empty, which is what gates the
  // affordance off rather than crashing the hub.
  const legacy = incomeSections([{ label: 'Jul', income: { amount: 4500 } }]);
  assert.equal(legacy.total, 4500);
  assert.equal(legacy.count, 0);
  assert.deepEqual(legacy.sections[0].rows, []);
  // A period with no income key at all reads as $0 rather than NaN.
  assert.equal(incomeSections([{ label: 'Jul' }]).total, 0);
});
