// Tests for the pure envelope-budgeting model (src/envelopes.js).
//
// Two of these are regressions for bugs that were caught in review on the
// original branch and are recorded as "decided, don't relitigate" in CLAUDE.md:
//   1. A missing assignment must read as 0, NEVER as a fallback to the funding
//      target — otherwise every untouched month accrues (target − spent) into
//      the carry and manufactures a phantom balance on day one.
//   2. The walk must start at each category's own first assignment however old,
//      NOT inside a fixed window — a 24-month clamp froze a long-running
//      sinking fund at a stale balance that drifted further every month.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  walkEnvelopes,
  targetNeed,
  readyToAssign,
  planMove,
  monthKey,
  shiftMonthKey,
  normalizeMonthKey,
  monthsUntil,
  cents,
  MAX_WALK_MONTHS,
} from '../src/envelopes.js';

const a = (category, month, assigned) => ({ category, month, assigned });
const s = (category, month, spent) => ({ category, month, spent });

// Pulls one category's row out of a walk result.
function row(result, category) {
  return result.categories.find(r => r.category === category);
}

// --- the basic identity ------------------------------------------------------

test('available = assigned + carry - spent, and carry is last month available', () => {
  const assignments = [a('Groceries', '2026-01', 500), a('Groceries', '2026-02', 500)];
  const spending = [s('Groceries', '2026-01', 400), s('Groceries', '2026-02', 450)];

  const jan = row(walkEnvelopes({ assignments, spending, year: 2026, month: 1 }), 'Groceries');
  assert.deepEqual(
    { assigned: jan.assigned, rolledOver: jan.rolledOver, spent: jan.spent, available: jan.available },
    { assigned: 500, rolledOver: 0, spent: 400, available: 100 }
  );

  const feb = row(walkEnvelopes({ assignments, spending, year: 2026, month: 2 }), 'Groceries');
  assert.equal(feb.rolledOver, 100, 'January leftover carries into February');
  assert.equal(feb.available, 150, '500 assigned + 100 carried - 450 spent');
});

test('a month with no assignment contributes 0 and still carries', () => {
  const assignments = [a('Fun', '2026-01', 300)];
  const spending = [s('Fun', '2026-01', 100), s('Fun', '2026-02', 50)];
  const feb = row(walkEnvelopes({ assignments, spending, year: 2026, month: 2 }), 'Fun');
  assert.equal(feb.assigned, 0);
  assert.equal(feb.rolledOver, 200);
  assert.equal(feb.available, 150);
});

// --- regression 1: no fallback to the funding target -------------------------

test('REGRESSION: a target with no assignment never accrues a phantom balance', () => {
  // Groceries has a $600/mo target and real spending, but the household has
  // never actually assigned a dollar to it. If the walk fell back to the target
  // for un-assigned months, June would show five months of (600 − spent) carry.
  const settings = [{ category: 'Groceries', target: 600, rollover: true }];
  const spending = ['01', '02', '03', '04', '05', '06'].map(m => s('Groceries', `2026-${m}`, 400));

  const jun = row(walkEnvelopes({ assignments: [], spending, settings, year: 2026, month: 6 }), 'Groceries');
  assert.equal(jun.assigned, 0);
  assert.equal(jun.rolledOver, 0, 'nothing was ever assigned, so nothing can roll over');
  assert.equal(jun.available, -400, 'only this month spending, straight out of an empty envelope');
});

test('a category that has never been assigned does not inherit another category start', () => {
  // Savings opened its envelope in Jan 2025. Dining never had one, but has been
  // spent in every month since. Dining must not walk from Jan 2025 and arrive
  // at Jun 2026 carrying 17 months of "debt".
  const assignments = [a('Savings', '2025-01', 1000)];
  const spending = [];
  for (let i = 0; i < 18; i++) spending.push(s('Dining', shiftMonthKey('2025-01', i), 200));

  const dining = row(walkEnvelopes({ assignments, spending, year: 2026, month: 6 }), 'Dining');
  assert.equal(dining.rolledOver, 0);
  assert.equal(dining.available, -200, 'just this month, not the whole history');
});

// --- regression 2: no date clamp on the walk ---------------------------------

