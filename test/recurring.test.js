// Tests for src/recurring.js — client-side subscription detection. The
// thresholds asserted here are the ACTUAL shipped values, pinned as
// documentation: ≥3 charges, ±20% amount band with ≥80% kept, price creep
// strictly >5% over the median, and per-cadence bands with ≥2/3 of gaps
// within the band's tolerance of the median gap —
//   weekly   gap 5–9    (7±2),   near ±2,  due-soon within 2 days
//   monthly  gap 24–32  (28±4),  near ±4,  due-soon within 7 days  (the
//            original detector, unchanged — never loosen it)
//   annual   gap 350–380 (365±15), near ±15, due-soon within 30 days
// Gaps outside every band (biweekly ~14, quarterly ~91) stay undetected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRecurring, normalizeMerchant, parseIgnoreList } from '../src/recurring.js';
import { TRANSFER_CATEGORY, RETURN_CATEGORY } from '../src/categoryMap.js';

// Rows in the toTxShape fields detectRecurring reads.
let seq = 0;
const tx = (date, amount, merchant, extra = {}) => ({
  id: `t${seq++}`,
  merchant_name: merchant,
  description: '',
  transaction_date: date,
  amount,
  category: 'Entertainment and subscriptions',
  account_id: 'acc-1',
  ...extra,
});

test('normalizeMerchant collapses store numbers and per-charge codes', () => {
  assert.equal(normalizeMerchant("TRADER JOE'S #553"), 'TRADER JOE S');
  assert.equal(normalizeMerchant('AMAZON.COM*MK1AB23'), 'AMAZON COM MK AB');
  assert.equal(normalizeMerchant('  netflix.com  '), 'NETFLIX COM');
  assert.equal(normalizeMerchant(''), '');
  assert.equal(normalizeMerchant('12345 #77'), '', 'digits-only collapses to nothing');
});

test('a monthly charge with day jitter and a constant amount is detected', () => {
  // Gaps 29 / 31 / 29 — median 29, all within ±4.
  const rows = [
    tx('2026-01-05', 15.99, 'STREAMFLIX.COM'),
    tx('2026-02-03', 15.99, 'STREAMFLIX.COM'),
    tx('2026-03-06', 15.99, 'STREAMFLIX.COM'),
    tx('2026-04-04', 15.99, 'STREAMFLIX.COM'),
  ];
  const out = detectRecurring(rows);
  assert.equal(out.length, 1);
  const r = out[0];
  assert.equal(r.key, 'STREAMFLIX COM');
  assert.equal(r.name, 'STREAMFLIX.COM');
  assert.equal(r.count, 4);
  assert.equal(r.monthlyAmount, 15.99);
  assert.equal(r.lastDate, '2026-04-04');
  assert.equal(r.nextDate, '2026-05-03', 'last date + the 29-day median gap');
  assert.equal(r.avgGapDays, 30, 'round(89/3)');
  assert.equal(r.category, 'Entertainment and subscriptions');
  assert.equal(r.account_id, 'acc-1');
});

test('amount drift within ±20% of the median is tolerated; variable spend is not', () => {
  // 12.99 → 13.99 price bump: all within ±20% of the 13.49 median.
  const bumped = [
    tx('2026-01-10', 12.99, 'MUSICSTREAM'),
    tx('2026-02-09', 12.99, 'MUSICSTREAM'),
    tx('2026-03-11', 13.99, 'MUSICSTREAM'),
    tx('2026-04-10', 13.99, 'MUSICSTREAM'),
  ];
  assert.equal(detectRecurring(bumped).length, 1);

  // Wildly varying amounts at a monthly cadence (a grocery run) — the ±20%
  // band keeps fewer than 3, so no subscription.
  const groceries = [
    tx('2026-01-10', 10, 'RIVER GROCERY'),
    tx('2026-02-09', 25, 'RIVER GROCERY'),
    tx('2026-03-11', 50, 'RIVER GROCERY'),
    tx('2026-04-10', 80, 'RIVER GROCERY'),
  ];
  assert.equal(detectRecurring(groceries).length, 0);
});

