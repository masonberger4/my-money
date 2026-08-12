// Covers src/taxReport.js, the pure tax lens. The properties that matter:
//
//  * Money never disappears silently: every non-excluded row lands in exactly
//    one of rents / a mapped line / the visible unmapped bucket / the capital
//    list. (The Uncategorized lesson applied to tax lines — the failure mode
//    this guards against is a report that quietly drops what it can't place.)
//  * Capital expenses NEVER reach an expense line, even when their category is
//    mapped — an improvement that also lands on line 14 is double-counted.
//  * Refunds net: the app stores positive = out, and a mapped negative must
//    reduce its line, not become income.
//  * The mileage table is effective-dated and the 2026 mid-year rate change
//    lands on the right day, via string comparison (no Date, no TZ drift).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULE_E_LINES,
  RENTS_KEY,
  scheduleEReport,
  entityMonthly,
  entityLedger,
  personalDeductionReport,
  DEDUCTION_BUCKETS,
  DEFAULT_SCHEDULE_E_MAP,
  DEFAULT_DEDUCTION_MAP,
  MILEAGE_RATES,
  mileageRate,
  mileageDeduction,
  scheduleECsv,
} from '../src/taxReport.js';

const tx = (over) => ({
  id: over.id ?? 'x',
  transaction_date: '2026-03-10',
  amount: 0,
  category: 'Uncategorized',
  merchant_name: 'M',
  is_capital: false,
  placed_in_service: null,
  useful_life_years: null,
  excluded: false,
  ...over,
});

test('scheduleEReport routes every row to exactly one section', () => {
  const mapping = { Utilities: 17, 'Home maintenance and improvement': 14, Rent: RENTS_KEY };
  const rows = [
    tx({ id: 'a', amount: 120.5, category: 'Utilities' }),
    tx({ id: 'b', amount: -20.5, category: 'Utilities' }), // refund nets line 17
    tx({ id: 'c', amount: 300, category: 'Home maintenance and improvement' }),
    tx({ id: 'd', amount: -1800, category: 'Cash, checks, and misc' }), // unmapped money in = rent
    tx({ id: 'e', amount: -1800, category: 'Rent' }), // explicitly mapped rent
    tx({ id: 'f', amount: 75, category: 'Dining out' }), // unmapped money out
    tx({ id: 'g', amount: 9000, category: 'Home maintenance and improvement', is_capital: true, placed_in_service: '2026-03-15', useful_life_years: 27 }),
    tx({ id: 'h', amount: 55, category: 'Utilities', excluded: true }), // excluded rows invisible
  ];
  const r = scheduleEReport(rows, mapping);

  assert.equal(r.lines.find((l) => l.line === 17).total, 100); // 120.50 − 20.50
  assert.equal(r.lines.find((l) => l.line === 14).total, 300); // capital row g NOT here
  assert.equal(r.rents.total, 3600);
  assert.equal(r.rents.count, 2);
  assert.deepEqual(r.unmapped, [{ category: 'Dining out', total: 75, count: 1 }]);
  assert.equal(r.capital.total, 9000);
  assert.equal(r.capital.items[0].placed_in_service, '2026-03-15');
  assert.equal(r.totalExpenses, 400);
  assert.equal(r.net, 3600 - 400);

  // Conservation: rents + lines + unmapped + capital account for every
  // non-excluded dollar (as absolute flows, refunds netted inside sections).
  const placed = r.rents.total - 0 + r.totalExpenses + r.unmappedTotal + r.capital.total;
  assert.equal(placed, 3600 + 400 + 75 + 9000);
});

test('scheduleEReport is defensive about garbage input', () => {
  assert.equal(scheduleEReport(null, null).rents.total, 0);
  assert.equal(scheduleEReport([null, {}], undefined).totalExpenses, 0);
  const r = scheduleEReport([tx({ amount: 10, category: 'X' })], { X: 999 }); // unknown line number
  assert.equal(r.unmapped.length, 1, 'a mapping to a nonexistent line falls back to visible-unmapped');
});

test('scheduleEReport line 18 (depreciation) is not a mappable line', () => {
  assert.ok(!SCHEDULE_E_LINES.some((l) => l.line === 18));
  const r = scheduleEReport([tx({ amount: 50, category: 'X' })], { X: 18 });
  assert.equal(r.unmapped[0].total, 50);
});

test('unmapped bucket sorts by size then name, deterministically', () => {
  const rows = [
    tx({ amount: 10, category: 'B' }),
    tx({ amount: 10, category: 'A' }),
    tx({ amount: 40, category: 'C' }),
  ];
  const r = scheduleEReport(rows, {});
  assert.deepEqual(r.unmapped.map((u) => u.category), ['C', 'A', 'B']);
});