test('REGRESSION: a sinking fund funded past the old 24-month window is not frozen', () => {
  // $200/month into a vacation fund, never spent, for 30 months. Under the
  // reverted 24-month clamp this froze at 24 × 200 and drifted $200 further
  // behind every month.
  const MONTHS = 30;
  const assignments = [];
  for (let i = 0; i < MONTHS; i++) assignments.push(a('Vacation', shiftMonthKey('2026-01', i), 200));

  const last = shiftMonthKey('2026-01', MONTHS - 1);
  const [y, m] = last.split('-').map(Number);
  const result = row(walkEnvelopes({ assignments, spending: [], year: y, month: m }), 'Vacation');

  assert.equal(result.available, MONTHS * 200, 'every assignment since the envelope opened counts');
  assert.equal(result.rolledOver, (MONTHS - 1) * 200);
  assert.equal(result.truncated, undefined);
});

test('the runaway guard flags truncation instead of silently returning nothing', () => {
  // A corrupt month value far outside any real budget must not hang the loop or
  // quietly drop every category — it clamps and says so.
  const assignments = [a('Groceries', '1900-01', 50), a('Groceries', '2026-06', 100)];
  const result = walkEnvelopes({ assignments, spending: [], year: 2026, month: 6 });
  assert.equal(result.truncated, true);
  assert.equal(row(result, 'Groceries').assigned, 100, 'the walk still produces this month');
});

// --- rollover off ------------------------------------------------------------

test('rollover off resets the envelope every month, leftover or overspent', () => {
  const assignments = [a('Fun', '2026-01', 300), a('Fun', '2026-02', 300)];
  const settings = [{ category: 'Fun', rollover: false }];

  const leftover = row(
    walkEnvelopes({ assignments, spending: [s('Fun', '2026-01', 100)], settings, year: 2026, month: 2 }),
    'Fun'
  );
  assert.equal(leftover.rolledOver, 0, '$200 left in January does not carry');
  assert.equal(leftover.available, 300);

  const overspent = row(
    walkEnvelopes({ assignments, spending: [s('Fun', '2026-01', 900)], settings, year: 2026, month: 2 }),
    'Fun'
  );
  assert.equal(overspent.rolledOver, 0, 'the January hole does not carry either');
  assert.equal(overspent.available, 300);
});

test('overspend carries the category negative when rollover is on', () => {
  const assignments = [a('Fun', '2026-01', 100)];
  const spending = [s('Fun', '2026-01', 400)];
  const feb = row(walkEnvelopes({ assignments, spending, year: 2026, month: 2 }), 'Fun');
  assert.equal(feb.rolledOver, -300);
  assert.equal(feb.available, -300);
});

// --- zero assignments are equivalent to no assignment ------------------------

test('a zero assignment does not open an envelope', () => {
  // moveMoney writes a 0 row when a leg lands on exactly zero. That row must
  // stay equivalent to no row at all, or the category would start walking from
  // that month and turn its earlier spending into rolled-over debt.
  const withZero = walkEnvelopes({
    assignments: [a('Dining', '2026-01', 0)],
    spending: [s('Dining', '2026-01', 250), s('Dining', '2026-02', 100)],
    year: 2026,
    month: 2,
  });
  const withNothing = walkEnvelopes({
    assignments: [],
    spending: [s('Dining', '2026-01', 250), s('Dining', '2026-02', 100)],
    year: 2026,
    month: 2,
  });
  assert.equal(row(withZero, 'Dining').rolledOver, 0);
  assert.equal(row(withZero, 'Dining').available, row(withNothing, 'Dining').available);
});

// --- viewing other months ----------------------------------------------------

test('viewing a past month shows that month, uncontaminated by later data', () => {
  const assignments = [a('Fun', '2026-03', 200), a('Fun', '2026-04', 999)];
  const spending = [s('Fun', '2026-03', 50), s('Fun', '2026-04', 800)];
  const mar = row(walkEnvelopes({ assignments, spending, year: 2026, month: 3 }), 'Fun');
  assert.equal(mar.assigned, 200);
  assert.equal(mar.spent, 50);
  assert.equal(mar.available, 150, 'April is in the future from March and must not appear');
});

test('viewing a future month carries the balance forward with no spending yet', () => {
  const assignments = [a('Fun', '2026-03', 200), a('Fun', '2026-05', 100)];
  const spending = [s('Fun', '2026-03', 50)];
  const may = row(walkEnvelopes({ assignments, spending, year: 2026, month: 5 }), 'Fun');
  assert.equal(may.rolledOver, 150);
  assert.equal(may.spent, 0);
  assert.equal(may.available, 250, 'you can budget ahead into a month with no transactions');
});

