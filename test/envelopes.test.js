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
  effectiveTarget,
  planAutoFill,
  readyToAssign,
  planMove,
  monthKey,
  shiftMonthKey,
  normalizeMonthKey,
  monthsUntil,
  cents,
  MAX_WALK_MONTHS,
  envelopePace,
  PACE_MARGIN,
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

// --- Pace warning (display-only, opt-in) -----------------------------------
// A flat month-pace signal: warn when spent runs ahead of
// elapsedFraction × assigned by PACE_MARGIN of assigned. Never touches the walk.
test('envelopePace warns only when spending is ahead of a flat month pace', () => {
  // Halfway through a 30-day month: expected = 0.5 × 300 = 150, margin = 30.
  const mid = '2026-06-15'; // day 15 of 30 → elapsed 0.5
  // Right on pace: no warning.
  assert.equal(envelopePace({ assigned: 300, spent: 150, year: 2026, month: 6, today: mid }), null);
  // Ahead but inside the margin (≤180): no warning.
  assert.equal(envelopePace({ assigned: 300, spent: 179, year: 2026, month: 6, today: mid }), null);
  // Ahead past the margin: warns, with the numbers.
  const warn = envelopePace({ assigned: 300, spent: 220, year: 2026, month: 6, today: mid });
  assert.ok(warn);
  assert.equal(warn.expected, 150);
  assert.equal(warn.ahead, 70);
});

test('envelopePace is silent for a non-current, no-assignment or unspent envelope', () => {
  const today = '2026-06-15';
  // Past month (viewing May while it is June): a completed month is not "ahead".
  assert.equal(envelopePace({ assigned: 300, spent: 300, year: 2026, month: 5, today }), null);
  // Future month.
  assert.equal(envelopePace({ assigned: 300, spent: 0, year: 2026, month: 7, today }), null);
  // No assignment (a fixed bill opts out by never assigning here) → never warns.
  assert.equal(envelopePace({ assigned: 0, spent: 500, year: 2026, month: 6, today }), null);
  // Nothing spent yet.
  assert.equal(envelopePace({ assigned: 300, spent: 0, year: 2026, month: 6, today }), null);
});

test('envelopePace elapsed fraction tracks the real month length', () => {
  // Day 1 of a 31-day month: barely elapsed, so almost any spend is ahead.
  const warn = envelopePace({ assigned: 310, spent: 100, year: 2026, month: 7, today: '2026-07-01' });
  assert.ok(warn);
  assert.equal(Math.round(warn.expected), 10); // 1/31 × 310
  assert.equal(PACE_MARGIN, 0.1);
});

// --- planAutoFill: copy last month's assignments into the viewed month -------

test('planAutoFill copies source assignments, sums, and totals them', () => {
  const plan = planAutoFill({
    source: [
      { category: 'Groceries', assigned: 500 },
      { category: 'Fun', assigned: 100 },
      { category: 'Fun', assigned: 50 }, // duplicate rows sum, like the walk's byMonth
    ],
    existing: [],
  });
  assert.deepEqual(plan.rows.sort((a, b) => (a.category < b.category ? -1 : 1)), [
    { category: 'Fun', assigned: 150 },
    { category: 'Groceries', assigned: 500 },
  ]);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.total, 650);
});

test('REGRESSION: a zero source assignment is never copied (0 row ≡ no row)', () => {
  // moveMoney can leave a 0 row in the source month. Copying it forward would
  // write a new 0 row into the viewed month — which must stay equivalent to no
  // row — and duplicate rows that SUM to zero are just as absent.
  const plan = planAutoFill({
    source: [
      { category: 'Dining', assigned: 0 },
      { category: 'Gifts', assigned: 40 },
      { category: 'Gifts', assigned: -40 }, // sums to zero → dropped too
      { category: 'Groceries', assigned: 300 },
    ],
    existing: [],
  });
  assert.deepEqual(plan.rows, [{ category: 'Groceries', assigned: 300 }]);
  assert.equal(plan.total, 300);
});

test('planAutoFill filters non-budgetable categories', () => {
  const plan = planAutoFill({
    source: [
      { category: 'Uncategorized', assigned: 200 },
      { category: 'Groceries', assigned: 300 },
    ],
    existing: [],
    isBudgetable: c => c !== 'Uncategorized',
  });
  assert.deepEqual(plan.rows, [{ category: 'Groceries', assigned: 300 }]);
  assert.deepEqual(plan.skipped, [], 'non-budgetable is filtered, not "skipped"');
});