test('entityMonthly builds a sorted cash P&L including capital outflows', () => {
  const rows = [
    tx({ transaction_date: '2026-02-03', amount: -1800 }),
    tx({ transaction_date: '2026-01-15', amount: 200 }),
    tx({ transaction_date: '2026-01-02', amount: -1800 }),
    tx({ transaction_date: '2026-01-20', amount: 9000, is_capital: true }),
  ];
  const m = entityMonthly(rows);
  assert.deepEqual(m.map((x) => x.ym), ['2026-01', '2026-02']);
  assert.equal(m[0].income, 1800);
  assert.equal(m[0].expenses, 9200);
  assert.equal(m[0].net, -7400);
});

test('entityLedger: every row lands in exactly one section, totals match entityMonthly', () => {
  const rows = [
    tx({ id: 'a', amount: -1800, transaction_date: '2026-01-03' }), // money in
    tx({ id: 'b', amount: 240.25, transaction_date: '2026-02-11' }), // money out
    tx({ id: 'c', amount: 950, transaction_date: '2026-02-11', is_capital: true }), // capital is still cash out
    tx({ id: 'd', amount: 55, excluded: true }), // excluded: visible, not counted
    tx({ id: 'e', amount: 0 }), // zero: not counted
  ];
  const led = entityLedger(rows);
  const placed = led.moneyIn.rows.length + led.moneyOut.rows.length + led.notCounted.rows.length;
  assert.equal(placed, rows.length); // conservation — no row silently dropped
  assert.deepEqual(led.moneyIn.rows.map((t) => t.id), ['a']);
  assert.deepEqual(led.moneyOut.rows.map((t) => t.id), ['b', 'c']);
  assert.deepEqual(led.notCounted.rows.map((t) => t.id).sort(), ['d', 'e']);
  // The sheet's section totals ARE the card's numbers: the sheet opens from a
  // tapped Money in / Money out, and the list must sum to what was tapped.
  const months = entityMonthly(rows);
  assert.equal(led.moneyIn.total, months.reduce((s, m2) => s + m2.income, 0));
  assert.equal(led.moneyOut.total, months.reduce((s, m2) => s + m2.expenses, 0));
});

test('entityLedger orders newest first with a deterministic same-day tie-break', () => {
  const rows = [
    tx({ id: 'b', amount: 10, transaction_date: '2026-05-02' }),
    tx({ id: 'a', amount: 10, transaction_date: '2026-05-02' }),
    tx({ id: 'z', amount: 10, transaction_date: '2026-01-15' }),
    tx({ id: 'q', amount: 10, transaction_date: '2026-11-30' }),
  ];
  assert.deepEqual(entityLedger(rows).moneyOut.rows.map((t) => t.id), ['q', 'a', 'b', 'z']);
});

test('entityLedger never throws on junk (it runs during render)', () => {
  assert.deepEqual(entityLedger(null).moneyIn.rows, []);
  assert.deepEqual(entityLedger(undefined).moneyOut.rows, []);
  const led = entityLedger([null, tx({ id: 'a', amount: 'nonsense' })]);
  assert.deepEqual(led.notCounted.rows.map((t) => t.id), ['a']); // NaN amount → not counted, still visible
});

test('personalDeductionReport totals mapped buckets and nets refunds', () => {
  const mapping = { 'Healthcare and pharmacy': 'medical', Giving: 'charitable' };
  const rows = [
    tx({ amount: 250, category: 'Healthcare and pharmacy' }),
    tx({ amount: -50, category: 'Healthcare and pharmacy' }),
    tx({ amount: 100, category: 'Giving' }),
    tx({ amount: 999, category: 'Dining out' }), // unmapped: not a deduction
    tx({ amount: 40, category: 'Giving', excluded: true }),
  ];
  const r = personalDeductionReport(rows, mapping);
  const byKey = Object.fromEntries(r.map((b) => [b.key, b]));
  assert.equal(byKey.medical.total, 200);
  assert.equal(byKey.medical.count, 2);
  assert.equal(byKey.charitable.total, 100);
  assert.equal(byKey.taxes_paid.total, 0);
  assert.equal(r.length, DEDUCTION_BUCKETS.length, 'every bucket present even at zero');
});

test('mileageRate picks the effective-dated rate by string comparison', () => {
  assert.equal(mileageRate('2026-06-30'), 0.725);
  assert.equal(mileageRate('2026-07-01'), 0.76, 'the 2026 mid-year raise lands exactly on July 1');
  assert.equal(mileageRate('2025-12-31'), 0.70);
  assert.equal(mileageRate('2024-01-01'), 0.67);
  assert.equal(mileageRate('2023-12-31'), null, 'before the table = unknown, never guessed');
  assert.equal(mileageRate(''), null);
  assert.equal(mileageRate(undefined), null);
});