test('a category assigned only in the future is absent from an earlier month', () => {
  const result = walkEnvelopes({
    assignments: [a('Gifts', '2026-12', 400)],
    spending: [],
    year: 2026,
    month: 6,
  });
  assert.equal(row(result, 'Gifts'), undefined);
  assert.equal(result.totals.assigned, 0);
});

// --- totals ------------------------------------------------------------------

test('totals cover only budgeted categories, not incidental spending', () => {
  const result = walkEnvelopes({
    assignments: [a('Groceries', '2026-06', 500)],
    spending: [s('Groceries', '2026-06', 300), s('Pets', '2026-06', 120)],
    year: 2026,
    month: 6,
  });
  assert.ok(row(result, 'Pets'), 'an unbudgeted spent category still gets a row');
  assert.equal(result.totals.spent, 300, 'but it is not part of the budget totals');
  assert.equal(result.totals.assigned, 500);
  assert.equal(result.totals.available, 200);
});

test('a category with a target but no money still counts toward totals', () => {
  const result = walkEnvelopes({
    assignments: [],
    spending: [],
    settings: [{ category: 'Groceries', target: 600 }],
    year: 2026,
    month: 6,
  });
  assert.equal(result.totals.target, 600);
  assert.equal(result.totals.assigned, 0);
});

// --- money math --------------------------------------------------------------

test('a long walk of repeating decimals does not drift or render as minus zero', () => {
  const assignments = [];
  const spending = [];
  for (let i = 0; i < 36; i++) {
    assignments.push(a('Coffee', shiftMonthKey('2025-01', i), 0.1));
    spending.push(s('Coffee', shiftMonthKey('2025-01', i), 0.1));
  }
  const last = shiftMonthKey('2025-01', 35);
  const [y, m] = last.split('-').map(Number);
  const result = row(walkEnvelopes({ assignments, spending, year: y, month: m }), 'Coffee');
  assert.equal(result.available, 0);
  assert.ok(!Object.is(result.available, -0), 'must not render as "−$0"');
  assert.equal(result.rolledOver, 0);
});

test('cents snaps float residue', () => {
  assert.equal(cents(0.1 + 0.2), 0.3);
  assert.equal(cents(1.005), 1);
});

// --- funding targets ---------------------------------------------------------

test('a monthly target asks for the shortfall and nothing once funded', () => {
  const base = { target: 400, targetKind: 'monthly', rolledOver: 0 };
  const at = (year, month) => ({ year, month });
  assert.equal(targetNeed({ ...base, assigned: 0 }, at(2026, 6)), 400);
  assert.equal(targetNeed({ ...base, assigned: 150 }, at(2026, 6)), 250);
  assert.equal(targetNeed({ ...base, assigned: 400 }, at(2026, 6)), 0);
  assert.equal(targetNeed({ ...base, assigned: 900 }, at(2026, 6)), 0, 'over-funded asks for nothing');
});

test('a by-date target spreads the shortfall over the months remaining', () => {
  // $2,400 needed by June 2027, viewed in July 2026 => 12 months inclusive.
  const base = { target: 2400, targetKind: 'by_date', targetDate: '2027-06-01' };
  assert.equal(targetNeed({ ...base, rolledOver: 0, assigned: 0 }, { year: 2026, month: 7 }), 200);
  assert.equal(
    targetNeed({ ...base, rolledOver: 0, assigned: 200 }, { year: 2026, month: 7 }),
    0,
    'funding it twice in one month is a no-op, not a double payment'
  );
  assert.equal(
    targetNeed({ ...base, rolledOver: 1200, assigned: 0 }, { year: 2027, month: 1 }),
    200,
    'money already carried in counts: (2400-1200) over the 6 months left'
  );
  assert.equal(
    targetNeed({ ...base, rolledOver: 2400, assigned: 0 }, { year: 2026, month: 7 }),
    0,
    'already fully funded'
  );
});

test('a by-date target whose date has passed asks for the whole remainder now', () => {
  const overdue = { target: 1000, targetKind: 'by_date', targetDate: '2026-01-01', rolledOver: 250, assigned: 0 };
  assert.equal(targetNeed(overdue, { year: 2026, month: 7 }), 750);
});

test('a by-date target with no date behaves like a monthly top-up, not a crash', () => {
  const row_ = { target: 500, targetKind: 'by_date', targetDate: null, rolledOver: 0, assigned: 100 };
  assert.equal(targetNeed(row_, { year: 2026, month: 7 }), 400);
});

