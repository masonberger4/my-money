// Tests for src/expectedTx.js — the pure expected/scheduled-transactions core.
// Hand-computed constants pin: the per-cadence match windows (weekly 4 /
// monthly 7 / annual 30 / once 7), the ±20% amount band edge, greedy
// nearest-date one-to-one matching with reversed-input parity, the roll-forward
// month-end clamp + Dec→Jan wrap, the derived status lifecycle (overdue is
// computed, never stored; "missed?" past staleDays is a flag, NEVER an
// auto-dismiss), last-amount seeding, the recurring_key dup-gate, and the
// display-only REGRESSION: walkEnvelopes output is byte-identical whether or
// not the expectations pipeline ran over the same rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchExpected, expectedByCategory, rollForwardDate, projectFutureCycles,
  expectedStatus, isMissedExpected, seedFromRecurring, isDuplicateExpected,
  EXPECTED_WINDOW_DAYS, EXPECTED_STALE_DAYS, EXPECTED_DUP_TOL_DAYS,
} from '../src/expectedTx.js';
import { walkEnvelopes } from '../src/envelopes.js';

let seq = 0;
const exp = (over = {}) => ({
  id: `e${seq++}`,
  recurring_key: null,
  description: 'STREAMFLIX.COM',
  category: 'Entertainment and subscriptions',
  account_id: null,
  amount: 15.99,
  due_date: '2026-08-05',
  cadence: 'monthly',
  status: 'pending',
  ...over,
});
const tx = (over = {}) => ({
  id: `t${seq++}`,
  merchant_name: 'STREAMFLIX.COM',
  description: '',
  transaction_date: '2026-08-04',
  amount: 15.99,
  account_id: 'a1',
  ...over,
});

// --- matchExpected -------------------------------------------------------------

test('a same-name charge near the due date matches', () => {
  const e = exp();
  const t = tx();
  assert.deepEqual(matchExpected([e], [t]), [{ expectationId: e.id, txId: t.id }]);
});

test('amount band edge: exactly 20% off matches, a cent more does not', () => {
  const e = exp({ amount: 100, description: 'ACME POWER' });
  const inTol = tx({ amount: 120, merchant_name: 'ACME POWER' });
  const outTol = tx({ amount: 120.01, merchant_name: 'ACME POWER' });
  assert.equal(matchExpected([e], [inTol]).length, 1);
  assert.equal(matchExpected([e], [outTol]).length, 0);
});

test('date window edges are per cadence: monthly 7, weekly 4, annual 30, once 7', () => {
  assert.deepEqual(EXPECTED_WINDOW_DAYS, { weekly: 4, monthly: 7, annual: 30, once: 7 });
  const cases = [
    ['monthly', '2026-08-17', '2026-08-18'], // due 08-10: +7 in, +8 out
    ['weekly', '2026-08-14', '2026-08-15'],
    ['annual', '2026-09-09', '2026-09-10'],
    ['once', '2026-08-17', '2026-08-18'],
  ];
  for (const [cadence, inDate, outDate] of cases) {
    const e = exp({ cadence, due_date: '2026-08-10' });
    assert.equal(matchExpected([e], [tx({ transaction_date: inDate })]).length, 1, `${cadence} in`);
    assert.equal(matchExpected([e], [tx({ transaction_date: outDate })]).length, 0, `${cadence} out`);
  }
});

test('explicit windowDays overrides the cadence default', () => {
  const e = exp({ due_date: '2026-08-10' });
  const t = tx({ transaction_date: '2026-08-12' });
  assert.equal(matchExpected([e], [t], { windowDays: 1 }).length, 0);
  assert.equal(matchExpected([e], [t], { windowDays: 2 }).length, 1);
});

test('account: null expectation account matches any; a set one must equal', () => {
  assert.equal(matchExpected([exp({ account_id: null })], [tx({ account_id: 'a2' })]).length, 1);
  assert.equal(matchExpected([exp({ account_id: 'a1' })], [tx({ account_id: 'a2' })]).length, 0);
  assert.equal(matchExpected([exp({ account_id: 'a1' })], [tx({ account_id: 'a1' })]).length, 1);
});