test('one skipped month: detected with 4+ charges, not with only 3', () => {
  // Jan, Feb, Mar, May: gaps 30/30/61 — median 30, 2 of 3 gaps near it,
  // which meets the ≥2/3 bar. The subscription survives a skipped month.
  const fourCharges = [
    tx('2026-01-05', 9.99, 'CLOUDBOX'),
    tx('2026-02-04', 9.99, 'CLOUDBOX'),
    tx('2026-03-06', 9.99, 'CLOUDBOX'),
    tx('2026-05-06', 9.99, 'CLOUDBOX'),
  ];
  assert.equal(detectRecurring(fourCharges).length, 1);

  // Jan, Feb, Apr: gaps 30/61 — the median lands between them (45.5), outside
  // the 24–32 monthly window, so three charges with a hole do NOT qualify.
  const threeCharges = [
    tx('2026-01-05', 9.99, 'CLOUDBOX'),
    tx('2026-02-04', 9.99, 'CLOUDBOX'),
    tx('2026-04-06', 9.99, 'CLOUDBOX'),
  ];
  assert.equal(detectRecurring(threeCharges).length, 0);
});

test('gaps outside every cadence band stay undetected: biweekly and quarterly', () => {
  // Biweekly: median gap 14, between the weekly (5–9) and monthly (24–32)
  // bands. A real cadence, deliberately out of scope — no band, no detection.
  const biweekly = ['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16'].map(d =>
    tx(d, 12.0, 'BIWEEKLY BOX')
  );
  assert.equal(detectRecurring(biweekly).length, 0);

  // Quarterly: median gap ~91, between monthly (24–32) and annual (350–380).
  const quarterly = ['2026-01-05', '2026-04-06', '2026-07-06', '2026-10-05'].map(d =>
    tx(d, 30.0, 'QUARTERLY DUES')
  );
  assert.equal(detectRecurring(quarterly).length, 0);
});

test('weekly cadence: constant weekly charges detect as weekly', () => {
  const rows = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'].map(d =>
    tx(d, 12.0, 'WEEKLY BOX')
  );
  const out = detectRecurring(rows);
  assert.equal(out.length, 1);
  const r = out[0];
  assert.equal(r.cadence, 'weekly');
  assert.equal(r.count, 4);
  assert.equal(r.monthlyAmount, 12.0, 'the per-CHARGE median keeps its historical field name');
  assert.equal(r.monthlyEquivalent, 12.0 * (52 / 12), 'normalized: ×52/12 for a per-month figure');
  assert.equal(r.lastDate, '2026-01-26');
  assert.equal(r.nextDate, '2026-02-02', 'last + the 7-day median gap');
  assert.equal(r.priceCreep, false);
});

test('weekly jitter tolerance is ±2 days, tighter than monthly ±4', () => {
  // Gaps 7 / 9 / 5 — median 7, all within ±2 → detected.
  const jittery = ['2026-01-05', '2026-01-12', '2026-01-21', '2026-01-26'].map(d =>
    tx(d, 12.0, 'JITTER BOX')
  );
  const out = detectRecurring(jittery);
  assert.equal(out.length, 1);
  assert.equal(out[0].cadence, 'weekly');

  // Gaps 7 / 11 / 3 — median 7 (in band), but only 1 of 3 gaps within ±2,
  // under the ≥2/3 bar. The same ±4 spread a monthly sub is allowed is too
  // loose for a 7-day cycle.
  const loose = ['2026-01-05', '2026-01-12', '2026-01-23', '2026-01-26'].map(d =>
    tx(d, 12.0, 'LOOSE BOX')
  );
  assert.equal(detectRecurring(loose).length, 0);
});

test('annual cadence: three yearly renewals detect as annual', () => {
  const rows = [
    tx('2024-03-10', 95.0, 'DOMAIN RENEWAL'),
    tx('2025-03-10', 95.0, 'DOMAIN RENEWAL'),
    tx('2026-03-10', 95.0, 'DOMAIN RENEWAL'),
  ];
  const out = detectRecurring(rows);
  assert.equal(out.length, 1);
  const r = out[0];
  assert.equal(r.cadence, 'annual');
  assert.equal(r.count, 3);
  assert.equal(r.monthlyAmount, 95.0);
  assert.equal(r.monthlyEquivalent, 95.0 * (1 / 12), 'normalized: ÷12 for a per-month figure');
  assert.equal(r.nextDate, '2027-03-10', 'last + the 365-day median gap');
  // Two renewals are never enough — the ≥3-charge floor holds for every
  // cadence (a lone year-apart pair is a coincidence, not a subscription).
  assert.equal(detectRecurring(rows.slice(1)).length, 0);
});

