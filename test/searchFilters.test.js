import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseAmount,
  sanitizeDateInput,
  buildSearchFilters,
  amountOrClause,
  searchIsActive,
  DATE_YEAR_FLOOR,
  EDIT_YEAR_FLOOR,
  dateCommit,
} from '../src/searchFilters.js';

test('parseAmount: dollars/commas/spaces stripped, sign dropped (abs matching)', () => {
  assert.equal(parseAmount('80'), 80);
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount(' 12.5 '), 12.5);
  assert.equal(parseAmount('-80'), 80); // a typed sign still means "an $80 transaction"
  assert.equal(parseAmount('0'), 0);
});

test('parseAmount: garbage and empties read as "no filter", never 0', () => {
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('   '), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('12abc'), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
  assert.equal(parseAmount('Infinity'), null);
});

test('sanitizeDateInput: complete sane dates pass, mid-typing years are dropped', () => {
  assert.equal(sanitizeDateInput('2026-06-15'), '2026-06-15');
  // The <input type="date"> mid-typing sequence from the CLAUDE.md gotcha:
  assert.equal(sanitizeDateInput('0002-06-15'), null);
  assert.equal(sanitizeDateInput('0020-06-15'), null);
  assert.equal(sanitizeDateInput('0202-06-15'), null);
  assert.equal(sanitizeDateInput('2226-06-15'), null); // above the ceiling too
  assert.equal(sanitizeDateInput(''), null);
  assert.equal(sanitizeDateInput('2026-6-5'), null);
  assert.equal(sanitizeDateInput(undefined), null);
  assert.equal(sanitizeDateInput(`${DATE_YEAR_FLOOR}-01-01`), `${DATE_YEAR_FLOOR}-01-01`);
  assert.equal(sanitizeDateInput(`${DATE_YEAR_FLOOR - 1}-12-31`), null);
});

// 2026-10 audit: Chrome's year segment keeps taking digits, so one extra
// keystroke yields "20261-09-15" — which the old hand-rolled
// `raw.slice(0,4)>="1900"` guards at the date EDIT inputs passed, moving a
// transaction out of every month view.
test('sanitizeDateInput: 5- and 6-digit years fail the full-shape check', () => {
  assert.equal(sanitizeDateInput('20261-09-15'), null);
  assert.equal(sanitizeDateInput('202612-09-15'), null);
  assert.equal(sanitizeDateInput('20261-09-15', EDIT_YEAR_FLOOR), null);
});

test('sanitizeDateInput: the floor is a parameter; record edits keep the 1900 floor', () => {
  assert.equal(EDIT_YEAR_FLOOR, 1900);
  assert.equal(sanitizeDateInput('1955-03-01'), null, 'the search floor stays DATE_YEAR_FLOOR');
  assert.equal(sanitizeDateInput('1955-03-01', EDIT_YEAR_FLOOR), '1955-03-01');
  assert.equal(sanitizeDateInput('1899-12-31', EDIT_YEAR_FLOOR), null);
  assert.equal(sanitizeDateInput('2101-01-01', EDIT_YEAR_FLOOR), null, 'the 2100 ceiling still holds');
});

test('dateCommit: empty clears, garbage REVERTS (never deletes), a valid change saves', () => {
  // The placed-in-service regression: typing "25" in the year segment blurs
  // as "0025-05-01" and used to SAVE null, deleting the stored date.
  assert.deepEqual(dateCommit('0025-05-01', '2024-05-01'), { action: 'revert', value: '2024-05-01' });
  assert.deepEqual(dateCommit('20261-05-01', '2024-05-01'), { action: 'revert', value: '2024-05-01' });
  assert.deepEqual(dateCommit('0025-05-01', null), { action: 'revert', value: null });
  assert.deepEqual(dateCommit('', '2024-05-01'), { action: 'clear', value: null });
  assert.deepEqual(dateCommit('', null), { action: 'noop', value: null }, 'nothing stored, nothing to clear');
  assert.deepEqual(dateCommit(null, ''), { action: 'noop', value: null });
  assert.deepEqual(dateCommit('2024-05-01', '2024-05-01'), { action: 'noop', value: '2024-05-01' });
  assert.deepEqual(dateCommit('2025-01-02', '2024-05-01'), { action: 'save', value: '2025-01-02' });
  assert.deepEqual(dateCommit('2025-01-02', null), { action: 'save', value: '2025-01-02' });
  assert.deepEqual(dateCommit('1960-07-01', null), { action: 'save', value: '1960-07-01' }, 'an old in-service date is a real date');
});