test('mileageDeduction splits a straddling year by rate and counts unrated miles', () => {
  const r = mileageDeduction([
    { on_date: '2026-03-01', miles: 100 },
    { on_date: '2026-08-01', miles: 100 },
    { on_date: '2023-05-01', miles: 40 },
    { on_date: '2026-08-02', miles: 0 }, // ignored
  ]);
  assert.equal(r.miles, 200);
  assert.equal(r.amount, 148.5); // 100×0.725 + 100×0.76
  assert.equal(r.unratedMiles, 40);
  assert.deepEqual(r.byRate, [
    { rate: 0.725, miles: 100, amount: 72.5 },
    { rate: 0.76, miles: 100, amount: 76 },
  ]);
});

// The app ships no built-in categories (2026-08-04), so there is nothing
// honest to pre-map onto a tax line: the two entries these maps used to carry
// pointed at deleted built-ins ('Home maintenance and improvement' → 14,
// Utilities → 17, 'Healthcare and pharmacy' → medical). Mapping is now fully
// user-driven through the existing `tax:maps` settings key.
test('the default tax maps are EMPTY — category→line mapping is fully user-driven', () => {
  assert.deepEqual(DEFAULT_SCHEDULE_E_MAP, {});
  assert.deepEqual(DEFAULT_DEDUCTION_MAP, {});
});

test('with the empty default map every expense lands in the VISIBLE unmapped bucket', () => {
  // The behavior that makes an empty default safe: nothing is silently dropped
  // and nothing is guessed onto a line — the preparer sees the whole amount
  // sitting in "not on any line yet" (the Uncategorized lesson, tax edition).
  const rows = [
    tx({ amount: 300, category: 'Repairs' }),
    tx({ amount: 120, category: 'Power bill' }),
  ];
  const r = scheduleEReport(rows, DEFAULT_SCHEDULE_E_MAP);
  assert.equal(r.totalExpenses, 0, 'no line claims anything');
  assert.equal(r.unmappedTotal, 420, 'every dollar is visible in the unmapped bucket');
  assert.deepEqual(r.unmapped.map((u) => u.category).sort(), ['Power bill', 'Repairs']);
  // And a user mapping is all it takes to place them.
  const mapped = scheduleEReport(rows, { Repairs: 14, 'Power bill': 17 });
  assert.equal(mapped.totalExpenses, 420);
  assert.deepEqual(mapped.unmapped, []);
});

test('lines always contains every Schedule E line in order, including zeros', () => {
  // The Tax tab maps over r.lines and the CSV emits a row per line — a future
  // "filter zero lines" cleanup would break both, so the full shape is pinned
  // on an EMPTY report.
  const r = scheduleEReport([], {});
  assert.deepEqual(r.lines.map((l) => l.line), SCHEDULE_E_LINES.map((l) => l.line));
  assert.ok(r.lines.every((l) => l.total === 0));
});

test('a positive amount in a RENTS_KEY category nets rents down (returned deposit)', () => {
  const r = scheduleEReport(
    [tx({ amount: -1800, category: 'Rent' }), tx({ amount: 500, category: 'Rent' })],
    { Rent: RENTS_KEY },
  );
  assert.equal(r.rents.total, 1300);
  assert.equal(r.rents.defaulted.count, 0, 'explicitly mapped rent is never "defaulted"');
});

test('a mapped line can net negative overall and stays visible', () => {
  const r = scheduleEReport(
    [tx({ amount: 40, category: 'Utilities' }), tx({ amount: -100, category: 'Utilities' })],
    { Utilities: 17 },
  );
  assert.equal(r.lines.find((l) => l.line === 17).total, -60);
  const csv = scheduleECsv(r, { entityName: 'X', year: 2026 });
  assert.ok(csv.includes('17,Utilities,-60.00'), 'the preparer sees the negative line in the CSV');
});

test('unmapped money in is counted as rent AND reported as defaulted', () => {
  // The settled default (unmapped deposits = rent) with the visibility the
  // review demanded: a refund in an unmapped expense category lands in rents,
  // and the defaulted subtotal is what lets the preparer audit that.
  const r = scheduleEReport(
    [tx({ amount: -1800, category: 'Cash, checks, and misc' }), tx({ amount: -25, category: 'Dining out' })],
    {},
  );
  assert.equal(r.rents.total, 1825);
  assert.deepEqual(r.rents.defaulted, { total: 1825, count: 2 });
  assert.ok(scheduleECsv(r, {}).includes('counted as rent by default'));
});