test('due windows scale with cadence: 2 days weekly, 30 days annual', () => {
  // WEEKLY BOX fixture: nextDate 2026-02-02.
  const weekly = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'].map(d =>
    tx(d, 12.0, 'WEEKLY BOX')
  );
  const w3 = detectRecurring(weekly, '2026-01-30')[0]; // 3 days out
  assert.equal(w3.dueSoon, false, '3 days out is NOT due-soon for a weekly charge');
  assert.equal(w3.dueStatus, null);
  const w2 = detectRecurring(weekly, '2026-01-31')[0]; // 2 days out
  assert.equal(w2.dueSoon, true);
  assert.equal(w2.dueStatus, 'due-soon');
  const wLate = detectRecurring(weekly, '2026-02-03')[0]; // the day after
  assert.equal(wLate.overdue, true);
  assert.equal(wLate.dueStatus, 'overdue');

  // DOMAIN RENEWAL fixture: nextDate 2027-03-10.
  const annual = [
    tx('2024-03-10', 95.0, 'DOMAIN RENEWAL'),
    tx('2025-03-10', 95.0, 'DOMAIN RENEWAL'),
    tx('2026-03-10', 95.0, 'DOMAIN RENEWAL'),
  ];
  const a31 = detectRecurring(annual, '2027-02-07')[0]; // 31 days out
  assert.equal(a31.dueSoon, false, '31 days out is not yet due-soon even for annual');
  assert.equal(a31.dueStatus, null);
  const a30 = detectRecurring(annual, '2027-02-08')[0]; // 30 days out
  assert.equal(a30.dueSoon, true);
  assert.equal(a30.dueStatus, 'due-soon');
});

test('priceCreep works on a weekly item: >5% over the median flags', () => {
  const dates = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'];
  // Median of [10, 10, 10, 10.6] is 10 — the 10.60 last charge is +6%.
  const crept = dates.map((d, i) => tx(d, i === 3 ? 10.6 : 10.0, 'CREEPING BOX'));
  const r = detectRecurring(crept)[0];
  assert.equal(r.cadence, 'weekly');
  assert.equal(r.medianAmount, 10.0);
  assert.equal(r.lastAmount, 10.6);
  assert.equal(r.priceCreep, true, '+6% is creep on a weekly cadence too');

  // Exactly 5% is not creep — the strict-inequality boundary is cadence-free.
  const boundary = dates.map((d, i) => tx(d, i === 3 ? 10.5 : 10.0, 'BOUNDARY BOX'));
  assert.equal(detectRecurring(boundary)[0].priceCreep, false);
});

test('mixed cadences sort by monthly-equivalent cost', () => {
  const rows = [
    ...['2026-01-05', '2026-02-04', '2026-03-06'].map(d => tx(d, 20.0, 'MONTHLY SUB')),
    ...['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'].map(d => tx(d, 9.99, 'WEEKLY BOX')),
  ];
  const out = detectRecurring(rows);
  assert.deepEqual(out.map(r => r.key), ['WEEKLY BOX', 'MONTHLY SUB'],
    '$9.99/wk ≈ $43.29/mo outranks $20/mo despite the smaller per-charge amount');
});

test('one-off and twice-only purchases are never flagged', () => {
  const rows = [
    tx('2026-01-05', 500, 'BIG PURCHASE'),
    tx('2026-02-04', 20, 'TWICE ONLY'),
    tx('2026-03-06', 20, 'TWICE ONLY'),
  ];
  assert.equal(detectRecurring(rows).length, 0);
});

