// The teach-queue's population (src/teachQueue.js) plus two structural pins on
// Dashboard.jsx that no unit test can reach — the lockstep.test.js /
// userOwnedCategories.test.js mold.
//
// Post-wipe the queue is the primary onboarding surface: nothing is guessed, so
// every transaction sits in Uncategorized until a merchant is taught. These
// tests pin the three failures that came with that promotion (an unsplit
// population, "$0" income merchants, two adjacent counts over different row
// sets) and the entry point's independence from the Uncategorized category row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { teachQueueGroups, nonSpendLabel, categorizedShare } from '../src/teachQueue.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Rows in toTxShape form. `counted` is the stamped isSpend() verdict — this
// module never re-derives it, so the fixture states it directly, exactly as the
// adapter would.
const row = (key, amount, counted, date, extra = {}) => ({
  key,
  amount,
  counted,
  transaction_date: date,
  ...extra,
});
const byKey = (t) => t.key;

// A month that looks like a real post-wipe one: two repeat merchants, a big
// one-off, a paycheck, an internal-transfer leg, and a card payment.
const MONTH = [
  row('SAFEWAY', 42.1, true, '2026-08-01'),
  row('SAFEWAY', 18.9, true, '2026-08-14'),
  row('SAFEWAY', 30.0, true, '2026-08-20'),
  row('SHELL', 55.0, true, '2026-08-03'),
  row('SHELL', 45.0, true, '2026-08-19'),
  row('BIG APPLIANCE CO', 1200.0, true, '2026-08-07'),
  row('PAYROLL NORTHWIND LABS', -2200.0, false, '2026-08-10'),
  row('PAYROLL NORTHWIND LABS', -2200.0, false, '2026-08-24'),
  row('TRANSFER TO SAVINGS', 500.0, false, '2026-08-05'),
  row('CAPITAL ONE CCPYMT', 320.0, false, '2026-08-12'),
];

// --- 1. The population splits on `counted` -----------------------------------
// The shipped bug: every Uncategorized row in the month went into one list, so
// paychecks, transfer legs and card payments were ranked as merchants to
// categorize alongside the grocery store.
test('non-spending rows never enter the ranked merchant list', () => {
  const { spending, other } = teachQueueGroups(MONTH, byKey);
  assert.deepEqual(
    spending.map((g) => g.key),
    ['SAFEWAY', 'SHELL', 'BIG APPLIANCE CO']
  );
  assert.deepEqual(
    other.map((g) => g.key).sort(),
    ['CAPITAL ONE CCPYMT', 'PAYROLL NORTHWIND LABS', 'TRANSFER TO SAVINGS']
  );
});

// --- 2. The two adjacent numbers count ONE population ------------------------
// The Categories row prints spendingGroups' isSpend-filtered transaction_count
// and the queue header prints a merchant count. Before this they were computed
// over different row sets, so the same card showed two numbers that disagreed.
// Both sides now derive from `counted`, which is what this pins: the queue's
// money is exactly the Uncategorized bar's money.
test('REGRESSION: the queue spends exactly what the counted rows spend', () => {
  const { spending } = teachQueueGroups(MONTH, byKey);
  const expected = MONTH.filter((t) => t.counted).reduce((s, t) => s + t.amount, 0);
  const queued = spending.reduce((s, g) => s + g.spent, 0);
  assert.equal(Math.round(queued * 100) / 100, Math.round(expected * 100) / 100);
  // …and the header's merchant count is over the same rows.
  assert.equal(spending.length, new Set(MONTH.filter((t) => t.counted).map(byKey)).size);
});

// --- 3. An income-only merchant is never "$0" --------------------------------
// The old group total summed positive amounts only, so a paycheck rendered as
// "· $0" — a merchant with no money, which is not what a $2,200 deposit is.
test('REGRESSION: an income-only merchant carries its real amount, not $0', () => {
  const { other } = teachQueueGroups(MONTH, byKey);
  const pay = other.find((g) => g.key === 'PAYROLL NORTHWIND LABS');
  assert.equal(pay.spendCount, 0);
  assert.equal(pay.spent, 0);
  assert.equal(pay.otherCount, 2);
  assert.equal(pay.moneyIn, 4400);
  assert.equal(pay.otherOut, 0);
  assert.equal(nonSpendLabel(pay, (v) => `$${v}`), '$4400 in');
});

test('a non-spending outflow (transfer leg, card payment) labels as money out', () => {
  const { other } = teachQueueGroups(MONTH, byKey);
  const pay = other.find((g) => g.key === 'CAPITAL ONE CCPYMT');
  assert.equal(pay.moneyIn, 0);
  assert.equal(pay.otherOut, 320);
  assert.equal(nonSpendLabel(pay, (v) => `$${v}`), '$320 out');
});

