import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount,
  sanitizeDateInput,
  buildSearchFilters,
  amountOrClause,
  DATE_YEAR_FLOOR,
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
    assert.ok(!/[^a-z0-9.,()\-]/.test(clause), clause);
    assert.ok(!clause.includes('(('), clause);
  }
});