test('money in, transfers and returns can never be subscriptions', () => {
  const monthly = (merchant, extra) =>
    ['2026-01-05', '2026-02-04', '2026-03-06', '2026-04-05'].map(d => tx(d, 100, merchant, extra));
  assert.equal(detectRecurring(monthly('PAYROLL', { amount: -100 }).map(t => ({ ...t, amount: -100 }))).length, 0);
  assert.equal(detectRecurring(monthly('CARD PAYMENT', { category: TRANSFER_CATEGORY })).length, 0);
  assert.equal(detectRecurring(monthly('REFUNDS', { category: RETURN_CATEGORY })).length, 0);
});

test('output ordering is deterministic: largest monthly amount first', () => {
  const rows = [
    ...['2026-01-05', '2026-02-04', '2026-03-06'].map(d => tx(d, 9.99, 'SMALL SUB')),
    ...['2026-01-08', '2026-02-07', '2026-03-09'].map(d => tx(d, 49.99, 'BIG SUB')),
  ];
  const out = detectRecurring(rows);
  assert.deepEqual(out.map(r => r.key), ['BIG SUB', 'SMALL SUB']);
  // Same rows in reverse order → same output.
  assert.deepEqual(detectRecurring([...rows].reverse()), out);
});

test('priceCreep: strictly more than 5% over the median flags; exactly 5% does not', () => {
  // Median of [20, 20, 20, 21] is 20 — a 21.00 last charge is EXACTLY 5%.
  const dates = ['2026-01-05', '2026-02-04', '2026-03-06', '2026-04-05'];
  const atBoundary = dates.map((d, i) => tx(d, i === 3 ? 21.0 : 20.0, 'EXACT FIVE'));
  const r1 = detectRecurring(atBoundary)[0];
  assert.equal(r1.lastAmount, 21.0);
  assert.equal(r1.priceCreep, false, 'exactly 5% is not creep');

  const justOver = dates.map((d, i) => tx(d, i === 3 ? 21.01 : 20.0, 'JUST OVER'));
  const r2 = detectRecurring(justOver)[0];
  assert.equal(r2.lastAmount, 21.01);
  assert.equal(r2.priceCreep, true, 'a cent past 5% is creep');

  // Constant amount: no creep, and lastAmount is the most recent charge.
  const flat = dates.map(d => tx(d, 15.99, 'FLAT SUB'));
  const r3 = detectRecurring(flat)[0];
  assert.equal(r3.lastAmount, 15.99);
  assert.equal(r3.priceCreep, false);
});

test('priceCreep: +6% over the median flags, +4% does not, medianAmount surfaced', () => {
  // Median of [20, 20, 20, last] is 20 for any last charge inside the kept band.
  const dates = ['2026-01-05', '2026-02-04', '2026-03-06', '2026-04-05'];
  const upSix = dates.map((d, i) => tx(d, i === 3 ? 21.2 : 20.0, 'SIX UP'));
  const r1 = detectRecurring(upSix)[0];
  assert.equal(r1.medianAmount, 20.0, 'the median the creep check compares against');
  assert.equal(r1.lastAmount, 21.2);
  assert.equal(r1.priceCreep, true, '+6% is creep');

  const upFour = dates.map((d, i) => tx(d, i === 3 ? 20.8 : 20.0, 'FOUR UP'));
  const r2 = detectRecurring(upFour)[0];
  assert.equal(r2.medianAmount, 20.0);
  assert.equal(r2.lastAmount, 20.8);
  assert.equal(r2.priceCreep, false, '+4% hides inside the 5% threshold');
});