test('nonSpendLabel covers both directions and the no-amount case', () => {
  const f = (v) => `$${v}`;
  assert.equal(nonSpendLabel({ moneyIn: 100, otherOut: 40 }, f), '$100 in / $40 out');
  assert.equal(nonSpendLabel({ moneyIn: 0, otherOut: 0 }, f), 'no amount');
  // Never throws and never invents a number when handed nothing.
  assert.equal(nonSpendLabel(null, f), 'no amount');
  assert.equal(nonSpendLabel({ moneyIn: 5 }), '5 in');
});

// --- 4. A mixed merchant stays a merchant, with counted-only money ------------
test('a merchant with a refund ranks on its counted spending alone', () => {
  const rows = [
    row('SAFEWAY', 60, true, '2026-08-01'),
    row('SAFEWAY', -25, false, '2026-08-04'), // returned groceries
  ];
  const { spending, other } = teachQueueGroups(rows, byKey);
  assert.equal(other.length, 0);
  assert.equal(spending.length, 1);
  assert.equal(spending[0].spent, 60, 'the refund must not net against the ranked spend');
  assert.equal(spending[0].spendCount, 1);
  assert.equal(spending[0].otherCount, 1, 'the row outside the total is still recorded, not dropped');
  assert.equal(spending[0].moneyIn, 25);
});

// --- 5. Ordering -------------------------------------------------------------
// Count first, spend as the tie-break: teaching writes a rule that fires
// forever, so repetition — not size — is what makes a merchant worth the tap.
// The $1,200 one-off therefore sits below the 3× grocery store.
test('spending merchants rank by count, then spend, then alphabetically', () => {
  const { spending } = teachQueueGroups(MONTH, byKey);
  assert.deepEqual(spending.map((g) => [g.key, g.spendCount]), [
    ['SAFEWAY', 3],
    ['SHELL', 2],
    ['BIG APPLIANCE CO', 1],
  ]);
  const tied = teachQueueGroups(
    [
      row('ZED', 10, true, '2026-08-01'),
      row('ABLE', 10, true, '2026-08-01'),
      row('MID', 99, true, '2026-08-01'),
    ],
    byKey
  ).spending;
  assert.deepEqual(tied.map((g) => g.key), ['MID', 'ABLE', 'ZED']);
});

test('non-spending merchants rank by count, then magnitude, then alphabetically', () => {
  const rows = [
    row('B', -10, false, '2026-08-01'),
    row('A', -500, false, '2026-08-01'),
    row('C', -10, false, '2026-08-01'),
    row('C', -10, false, '2026-08-02'),
  ];
  assert.deepEqual(
    teachQueueGroups(rows, byKey).other.map((g) => g.key),
    ['C', 'A', 'B']
  );
});

// --- 6. Which transaction a tap opens ----------------------------------------
test('a spending group opens its most recent COUNTED row', () => {
  const rows = [
    row('SAFEWAY', 20, true, '2026-08-02', { id: 'spend-old' }),
    row('SAFEWAY', 30, true, '2026-08-09', { id: 'spend-new' }),
    row('SAFEWAY', -5, false, '2026-08-28', { id: 'refund' }),
  ];
  const { spending } = teachQueueGroups(rows, byKey);
  assert.equal(spending[0].tx.id, 'spend-new', 'teaching should start from a purchase, not its refund');
});

test('a non-spending group opens its most recent row', () => {
  const rows = [
    row('PAYROLL', -100, false, '2026-08-02', { id: 'old' }),
    row('PAYROLL', -100, false, '2026-08-24', { id: 'new' }),
  ];
  assert.equal(teachQueueGroups(rows, byKey).other[0].tx.id, 'new');
});

// --- 7. It runs during render, so it can never throw -------------------------
test('rows with no teachable descriptor are skipped, not grouped under ""', () => {
  const rows = [row('', 10, true, '2026-08-01'), row('SAFEWAY', 10, true, '2026-08-01')];
  const { spending, other } = teachQueueGroups(rows, byKey);
  assert.deepEqual(spending.map((g) => g.key), ['SAFEWAY']);
  assert.equal(other.length, 0);
});

test('tolerates junk input and a throwing key function', () => {
  assert.deepEqual(teachQueueGroups(null, byKey), { spending: [], other: [] });
  assert.deepEqual(teachQueueGroups(undefined, byKey), { spending: [], other: [] });
  assert.deepEqual(teachQueueGroups([null, undefined], byKey), { spending: [], other: [] });
  assert.deepEqual(teachQueueGroups(MONTH, null), { spending: [], other: [] });
  assert.doesNotThrow(() =>
    teachQueueGroups(MONTH, () => {
      throw new Error('bad descriptor');
    })
  );
  // A row with a missing amount contributes nothing rather than NaN-poisoning
  // the group's total.
  const { spending } = teachQueueGroups(
    [row('A', undefined, true, '2026-08-01'), row('A', 10, true, '2026-08-02')],
    byKey
  );
  assert.equal(spending[0].spent, 10);
});