test('planAutoFill skips categories already assigned this month, reporting them', () => {
  const plan = planAutoFill({
    source: [
      { category: 'Groceries', assigned: 500 },
      { category: 'Fun', assigned: 100 },
    ],
    existing: [{ category: 'Groceries', assigned: 450 }],
  });
  assert.deepEqual(plan.rows, [{ category: 'Fun', assigned: 100 }]);
  assert.deepEqual(plan.skipped, [{ category: 'Groceries', assigned: 500 }]);
  assert.equal(plan.total, 100, 'total covers only what will be written');
});

test('an existing 0 row counts as absent and gets filled', () => {
  // A 0 row (left behind by moveMoney) is not "the user already budgeted here".
  const plan = planAutoFill({
    source: [{ category: 'Dining', assigned: 120 }],
    existing: [{ category: 'Dining', assigned: 0 }],
  });
  assert.deepEqual(plan.rows, [{ category: 'Dining', assigned: 120 }]);
  assert.deepEqual(plan.skipped, []);
});

test('negative source assignments are copied as-is', () => {
  const plan = planAutoFill({
    source: [{ category: 'Fun', assigned: -75 }],
    existing: [],
  });
  assert.deepEqual(plan.rows, [{ category: 'Fun', assigned: -75 }]);
  assert.equal(plan.total, -75);
});

test('planAutoFill amounts go through cents()', () => {
  const plan = planAutoFill({
    source: [
      { category: 'Coffee', assigned: 0.1 },
      { category: 'Coffee', assigned: 0.2 },
    ],
    existing: [],
  });
  assert.deepEqual(plan.rows, [{ category: 'Coffee', assigned: 0.3 }]);
  assert.equal(plan.total, 0.3);
});

test('REGRESSION: auto-fill composed through the walk — a skipped gap month still contributes 0, never the target', () => {
  // May was budgeted, June was never filled (auto-fill not run), July is filled
  // from May's shape. The June gap must contribute 0 to the carry — the
  // missing-row=0 rule restated through the feature. If the walk fell back to
  // the $600 target for June, July would open $600 richer than reality.
  const settings = [{ category: 'Groceries', target: 600, rollover: true }];
  const may = [{ category: 'Groceries', assigned: 600 }];
  const plan = planAutoFill({ source: may, existing: [] });
  const assignments = [
    a('Groceries', '2026-05', 600),
    // June: nothing — the household never budgeted it.
    ...plan.rows.map(r => a(r.category, '2026-07', r.assigned)),
  ];
  const spending = [s('Groceries', '2026-05', 600), s('Groceries', '2026-06', 400)];
  const jul = row(walkEnvelopes({ assignments, spending, settings, year: 2026, month: 7 }), 'Groceries');
  assert.equal(jul.assigned, 600, 'the auto-filled copy of May');
  assert.equal(jul.rolledOver, -400, 'June contributed 0 assigned; its spending carries as overspend');
  assert.equal(jul.available, 200);
});

// --- per-month target override (targetOverride) -------------------------------

test('effectiveTarget prefers the month override, falls back to target, else null', () => {
  assert.equal(effectiveTarget({ targetOverride: 250, target: 400 }), 250);
  assert.equal(effectiveTarget({ targetOverride: 0, target: 400 }), 0, 'override 0 is a real answer');
  assert.equal(effectiveTarget({ targetOverride: null, target: 400 }), 400);
  assert.equal(effectiveTarget({ targetOverride: null, target: null }), null);
  assert.equal(effectiveTarget(null), null);
});

test('targetNeed uses the override when set; override 0 asks for nothing (≠ null)', () => {
  const at = { year: 2026, month: 6 };
  const base = { target: 400, targetKind: 'monthly', rolledOver: 0 };
  assert.equal(targetNeed({ ...base, targetOverride: 250, assigned: 0 }, at), 250);
  assert.equal(targetNeed({ ...base, targetOverride: 250, assigned: 100 }, at), 150);
  assert.equal(targetNeed({ ...base, targetOverride: 250, assigned: 300 }, at), 0, 'over the override asks nothing');
  assert.equal(targetNeed({ ...base, targetOverride: 0, assigned: 0 }, at), 0, 'override 0 = "ask nothing"');
  assert.equal(targetNeed({ ...base, targetOverride: null, assigned: 0 }, at), 400, 'null falls back to the target');
  assert.equal(
    targetNeed({ target: null, targetKind: 'monthly', targetOverride: 150, rolledOver: 0, assigned: 0 }, at),
    150,
    'an override works even with no category target'
  );
});

test('an override forces monthly-top-up semantics even on a by_date target', () => {
  // The by-date spread would ask (2400 − 1200) / 6 = 200; the override says
  // THIS month wants exactly 500, so it asks max(0, 500 − assigned).
  const base = { target: 2400, targetKind: 'by_date', targetDate: '2027-06-01', rolledOver: 1200 };
  const at = { year: 2027, month: 1 };
  assert.equal(targetNeed({ ...base, targetOverride: 500, assigned: 0 }, at), 500);
  assert.equal(targetNeed({ ...base, targetOverride: 500, assigned: 500 }, at), 0);
  assert.equal(targetNeed({ ...base, targetOverride: null, assigned: 0 }, at), 200, 'no override → by-date spread');
});

