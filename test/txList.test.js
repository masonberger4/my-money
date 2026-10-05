// The Spending list's day-grouping core (src/txList.js): grouping must be
// order-preserving (the caller's sort is the display order), labels must come
// off the date STRING (the UTC off-by-one rule), and garbage must degrade to
// stable output rather than throw mid-render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupByDay, longDate, liveAcctFilter } from '../src/txList.js';

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

// --- liveAcctFilter: an account chip naming a hidden account reads as unset ---
// Hiding the account the Spending list is filtered to (here, or on the other
// phone) left the list empty every month, and with one visible account left
// the chip row — the only control that clears the filter — unmounted.
test('liveAcctFilter keeps a visible account and drops a hidden or unknown one', () => {
  const accounts = [{ id: 'chk', hidden: false }, { id: 'card', hidden: true }, { id: 'sav' }];
  assert.equal(liveAcctFilter('chk', accounts), 'chk');
  assert.equal(liveAcctFilter('sav', accounts), 'sav', 'hidden unset means visible');
  assert.equal(liveAcctFilter('card', accounts), null, 'a hidden account filters nothing');
  assert.equal(liveAcctFilter('gone', accounts), null, 'an unlinked/unknown account filters nothing');
  assert.equal(liveAcctFilter(null, accounts), null);
  assert.equal(liveAcctFilter(undefined, accounts), null);
  assert.equal(liveAcctFilter('chk', null), null, 'no accounts loaded yet');
});

test('the Spending list reads the live account filter, never the raw state', () => {
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dash, /const acctFilter=liveAcctFilter\(txAcctFilter,accounts\);/);
  assert.match(dash, /const refineDirty=!!acctFilter\|\|!!txCatFilter;/,
    'the magnifier tell must not light for a filter that narrows nothing visible');
  assert.match(dash, /const acctTxsView=acctFilter\?/);
  assert.match(dash, /const acctSearchView=acctFilter\?/);
  // Code only (comments stripped): the raw state is read exactly twice —
  // its declaration and the liveAcctFilter call.
  const code = dash.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const reads = code.match(/\btxAcctFilter\b/g) || [];
  assert.equal(reads.length, 2,
    'something reads txAcctFilter directly — use acctFilter, or a filter on a hidden account strands the list');
});