// --- 8. The entry point must survive an emptied spending queue ----------------
// The queue used to render inside catRows' `c.label===UNCATEGORIZED` branch, and
// catRows starts from spendingGroups — so the row (and with it the queue and the
// "See what you've taught" link) disappeared the moment the last untaught
// SPENDING merchant was taught, while untaught paychecks and transfers remained.
test('REGRESSION: the teach-queue is not gated on the Uncategorized category row', () => {
  const src = read('src/components/Dashboard.jsx');
  // JSX gates only — the `{…&&(` form. (The teach-queue's own comment names the
  // old branch in prose; that mention is documentation, not a gate.)
  const gates = src.match(/\{c\.label===UNCATEGORIZED&&\(/g) || [];
  assert.equal(
    gates.length,
    1,
    'only the explanatory blurb may hang off the Uncategorized row — the queue must render at card level'
  );
  const blurbOnly = /\{c\.label===UNCATEGORIZED&&\(\s*<div[\s\S]{0,400}?Everything starts here/;
  assert.match(src, blurbOnly, 'the surviving gate should be the "Everything starts here" note');
  assert.match(
    src,
    /\{!loading&&\(teachQueue\.spending\.length>0\|\|teachQueue\.other\.length>0\)&&\(/,
    'the queue renders whenever ANY untaught merchant exists, spending or not'
  );
});

// --- 9. The Schedule E picker offers only real user categories ----------------
// `t.category` also carries the three MECHANISM labels, so deriving the picker
// straight from the rows offered to map "Transfers and card payments" onto a tax
// line. The amber "not on any line yet" bucket is deliberately NOT filtered —
// narrowing the picker must not make money disappear from the worksheet.
test('REGRESSION: the Schedule E category picker filters out mechanism labels', () => {
  const src = read('src/components/Dashboard.jsx');
  assert.match(
    src,
    /const catsPresent=\[\.\.\.new Set\(rows\.filter\(t=>!t\.is_capital\)\.map\(t=>t\.category\)\)\]\s*\.filter\(c=>isBudgetableCategory\(c\)\|\|emap\[c\]!=null\)/,
    'the picker must filter on isBudgetableCategory, keeping already-mapped labels removable'
  );
  // scheduleEReport still sees every row: the unmapped bucket is rendered from
  // rep.unmapped with no category filter of its own.
  assert.match(src, /rep\.unmapped\.map\(u=>\(/);
  assert.doesNotMatch(
    src,
    /rep\.unmapped\.filter\(/,
    'the amber bucket must stay unfiltered — unmapped money stays visible and sized'
  );
});

// --- 10. The retraining progress meter (categorizedShare) ---------------------
// Input is the spendingGroups output — the isSpend() fold — so the denominator
// is counted spending by construction; the Uncategorized label is injected to
// keep the module zero-import. The two honesty pins: no denominator renders
// NOTHING (null, never a fake 100%), and degenerate group shapes clamp instead
// of leaking a share outside [0,1].
test('categorizedShare: fraction of counted spending with a real category', () => {
  const groups = [
    { label: 'Groceries', amount: 300 },
    { label: 'Gas', amount: 100 },
    { label: 'Uncategorized', amount: 100 },
  ];
  assert.equal(categorizedShare(groups, 'Uncategorized'), 0.8);
  // Nothing untaught: a clean 1, not 1-and-a-bit.
  assert.equal(categorizedShare(groups.slice(0, 2), 'Uncategorized'), 1);
  // Everything untaught: 0.
  assert.equal(categorizedShare([{ label: 'Uncategorized', amount: 50 }], 'Uncategorized'), 0);
});

test('categorizedShare: no positive spending means NO meter, never a fake 100%', () => {
  assert.equal(categorizedShare([], 'Uncategorized'), null);
  assert.equal(categorizedShare(null, 'Uncategorized'), null);
  assert.equal(categorizedShare([{ label: 'Groceries', amount: 0 }], 'Uncategorized'), null);
  // A refund-dominated month can net negative — still no denominator.
  assert.equal(categorizedShare([{ label: 'Groceries', amount: -20 }], 'Uncategorized'), null);
});

test('categorizedShare: degenerate shapes clamp to [0,1] and the label is honored', () => {
  // A negative-net named group beside a larger Uncategorized: raw ratio would
  // fall below 0 — the meter stays a fraction.
  const upsideDown = [
    { label: 'Groceries', amount: -50 },
    { label: 'Uncategorized', amount: 100 },
  ];
  assert.equal(categorizedShare(upsideDown, 'Uncategorized'), 0);
  // Injected label: a different uncategorized label changes the verdict.
  const groups = [
    { label: 'Groceries', amount: 60 },
    { label: 'Mystery', amount: 40 },
  ];
  assert.equal(categorizedShare(groups, 'Mystery'), 0.6);
  assert.equal(categorizedShare(groups, 'Uncategorized'), 1);
  // Junk rows are skipped, non-numeric amounts read as 0.
  assert.equal(categorizedShare([null, { label: 'Groceries', amount: '25' }, { label: 'Uncategorized' }], 'Uncategorized'), 1);
});