test('descriptor gate: unrelated names never match; merchantKey equality rescues token-poor names', () => {
  const e = exp({ description: 'CITY POWER LIGHT' });
  assert.equal(matchExpected([e], [tx({ merchant_name: 'METRO WATER UTILITY' })]).length, 0);
  // "H E B": every token < 3 chars, so descSimilarity is 0 — merchantKey
  // equality is the only way it can match, and it must.
  const heb = exp({ description: 'H E B' });
  assert.equal(matchExpected([heb], [tx({ merchant_name: 'H E B' })]).length, 1);
});

test('tx with no merchant_name falls back to its description', () => {
  const e = exp();
  const t = tx({ merchant_name: null, description: 'STREAMFLIX.COM' });
  assert.equal(matchExpected([e], [t]).length, 1);
});

test('greedy nearest-date, one-to-one, reversed-input parity', () => {
  const e1 = exp({ id: 'e1', due_date: '2026-08-05', description: 'ACME RENT', amount: 50 });
  const e2 = exp({ id: 'e2', due_date: '2026-08-10', description: 'ACME RENT', amount: 50 });
  const t1 = tx({ id: 't1', transaction_date: '2026-08-06', merchant_name: 'ACME RENT', amount: 50 });
  const t2 = tx({ id: 't2', transaction_date: '2026-08-09', merchant_name: 'ACME RENT', amount: 50 });
  // Distances: e1–t1 = 1, e2–t2 = 1, cross pairs = 4 → nearest first.
  const want = [
    { expectationId: 'e1', txId: 't1' },
    { expectationId: 'e2', txId: 't2' },
  ];
  assert.deepEqual(matchExpected([e1, e2], [t1, t2]), want);
  assert.deepEqual(matchExpected([e2, e1], [t2, t1]), want, 'reversed input, same pairs');
});

test('tie on distance breaks deterministically (due date, then expectation id)', () => {
  const e1 = exp({ id: 'e1', description: 'ACME RENT', amount: 50 });
  const e2 = exp({ id: 'e2', description: 'ACME RENT', amount: 50 });
  const t1 = tx({ id: 't1', transaction_date: '2026-08-05', merchant_name: 'ACME RENT', amount: 50 });
  const want = [{ expectationId: 'e1', txId: 't1' }];
  assert.deepEqual(matchExpected([e1, e2], [t1]), want);
  assert.deepEqual(matchExpected([e2, e1], [t1]), want);
});

test('a non-positive expected amount never matches (positive = money out)', () => {
  assert.equal(matchExpected([exp({ amount: 0 })], [tx({ amount: 0 })]).length, 0);
  assert.equal(matchExpected([exp({ amount: -20 })], [tx({ amount: -20 })]).length, 0);
});

// --- expectedByCategory ----------------------------------------------------------

test('expectedByCategory sums PENDING rows only', () => {
  const rows = [
    exp({ category: 'Utilities', amount: 120 }),
    exp({ category: 'Utilities', amount: 80.5 }),
    exp({ category: 'Groceries', amount: 200 }),
    exp({ category: 'Utilities', amount: 999, status: 'matched' }),
    exp({ category: 'Utilities', amount: 999, status: 'dismissed' }),
  ];
  assert.deepEqual(expectedByCategory(rows), { Utilities: 200.5, Groceries: 200 });
  assert.deepEqual(expectedByCategory([]), {});
});

// --- rollForwardDate ---------------------------------------------------------------

test('rollForwardDate: weekly +7 crosses month and year boundaries', () => {
  assert.equal(rollForwardDate('2026-08-28', 'weekly'), '2026-09-04');
  assert.equal(rollForwardDate('2026-12-29', 'weekly'), '2027-01-05');
});

