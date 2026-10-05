// The shared display formatters and wall-clock date helpers (src/format.js):
// the −$ glyph, the rounding every money site depends on, and the date rules
// that keep a stored 'YYYY-MM-DD' from being read as UTC midnight.
//
// TZ is pinned to a western zone BEFORE any Date is built (node --test runs
// each file in its own process, and Node re-reads process.env.TZ on assignment)
// so the UTC-off-by-one cases actually bite here instead of passing by luck on
// a UTC CI box.
process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  periodYM, localTodayIso, ordinalSuffix, monthLabel, shortDate, localShortDate,
  fmt, fmtX, fmtAuto, signed, monthYear, numericish,
} from '../src/format.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MD = { month: 'short', day: 'numeric' };

test('the TZ pin took: a UTC-midnight parse lands on the previous local day', () => {
  // If this fails, every date assertion below is passing for the wrong reason.
  assert.equal(new Date('2026-08-01').getDate(), 31);
});

test('fmt: whole dollars, thousands separators, U+2212 minus for negatives', () => {
  assert.equal(fmt(1234.5), '$1,235');
  assert.equal(fmt(-1234.5), '−$1,235');
  assert.equal(fmt(0), '$0');
  assert.equal(fmt('42'), '$42', 'numeric strings are read as numbers');
  assert.ok(!fmt(-5).includes('-'), 'never the ASCII hyphen-minus');
});

test('fmtX: always two decimals, same minus glyph', () => {
  assert.equal(fmtX(-1234.56), '−$1,234.56');
  assert.equal(fmtX(1234.5), '$1,234.50');
  assert.equal(fmtX(0), '$0.00');
});

test('fmtAuto: whole dollars when there are no cents, two decimals when there are', () => {
  assert.equal(fmtAuto(12), '$12');
  assert.equal(fmtAuto(12.5), '$12.50');
  assert.equal(fmtAuto(-12.5), '−$12.50');
  assert.equal(fmtAuto(1200), '$1,200');
});

test('signed: + on money that rose, the formatter\'s own − on money that fell', () => {
  assert.equal(signed(5), '+$5');
  assert.equal(signed(-5), '−$5');
  assert.equal(signed(5.25), '+$5.25');
  assert.equal(signed(0), '$0');
});

test('periodYM reads the month off the STRING (never through Date)', () => {
  assert.deepEqual(periodYM('2026-08-01'), { y: 2026, m: 8 });
  assert.deepEqual(periodYM('2026-12-31'), { y: 2026, m: 12 });
});

test('shortDate reads a stored date-only string as a LOCAL day', () => {
  assert.equal(shortDate('2026-08-01'), new Date(2026, 7, 1).toLocaleDateString('default', MD));
  assert.notEqual(shortDate('2026-08-01'), new Date('2026-08-01').toLocaleDateString('default', MD),
    'the UTC-midnight parse would say Jul 31 here');
});

test('localShortDate renders an INSTANT in the reader\'s own zone', () => {
  // 00:30Z on Aug 2 is still Aug 1, 5:30pm in Los Angeles.
  const d = new Date('2026-08-02T00:30:00Z');
  assert.equal(localShortDate(d), new Date(2026, 7, 1).toLocaleDateString('default', MD));
});

test('ordinalSuffix covers the teens and the 1/2/3 endings', () => {
  const cases = { 1: 'st', 2: 'nd', 3: 'rd', 4: 'th', 11: 'th', 12: 'th', 13: 'th', 21: 'st', 22: 'nd', 23: 'rd', 111: 'th', 112: 'th' };
  for (const [n, want] of Object.entries(cases)) assert.equal(ordinalSuffix(n), want, `${n}${want}`);
});

test('monthLabel and monthYear build from local parts', () => {
  assert.equal(monthLabel(2026, 8), new Date(2026, 7, 1).toLocaleString('default', { month: 'long', year: 'numeric' }));
  assert.equal(monthYear('2027-06-15'), new Date(2027, 5, 1).toLocaleString('default', { month: 'short', year: 'numeric' }));
  assert.equal(monthYear(''), '');
  assert.equal(monthYear(null), '');
});

test('localTodayIso is today on the wall clock, never the UTC day', () => {
  const d = new Date();
  const want = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(localTodayIso(), want);
});

test('numericish keeps one leading minus and one decimal point', () => {
  assert.equal(numericish('1-2'), '12');
  assert.equal(numericish('1.2.3'), '1.23');
  assert.equal(numericish(' -45.5'), '-45.5');
  assert.equal(numericish('-45', { negative: false }), '45');
  assert.equal(numericish('$1,234.56'), '1234.56');
});

test('ONE copy: Dashboard and CsvImport import the formatters instead of redefining them', () => {
  const dash = readFileSync(join(root, 'src/components/Dashboard.jsx'), 'utf8');
  const csv = readFileSync(join(root, 'src/components/CsvImport.jsx'), 'utf8');
  for (const name of ['fmt', 'fmtX', 'fmtAuto', 'signed', 'shortDate', 'localShortDate', 'periodYM', 'monthYear', 'numericish']) {
    assert.doesNotMatch(dash, new RegExp(`function ${name}\\s*\\(`), `Dashboard.jsx must not redefine ${name}`);
  }
  assert.doesNotMatch(csv, /function money\s*\(/i, 'CsvImport\'s fmtX copy is gone');
  assert.match(csv, /import \{[^}]*\bfmtX\b[^}]*\} from "\.\.\/format\.js"/);
});

test('REGRESSION: a rounding leftover never renders as −$0 or +$0', () => {
  // A credit-card refund that fully nets a purchase leaves spendingGroups
  // with a float residue, not zero: 10.10 + 20.20 − 30.30 = −3.55e-15. The
  // sign used to come from that raw value, so a fully refunded category read
  // "−$0" on Categories, the Home legend and the drill-in sheet. The sign
  // now comes from the DISPLAYED digits.
  const x = 10.10 + 20.20 - 30.30;
  assert.ok(x < 0 && x > -1e-12, 'the residue this test exists for');
  assert.equal(fmt(x), '$0');
  assert.equal(fmtX(x), '$0.00');
  assert.equal(fmtAuto(x), '$0');
  assert.equal(signed(x), '$0');
  assert.equal(signed(-x), '$0', 'and never +$0 the other way');
  assert.equal(fmt(-0), '$0');
  assert.equal(fmtX(-0), '$0.00');
});

test('REGRESSION: a real sub-unit amount that rounds to zero is unsigned too', () => {
  assert.equal(fmt(-0.4), '$0');
  assert.equal(fmtX(-0.004), '$0.00');
  assert.equal(signed(0.004), '$0');
});

test('the −$0 guard changes no digits: rounding stays half away from zero', () => {
  // A Math.round pre-round would turn −2.5 into −2; toLocaleString rounds
  // half away from zero, and those are the digits the app has always shown.
  assert.equal(fmt(-0.5), '−$1');
  assert.equal(fmt(-2.5), '−$3');
  assert.equal(fmt(2.5), '$3');
  assert.equal(fmtX(-0.005), '−$0.01');
  assert.equal(fmtX(-1234.56), '−$1,234.56');
  assert.equal(signed(0.01), '+$0.01');
  assert.equal(signed(-0.01), '−$0.01');
});