test('Dashboard date EDIT inputs go through dateCommit / sanitizeDateInput, never a 4-char prefix compare', () => {
  const src = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /slice\(0,4\)>=["']1900["']/, 'no hand-rolled year guard may creep back');
  assert.match(src, /dateCommit\(ev\.target\.value,selTx\.transaction_date\)/);
  assert.match(src, /dateCommit\(ev\.target\.value,selTx\.placed_in_service\)/);
  assert.match(src, /dateCommit\(ev\.target\.value,a\.next_payment_due_date\)/);
  const mile = src.slice(src.indexOf('async function handleAddMileage('), src.indexOf('async function handleDeleteMileage('));
  assert.match(mile, /sanitizeDateInput\(mileForm\.on_date/, 'a mid-typed drive date must not be savable');
  assert.match(mile, /savedOutsideYear\(/, 'a drive saved outside the viewed year is announced');
});

test('buildSearchFilters: null when nothing active (the "filters on?" test)', () => {
  assert.equal(buildSearchFilters(), null);
  assert.equal(buildSearchFilters({ amtMin: '', amtMax: '', dateFrom: '', dateTo: '' }), null);
  assert.equal(buildSearchFilters({ amtMin: 'abc', dateFrom: '0202-06-15' }), null);
});

test('buildSearchFilters: normalizes, and swaps inverted ranges instead of emptying', () => {
  assert.deepEqual(buildSearchFilters({ amtMin: '$100', amtMax: '20' }), {
    amountMin: 20, amountMax: 100, dateFrom: null, dateTo: null,
  });
  assert.deepEqual(buildSearchFilters({ dateFrom: '2026-07-01', dateTo: '2026-01-01' }), {
    amountMin: null, amountMax: null, dateFrom: '2026-01-01', dateTo: '2026-07-01',
  });
  // One-sided stays one-sided.
  assert.deepEqual(buildSearchFilters({ amtMax: '50' }), {
    amountMin: null, amountMax: 50, dateFrom: null, dateTo: null,
  });
});

test('amountOrClause: both bounds — the two mirrored and() branches', () => {
  assert.equal(
    amountOrClause(20, 100),
    'and(amount.gte.20,amount.lte.100),and(amount.gte.-100,amount.lte.-20)'
  );
});

test('amountOrClause: min only — |amount| >= min', () => {
  assert.equal(amountOrClause(80, null), 'amount.gte.80,amount.lte.-80');
});

test('amountOrClause: max only — one band around zero', () => {
  assert.equal(amountOrClause(null, 50), 'and(amount.gte.-50,amount.lte.50)');
});

test('amountOrClause: zero bounds never emit "-0", and no bounds is null', () => {
  assert.equal(amountOrClause(0, null), 'amount.gte.0,amount.lte.0');
  assert.equal(amountOrClause(null, 0), 'and(amount.gte.0,amount.lte.0)');
  assert.equal(amountOrClause(0, 100), 'and(amount.gte.0,amount.lte.100),and(amount.gte.-100,amount.lte.0)');
  assert.equal(amountOrClause(null, null), null);
});

// The clause is interpolated into PostgREST or-syntax: whatever buildSearchFilters
// produces must never contain the characters that syntax reserves.
test('amountOrClause output stays PostgREST-safe for parseAmount outputs', () => {
  for (const raw of ['$1,234.56', '99999999', '0.005', '-42']) {
    const min = parseAmount(raw);
    const clause = amountOrClause(min, min * 2);
    assert.ok(!/[^a-z0-9.,()-]/.test(clause), clause);
    assert.ok(!clause.includes('(('), clause);
  }
});

// --- searchIsActive: the shared "is a search on?" gate ------------------
// Dashboard's searchActive flag and the adapter's early-out both use it, so
// the two can never disagree about whether a filter-only search counts.

test('searchIsActive: text query needs >= 2 chars', () => {
  assert.equal(searchIsActive('', null), false);
  assert.equal(searchIsActive('a', null), false);
  assert.equal(searchIsActive('ab', null), true);
  assert.equal(searchIsActive('  ab  ', null), true); // trimmed
  assert.equal(searchIsActive(' a ', null), false);
  assert.equal(searchIsActive(null, null), false);
  assert.equal(searchIsActive(undefined, null), false);
});

test('searchIsActive: non-null filters activate with NO text query (filter-only search)', () => {
  const filters = buildSearchFilters({ amtMin: '500' });
  assert.notEqual(filters, null);
  assert.equal(searchIsActive('', filters), true);
  assert.equal(searchIsActive('a', filters), true); // short text + filters still active
});

test('searchIsActive: all-empty filters normalize to null and do NOT activate', () => {
  const filters = buildSearchFilters({ amtMin: '', amtMax: '', dateFrom: '', dateTo: '' });
  assert.equal(filters, null);
  assert.equal(searchIsActive('', filters), false);
});

test('searchIsActive: date-only filters activate too', () => {
  const filters = buildSearchFilters({ dateFrom: '2026-06-01', dateTo: '2026-06-30' });
  assert.equal(searchIsActive('', filters), true);
});
