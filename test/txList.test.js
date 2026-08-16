// The Spending list's day-grouping core (src/txList.js): grouping must be
// order-preserving (the caller's sort is the display order), labels must come
// off the date STRING (the UTC off-by-one rule), and garbage must degrade to
// stable output rather than throw mid-render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay, longDate } from '../src/txList.js';

test('groups consecutive same-day rows under one section, preserving order', () => {
  const rows = [
    { id: 'a', transaction_date: '2026-08-14', amount: 100 },
    { id: 'b', transaction_date: '2026-08-14', amount: 24 },
    { id: 'c', transaction_date: '2026-08-13', amount: 18 },
    { id: 'd', transaction_date: '2026-08-12', amount: 9 },
  ];
  const sections = groupByDay(rows);
  assert.deepEqual(sections.map(s => s.date), ['2026-08-14', '2026-08-13', '2026-08-12']);
  assert.deepEqual(sections[0].rows.map(r => r.id), ['a', 'b'], 'in-day order preserved');
  const flat = sections.flatMap(s => s.rows.map(r => r.id));
  assert.deepEqual(flat, ['a', 'b', 'c', 'd'], 'flattening reproduces the input order');
});

test('reads transaction_date first, falls back to date (raw-row shape)', () => {
  const sections = groupByDay([{ date: '2026-07-01', amount: 5 }]);
  assert.equal(sections[0].date, '2026-07-01');
});

test('a date seen again later folds into its FIRST section — no duplicate headers', () => {
  const rows = [
    { id: 'a', transaction_date: '2026-08-14' },
    { id: 'b', transaction_date: '2026-08-13' },
    { id: 'c', transaction_date: '2026-08-14' }, // unsorted input
  ];
  const sections = groupByDay(rows);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0].rows.map(r => r.id), ['a', 'c']);
});

test('garbage passes through without throwing', () => {
  assert.deepEqual(groupByDay(null), []);
  assert.deepEqual(groupByDay([]), []);
  const sections = groupByDay([{ id: 'x' }]);
  assert.equal(sections[0].date, '');
  assert.equal(sections[0].rows.length, 1);
});

test('longDate renders the STRING date — no Date(), no UTC off-by-one', () => {
  assert.equal(longDate('2026-08-14'), 'August 14, 2026');
  assert.equal(longDate('2026-01-01'), 'January 1, 2026', 'the 1st stays the 1st');
  assert.equal(longDate('2026-12-31'), 'December 31, 2026');
});

test('longDate degrades to the raw string on garbage', () => {
  assert.equal(longDate(''), '');
  assert.equal(longDate('pending'), 'pending');
  assert.equal(longDate('2026-13-01'), '2026-13-01', 'impossible month = raw string');
  assert.equal(longDate(null), '');
});