test('no target means nothing to fund', () => {
  assert.equal(targetNeed({ target: null, assigned: 0, rolledOver: 0 }, { year: 2026, month: 7 }), 0);
  assert.equal(targetNeed(null, { year: 2026, month: 7 }), 0);
});

// --- Ready to Assign ---------------------------------------------------------

test('Ready to Assign is income minus assigned, and null when income is unset', () => {
  const totals = { assigned: 3200 };
  assert.equal(readyToAssign(4000, totals), 800);
  assert.equal(readyToAssign(3000, totals), -200, 'over-assigned goes negative');
  assert.equal(readyToAssign(null, totals), null);
  assert.equal(readyToAssign('', totals), null);
  assert.equal(readyToAssign('not a number', totals), null);
  assert.equal(readyToAssign(0, totals), -3200, 'a real zero is not "unset"');
});

// --- moving money between envelopes ------------------------------------------

test('a move takes from one envelope and gives to the other', () => {
  const legs = planMove({
    from: 'Groceries',
    to: 'Dining',
    amount: 40,
    assignedByCategory: { Groceries: 500, Dining: 100 },
  });
  assert.deepEqual(legs, [
    { category: 'Groceries', assigned: 460 },
    { category: 'Dining', assigned: 140 },
  ]);
});

test('a move out of an envelope that has nothing goes negative rather than failing', () => {
  const legs = planMove({ from: 'Groceries', to: 'Dining', amount: 25, assignedByCategory: {} });
  assert.deepEqual(legs, [
    { category: 'Groceries', assigned: -25 },
    { category: 'Dining', assigned: 25 },
  ]);
});

test('a move is rejected when it would be a no-op or nonsense', () => {
  const at = { assignedByCategory: { A: 10, B: 10 } };
  assert.equal(planMove({ from: 'A', to: 'A', amount: 5, ...at }), null, 'same category');
  assert.equal(planMove({ from: 'A', to: 'B', amount: 0, ...at }), null, 'zero');
  assert.equal(planMove({ from: 'A', to: 'B', amount: -5, ...at }), null, 'negative');
  assert.equal(planMove({ from: 'A', to: 'B', amount: 'x', ...at }), null, 'unparseable');
  assert.equal(planMove({ from: '', to: 'B', amount: 5, ...at }), null, 'missing source');
});

test('the two legs of a move always sum to zero', () => {
  const before = { Groceries: 137.55, Dining: 12.4 };
  const legs = planMove({ from: 'Groceries', to: 'Dining', amount: 33.33, assignedByCategory: before });
  const delta = legs.reduce((sum, l) => sum + (l.assigned - (before[l.category] || 0)), 0);
  assert.equal(cents(delta), 0);
});

// --- month key helpers -------------------------------------------------------

test('month keys normalize, shift across year boundaries, and reject junk', () => {
  assert.equal(monthKey(2026, 7), '2026-07');
  assert.equal(normalizeMonthKey('2026-07-15'), '2026-07');
  assert.equal(normalizeMonthKey('2026-07'), '2026-07');
  assert.equal(normalizeMonthKey('2026-13'), null);
  assert.equal(normalizeMonthKey('2026-00'), null);
  assert.equal(normalizeMonthKey(''), null);
  assert.equal(normalizeMonthKey(null), null);

  assert.equal(shiftMonthKey('2026-12', 1), '2027-01');
  assert.equal(shiftMonthKey('2026-01', -1), '2025-12');
  assert.equal(shiftMonthKey('2026-06', 12), '2027-06');
  assert.equal(shiftMonthKey('2026-06', -12), '2025-06');
  assert.equal(shiftMonthKey('2026-01', -13), '2024-12');
});

test('monthsUntil counts the current month and never goes below one', () => {
  assert.equal(monthsUntil('2026-07-01', 2026, 7), 1);
  assert.equal(monthsUntil('2027-06-30', 2026, 7), 12);
  assert.equal(monthsUntil('2025-01-01', 2026, 7), 1, 'a date in the past clamps to one');
  assert.equal(monthsUntil(null, 2026, 7), 1);
});

test('assignment rows with an unusable month are dropped, not walked', () => {
  const result = walkEnvelopes({
    assignments: [a('Fun', 'garbage', 500), a('Fun', '2026-06', 100)],
    spending: [],
    year: 2026,
    month: 6,
  });
  assert.equal(row(result, 'Fun').assigned, 100);
});

test('MAX_WALK_MONTHS is a runaway guard, not a budgeting horizon', () => {
  assert.ok(MAX_WALK_MONTHS >= 240, 'must comfortably outlast a real sinking fund');
});