test('rollForwardDate: monthly clamps to month end and wraps Dec→Jan', () => {
  assert.equal(rollForwardDate('2026-08-15', 'monthly'), '2026-09-15');
  assert.equal(rollForwardDate('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(rollForwardDate('2028-01-31', 'monthly'), '2028-02-29', 'leap February');
  assert.equal(rollForwardDate('2026-08-31', 'monthly'), '2026-09-30');
  assert.equal(rollForwardDate('2026-12-15', 'monthly'), '2027-01-15');
});

test('rollForwardDate: annual keeps month/day, Feb 29 clamps to Feb 28', () => {
  assert.equal(rollForwardDate('2026-07-04', 'annual'), '2027-07-04');
  assert.equal(rollForwardDate('2028-02-29', 'annual'), '2029-02-28');
  assert.equal(rollForwardDate('2026-12-31', 'annual'), '2027-12-31');
});

test('rollForwardDate: once (and unknown) never rolls', () => {
  assert.equal(rollForwardDate('2026-08-15', 'once'), null);
  assert.equal(rollForwardDate('2026-08-15', 'quarterly'), null);
  assert.equal(rollForwardDate(null, 'monthly'), null);
});

// --- projectFutureCycles ------------------------------------------------------------

test('projectFutureCycles lists dates strictly after the row, through the month key', () => {
  const row = { due_date: '2026-08-15', cadence: 'monthly' };
  assert.deepEqual(projectFutureCycles(row, '2026-11'), ['2026-09-15', '2026-10-15', '2026-11-15']);
  assert.deepEqual(projectFutureCycles(row, '2026-08'), [], 'nothing beyond its own month');
  assert.deepEqual(projectFutureCycles({ due_date: '2026-08-15', cadence: 'once' }, '2027-12'), []);
});

test('projectFutureCycles: weekly fills the month; month-end clamp is sticky', () => {
  assert.deepEqual(
    projectFutureCycles({ due_date: '2026-08-25', cadence: 'weekly' }, '2026-09'),
    ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']
  );
  // Documented: once clamped to the 28th the projection stays there — the
  // clamp is per-roll, not "remember the 31st". Cheap, and render-only.
  assert.deepEqual(
    projectFutureCycles({ due_date: '2026-01-31', cadence: 'monthly' }, '2026-04'),
    ['2026-02-28', '2026-03-28', '2026-04-28']
  );
});

// --- status lifecycle ------------------------------------------------------------------

test('expectedStatus: stored matched/dismissed pass through; overdue is DERIVED from the clock', () => {
  assert.equal(expectedStatus(exp({ status: 'matched' }), '2026-09-01'), 'matched');
  assert.equal(expectedStatus(exp({ status: 'dismissed' }), '2026-09-01'), 'dismissed');
  const p = exp({ due_date: '2026-08-05' });
  assert.equal(expectedStatus(p, null), 'pending', 'no clock, no overdue — stays pure');
  assert.equal(expectedStatus(p, '2026-08-05'), 'pending', 'due today is not overdue');
  assert.equal(expectedStatus(p, '2026-08-06'), 'overdue');
});

test('isMissedExpected: strictly past staleDays (monthly 60, weekly/once 14), never for matched', () => {
  assert.deepEqual(EXPECTED_STALE_DAYS, { weekly: 14, monthly: 60, annual: 60, once: 14 });
  const m = exp({ due_date: '2026-06-01', cadence: 'monthly' });
  assert.equal(isMissedExpected(m, '2026-07-31'), false, '60 days late — not yet');
  assert.equal(isMissedExpected(m, '2026-08-01'), true, '61 days late — missed?');
  assert.equal(expectedStatus(m, '2026-08-01'), 'overdue', 'missed is a FLAG — the row is still overdue-pending, never auto-dismissed');
  const w = exp({ due_date: '2026-08-01', cadence: 'weekly' });
  assert.equal(isMissedExpected(w, '2026-08-15'), false);
  assert.equal(isMissedExpected(w, '2026-08-16'), true);
  assert.equal(isMissedExpected(exp({ status: 'matched', due_date: '2020-01-01' }), '2026-08-01'), false);
  assert.equal(isMissedExpected(m, null), false, 'no clock, no verdict');
});

// --- seeding + dup-gate ----------------------------------------------------------------

test('seedFromRecurring seeds the LAST amount, not the median', () => {
  const item = {
    key: 'STREAMFLIX COM', name: 'STREAMFLIX.COM',
    category: 'Entertainment and subscriptions', account_id: 'a1',
    monthlyAmount: 15.99, medianAmount: 15.99, lastAmount: 17.99,
    nextDate: '2026-09-04', cadence: 'monthly',
  };
  assert.deepEqual(seedFromRecurring(item), {
    recurring_key: 'STREAMFLIX COM',
    description: 'STREAMFLIX.COM',
    category: 'Entertainment and subscriptions',
    account_id: 'a1',
    amount: 17.99,
    due_date: '2026-09-04',
    cadence: 'monthly',
  });
});

test('dup-gate: same key within the cadence tolerance is a duplicate — seeding twice is idempotent', () => {
  assert.deepEqual(EXPECTED_DUP_TOL_DAYS, { weekly: 2, monthly: 4, annual: 15, once: 0 });
  const fields = { recurring_key: 'STREAMFLIX COM', due_date: '2026-09-04', cadence: 'monthly' };
  const pending = [exp({ recurring_key: 'STREAMFLIX COM', due_date: '2026-09-08' })];
  assert.equal(isDuplicateExpected(fields, pending), true, '±4 days, same cycle');
  assert.equal(isDuplicateExpected(fields, [exp({ recurring_key: 'STREAMFLIX COM', due_date: '2026-09-09' })]), false, '5 days out — a new cycle');
  assert.equal(isDuplicateExpected(fields, [exp({ recurring_key: 'OTHER KEY', due_date: '2026-09-04' })]), false);
  assert.equal(
    isDuplicateExpected(fields, [exp({ recurring_key: 'STREAMFLIX COM', due_date: '2026-09-04', status: 'dismissed' })]),
    false, 'dismissed rows never gate — the user said not this cycle, re-adding is deliberate'
  );
  assert.equal(isDuplicateExpected({ recurring_key: null, due_date: '2026-09-04', cadence: 'once' }, pending), false,
    'hand-typed rows (null key) never gate');
});

// --- the display-only REGRESSION ---------------------------------------------------------

test('REGRESSION: walkEnvelopes output is byte-identical with the expectations pipeline present', () => {
  const walkInput = () => ({
    assignments: [
      { category: 'Utilities', month: '2026-07', assigned: 100 },
      { category: 'Utilities', month: '2026-08', assigned: 100 },
    ],
    spending: [
      { category: 'Utilities', month: '2026-07', spent: 60 },
      { category: 'Utilities', month: '2026-08', spent: 40 },
    ],
    settings: [{ category: 'Utilities', target: 100, targetKind: 'monthly', targetDate: null, rollover: true }],
    year: 2026, month: 8,
  });
  const before = JSON.stringify(walkEnvelopes(walkInput()));

  // Run the whole expectations pipeline over rows sharing those categories…
  const pending = [exp({ category: 'Utilities', amount: 120, due_date: '2026-08-20' })];
  const txRows = [tx({ transaction_date: '2026-08-19', amount: 120, merchant_name: 'STREAMFLIX.COM' })];
  const txSnapshot = JSON.parse(JSON.stringify(txRows));
  const pendingSnapshot = JSON.parse(JSON.stringify(pending));
  matchExpected(pending, txRows);
  expectedByCategory(pending);
  projectFutureCycles(pending[0], '2026-12');

  // …and the walk (same inputs) is unchanged, byte for byte, and the pipeline
  // mutated nothing it was handed.
  assert.equal(JSON.stringify(walkEnvelopes(walkInput())), before);
  assert.deepEqual(txRows, txSnapshot, 'matchExpected must not mutate transactions');
  assert.deepEqual(pending, pendingSnapshot, 'matchExpected must not mutate expectations');
});