test('due status derives from an injected today; null today keeps the fields null', () => {
  // STREAMFLIX fixture: nextDate 2026-05-03.
  const rows = [
    tx('2026-01-05', 15.99, 'STREAMFLIX.COM'),
    tx('2026-02-03', 15.99, 'STREAMFLIX.COM'),
    tx('2026-03-06', 15.99, 'STREAMFLIX.COM'),
    tx('2026-04-04', 15.99, 'STREAMFLIX.COM'),
  ];
  // No clock passed → pure output, due fields null.
  const bare = detectRecurring(rows)[0];
  assert.equal(bare.dueSoon, null);
  assert.equal(bare.overdue, null);
  assert.equal(bare.dueStatus, null);

  // 8 days out: not yet due soon — dueStatus stays null even with a clock.
  const far = detectRecurring(rows, '2026-04-25')[0];
  assert.equal(far.dueSoon, false);
  assert.equal(far.overdue, false);
  assert.equal(far.dueStatus, null);

  // Exactly 7 days out: due soon.
  const week = detectRecurring(rows, '2026-04-26')[0];
  assert.equal(week.dueSoon, true);
  assert.equal(week.overdue, false);
  assert.equal(week.dueStatus, 'due-soon');

  // On the day itself: still due soon, not overdue.
  const onDay = detectRecurring(rows, '2026-05-03')[0];
  assert.equal(onDay.dueSoon, true);
  assert.equal(onDay.overdue, false);
  assert.equal(onDay.dueStatus, 'due-soon');

  // The day after: overdue, no longer due soon.
  const late = detectRecurring(rows, '2026-05-04')[0];
  assert.equal(late.dueSoon, false);
  assert.equal(late.overdue, true);
  assert.equal(late.dueStatus, 'overdue');
});

test('item shape is stable: existing fields unchanged, new fields additive', () => {
  const rows = [
    tx('2026-01-05', 15.99, 'STREAMFLIX.COM'),
    tx('2026-02-03', 15.99, 'STREAMFLIX.COM'),
    tx('2026-03-06', 15.99, 'STREAMFLIX.COM'),
    tx('2026-04-04', 15.99, 'STREAMFLIX.COM'),
  ];
  const r = detectRecurring(rows, '2026-04-26')[0];
  // The full key set — a rename or removal here breaks Dashboard's consumers.
  // (cadence + monthlyEquivalent are the recurring-v2 additions.)
  assert.deepEqual(Object.keys(r).sort(), [
    'account_id', 'avgGapDays', 'cadence', 'category', 'count', 'dueSoon',
    'dueStatus', 'key', 'lastAmount', 'lastDate', 'medianAmount',
    'monthlyAmount', 'monthlyEquivalent', 'name', 'nextDate', 'overdue',
    'priceCreep',
  ]);
  // Pre-existing fields keep their values from the detection heuristic.
  assert.equal(r.key, 'STREAMFLIX COM');
  assert.equal(r.monthlyAmount, 15.99);
  assert.equal(r.lastDate, '2026-04-04');
  assert.equal(r.nextDate, '2026-05-03');
  assert.equal(r.count, 4);
  // A monthly item carries cadence 'monthly' and a monthlyEquivalent equal to
  // its monthlyAmount — the pre-v2 fields mean exactly what they always did.
  assert.equal(r.cadence, 'monthly');
  assert.equal(r.monthlyEquivalent, r.monthlyAmount);
});

test('parseIgnoreList: tolerant parse of the rec:ignore settings row', () => {
  // Absent/blank/garbage rows must never take the Recurring tab down.
  assert.deepEqual(parseIgnoreList(null), []);
  assert.deepEqual(parseIgnoreList(undefined), []);
  assert.deepEqual(parseIgnoreList(''), []);
  assert.deepEqual(parseIgnoreList('  '), []);
  assert.deepEqual(parseIgnoreList('not json'), []);
  assert.deepEqual(parseIgnoreList('{"a":true}'), [], 'a non-array parses to empty');
  // Valid entries keep their order; dupes, empties, and non-strings drop.
  assert.deepEqual(
    parseIgnoreList('["WEEKLY BOX","STREAMFLIX COM","WEEKLY BOX","",42,null]'),
    ['WEEKLY BOX', 'STREAMFLIX COM']
  );
});

test('name and category come from the most frequent values in the group', () => {
  const rows = [
    tx('2026-01-05', 15.99, 'STREAMFLIX.COM'),
    tx('2026-02-03', 15.99, 'STREAMFLIX COM 8873'),
    tx('2026-03-06', 15.99, 'STREAMFLIX.COM'),
  ];
  const out = detectRecurring(rows);
  assert.equal(out.length, 1, 'the store-number variant normalizes into the same group');
  assert.equal(out[0].name, 'STREAMFLIX.COM');
});