test('net uses the same rounded rents value the report displays', () => {
  const r = scheduleEReport(
    [tx({ amount: -100.005, category: 'X' }), tx({ amount: 10, category: 'Utilities' })],
    { Utilities: 17 },
  );
  assert.equal(r.net, Math.round((r.rents.total - r.totalExpenses) * 100) / 100);
});

test('personalDeductionReport skips unknown bucket keys instead of hiding money in them', () => {
  const r = personalDeductionReport(
    [tx({ amount: 100, category: 'Giving' })],
    { Giving: 'renamed_bucket_from_the_future' },
  );
  assert.ok(r.every((b) => b.total === 0 && b.count === 0));
});

test('MILEAGE_RATES is strictly ascending by effective date', () => {
  // The file is edited every January; an out-of-order insert must fail a test,
  // not silently misprice drives (mileageRate also picks max-from, not
  // last-in-array, as a second belt).
  for (let i = 1; i < MILEAGE_RATES.length; i++) {
    assert.ok(MILEAGE_RATES[i - 1].from < MILEAGE_RATES[i].from);
  }
});

test('scheduleECsv structure: header row, every line present, trailing newline', () => {
  const csv = scheduleECsv(scheduleEReport([], {}), { entityName: 'X', year: 2026 });
  assert.ok(csv.endsWith('\n'));
  const lines = csv.split('\n');
  assert.ok(lines.includes('line,label,total'));
  for (const l of SCHEDULE_E_LINES) assert.ok(lines.some((row) => row.startsWith(`${l.line},`)));
});

test('csvCell quotes carriage returns', () => {
  const r = scheduleEReport(
    [tx({ amount: 500, category: 'X', is_capital: true, merchant_name: 'BAD\rVENDOR' })],
    {},
  );
  const csv = scheduleECsv(r, {});
  assert.ok(csv.includes('"BAD\rVENDOR"'));
});

test('csvCell neutralizes formula triggers, never the minus sign', () => {
  const r = scheduleEReport(
    [
      tx({ amount: 500, category: 'X', is_capital: true, merchant_name: '=HYPERLINK("http://evil")' }),
      tx({ amount: 300, category: 'X', is_capital: true, merchant_name: '+SUM(A1:A9)' }),
      tx({ amount: 200, category: 'X', is_capital: true, merchant_name: '@cmd' }),
      tx({ amount: 100, category: 'X', is_capital: true, merchant_name: '\tpayload' }),
      tx({ amount: 40, category: 'Utilities' }),
      tx({ amount: -100, category: 'Utilities' }),
    ],
    { Utilities: 17 },
  );
  const csv = scheduleECsv(r, {});
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil"")"'), 'apostrophe-prefixed BEFORE quoting');
  assert.ok(csv.includes("'+SUM(A1:A9)"));
  assert.ok(csv.includes("'@cmd"));
  assert.ok(csv.includes("'\tpayload"));
  assert.ok(csv.includes('17,Utilities,-60.00'), 'negative amount cells stay byte-identical');
  assert.ok(!csv.includes("'-"), 'a leading minus is never neutralized');
});

test('scheduleECsv receipt column: only with receiptTxIds, yes/MISSING per row', () => {
  const r = scheduleEReport(
    [
      tx({ id: 'has', amount: 500, category: 'X', is_capital: true }),
      tx({ id: 'lacks', amount: 300, category: 'X', is_capital: true }),
    ],
    {},
  );
  // Without receiptTxIds (feature not installed) the capital table is
  // unchanged — no column, no MISSING stamped on anything.
  const plain = scheduleECsv(r, {});
  assert.ok(!plain.includes('receipt'));
  assert.ok(!plain.includes('MISSING'));
  const csv = scheduleECsv(r, { receiptTxIds: new Set(['has']) });
  assert.ok(csv.includes('useful_life_years,receipt'));
  const lines = csv.split('\n');
  assert.ok(lines.some((l) => l.startsWith('2026-03-10,M,500.00') && l.endsWith(',yes')));
  assert.ok(lines.some((l) => l.startsWith('2026-03-10,M,300.00') && l.endsWith(',MISSING')));
});

test('scheduleECsv escapes and carries the sign-convention column name', () => {
  const r = scheduleEReport(
    [
      tx({ amount: 10, category: 'Utilities' }),
      tx({ amount: 500, category: 'X', is_capital: true, merchant_name: 'Doors, "Custom" Co' }),
    ],
    { Utilities: 17 },
  );
  const csv = scheduleECsv(r, { entityName: 'Maple St', year: 2026 });
  assert.ok(csv.includes('amount_positive_is_outflow'));
  assert.ok(csv.includes('"Doors, ""Custom"" Co"'), 'RFC-4180 quoting for commas and quotes');
  assert.ok(csv.includes('Not tax advice'));
});
