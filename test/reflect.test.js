// The Reflect hub's pure cores (src/reflect.js): the stacked bar must
// conserve the month's total exactly, All-Others must bucket the tail, and
// the insight sentence must band honestly — including saying NOTHING when
// there is no measured income to compare against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdownSegments, incomeVsSpendingInsight } from '../src/reflect.js';

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