test('REGRESSION: assigned 0 + target_override is a REAL row but does not open an envelope', () => {
  // The zero-row-equivalence rule applies to ASSIGNED only: a 0-assigned row
  // carrying an override must surface the override for the viewed month while
  // contributing nothing to the walk — and it must not set the category's
  // start month (its earlier spending must not become rolled-over debt).
  const result = walkEnvelopes({
    assignments: [
      { category: 'Dining', month: '2026-01', assigned: 0, targetOverride: 300 },
      { category: 'Dining', month: '2026-02', assigned: 0, targetOverride: 300 },
    ],
    spending: [s('Dining', '2026-01', 250), s('Dining', '2026-02', 100)],
    year: 2026,
    month: 2,
  });
  const feb = row(result, 'Dining');
  assert.equal(feb.targetOverride, 300, 'the viewed month sees its override');
  assert.equal(feb.rolledOver, 0, 'the January 0 row did not open the envelope');
  assert.equal(feb.available, -100, 'this month only — identical to no rows at all');
});

test('the output row carries the VIEWED month override only; past overrides never leak forward', () => {
  const assignments = [
    { category: 'Fun', month: '2026-01', assigned: 300, targetOverride: 999 },
    { category: 'Fun', month: '2026-02', assigned: 300 },
  ];
  const spending = [s('Fun', '2026-01', 100)];

  const feb = row(walkEnvelopes({ assignments, spending, year: 2026, month: 2 }), 'Fun');
  assert.equal(feb.targetOverride, null, 'January override does not leak into February');

  const jan = row(walkEnvelopes({ assignments, spending, year: 2026, month: 1 }), 'Fun');
  assert.equal(jan.targetOverride, 999, 'January itself sees it');
});

test('REGRESSION: carry math never reads overrides — the walk is byte-identical with and without them', () => {
  // Overrides change what funding ASKS for, never what any month rolled. Strip
  // targetOverride from both output rows and the walks must match exactly.
  const spending = [s('Groceries', '2026-01', 450), s('Groceries', '2026-02', 500), s('Groceries', '2026-03', 480)];
  const settings = [{ category: 'Groceries', target: 600, rollover: true }];
  const plain = [
    a('Groceries', '2026-01', 500),
    a('Groceries', '2026-02', 500),
    a('Groceries', '2026-03', 500),
  ];
  const withOverrides = plain.map((r0, i) => ({ ...r0, targetOverride: 100 * (i + 1) }));

  const strip = res => ({
    ...res,
    categories: res.categories.map(({ targetOverride, ...rest }) => rest),
  });
  for (const view of [{ year: 2026, month: 2 }, { year: 2026, month: 3 }]) {
    const without = walkEnvelopes({ assignments: plain, spending, settings, ...view });
    const withOv = walkEnvelopes({ assignments: withOverrides, spending, settings, ...view });
    // totals.target differs by design (it sums effectiveTarget) — compare the
    // carry-bearing numbers and every row field except targetOverride.
    assert.deepEqual(strip(withOv).categories, strip(without).categories);
    assert.equal(withOv.totals.available, without.totals.available);
    assert.equal(withOv.totals.rolledOver, without.totals.rolledOver);
    assert.equal(withOv.totals.assigned, without.totals.assigned);
  }
});

test('totals.target sums the effective target, not the raw category target', () => {
  const result = walkEnvelopes({
    assignments: [
      { category: 'Groceries', month: '2026-06', assigned: 100, targetOverride: 250 },
      { category: 'Fun', month: '2026-06', assigned: 50 },
    ],
    spending: [],
    settings: [
      { category: 'Groceries', target: 600 },
      { category: 'Fun', target: 200 },
    ],
    year: 2026,
    month: 6,
  });
  assert.equal(result.totals.target, 450, '250 (override) + 200 (plain target)');

  // An override of 0 zeroes that category's contribution — real, not null.
  const zeroed = walkEnvelopes({
    assignments: [{ category: 'Groceries', month: '2026-06', assigned: 100, targetOverride: 0 }],
    spending: [],
    settings: [{ category: 'Groceries', target: 600 }],
    year: 2026,
    month: 6,
  });
  assert.equal(zeroed.totals.target, 0);
});

test('rows without overrides carry targetOverride null (shape is stable)', () => {
  const result = walkEnvelopes({
    assignments: [a('Fun', '2026-06', 100)],
    spending: [],
    year: 2026,
    month: 6,
  });
  assert.equal(row(result, 'Fun').targetOverride, null);
});
