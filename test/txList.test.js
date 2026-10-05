// The Spending list's day-grouping core (src/txList.js): grouping must be
// order-preserving (the caller's sort is the display order), labels must come
// off the date STRING (the UTC off-by-one rule), and garbage must degrade to
// stable output rather than throw mid-render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupByDay, longDate, liveAcctFilter, emptyListMessage, matchCountLabel, resortByEffectiveDate } from '../src/txList.js';

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

// --- emptyListMessage: every branch of the Spending list's empty state --------
// The hasMore-aware sentence used to exist for the category chip only, so an
// account chip over a truncated first page said "No transactions match" above
// a live Load more button.
test('emptyListMessage: an account chip over a truncated page says try Load more', () => {
  const what = '"coffee"';
  assert.equal(emptyListMessage({ searchActive: true, acct: true, hasMore: true, loaded: 200, what }),
    'No transactions for this account in the first 200 matches for "coffee" — try Load more.');
  assert.equal(emptyListMessage({ searchActive: true, cat: 'Groceries', acct: true, hasMore: true, loaded: 200, what }),
    'No Groceries transactions for this account in the first 200 matches for "coffee" — try Load more.');
  // The category-only sentence is unchanged, word for word.
  assert.equal(emptyListMessage({ searchActive: true, cat: 'Groceries', hasMore: true, loaded: 200, what: 'the filters' }),
    'No Groceries transactions in the first 200 matches for the filters — try Load more.');
});

test('emptyListMessage: without more pages the plain sentences stand', () => {
  const what = '"coffee"';
  assert.equal(emptyListMessage({ searchActive: true, acct: true, hasMore: false, loaded: 12, what }),
    'No transactions match "coffee".');
  assert.equal(emptyListMessage({ searchActive: true, cat: 'Groceries', what }), 'No Groceries transactions match "coffee".');
  assert.equal(emptyListMessage({ searchActive: true, what }), 'No transactions match "coffee".');
  // No chip narrowing: hasMore can't hide anything the empty page would show.
  assert.equal(emptyListMessage({ searchActive: true, hasMore: true, loaded: 0, what }), 'No transactions match "coffee".');
});

test('emptyListMessage: month browse (search inactive) ignores hasMore', () => {
  assert.equal(emptyListMessage({ searchActive: false, cat: 'Groceries', acct: true, hasMore: true }),
    'No Groceries transactions for this account this month.');
  assert.equal(emptyListMessage({ searchActive: false, cat: 'Groceries' }), 'No Groceries transactions this month.');
  assert.equal(emptyListMessage({ searchActive: false, acct: true }), 'No transactions for this account this month.');
  assert.equal(emptyListMessage({ searchActive: false }), 'No transactions for this period.');
});

test('matchCountLabel marks a lower bound while more pages exist', () => {
  assert.equal(matchCountLabel(0, true), '0+ matches');
  assert.equal(matchCountLabel(12, true), '12+ matches');
  assert.equal(matchCountLabel(1, true), '1+ matches');
  assert.equal(matchCountLabel(1, false), '1 match');
  assert.equal(matchCountLabel(0, false), '0 matches');
  assert.equal(matchCountLabel(37), '37 matches');
});

test('the Spending list renders emptyListMessage and matchCountLabel', () => {
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dash, /return emptyListMessage\(\{searchActive,cat:txCatFilter\?getName\(txCatFilter\):null,acct:!!acctFilter,\s*hasMore:!!searchRes\?\.hasMore,loaded:searchTxs\.length,/);
  assert.match(dash, /matchCountLabel\(shownSearch\.length,!!searchRes\?\.hasMore\)/);
  assert.doesNotMatch(dash, /searchActive&&cn&&searchRes\?\.hasMore/, 'the category-only hasMore branch is back inline');
});

// --- resortByEffectiveDate: a date edit must move the row, not just its header -
// patchAllTxLists maps the never-refetched account page and search results in
// place, and groupByDay preserves order — so a row whose date moved used to
// stay put under its new header ("October 3 | September 29 | October 1").
test('resortByEffectiveDate moves an edited row into date order; groupByDay headers are monotone', () => {
  // Row b was Oct 1 and is now dated Sep 28 (patchTxShape rewrote transaction_date).
  const patched = [
    { id: 'a', transaction_date: '2026-10-03' },
    { id: 'b', transaction_date: '2026-09-28' },
    { id: 'c', transaction_date: '2026-09-29' },
  ];
  assert.deepEqual(groupByDay(patched).map(s => s.date), ['2026-10-03', '2026-09-28', '2026-09-29'],
    'the bug: order-preserving grouping of the patched list is out of order');
  const sorted = resortByEffectiveDate(patched);
  assert.deepEqual(sorted.map(r => r.id), ['a', 'c', 'b']);
  assert.deepEqual(groupByDay(sorted).map(s => s.date), ['2026-10-03', '2026-09-29', '2026-09-28']);
  // Moved FORWARD: an Oct 3 row sitting between Sep 29 and Oct 1 goes first.
  const fwd = resortByEffectiveDate([
    { id: 'x', transaction_date: '2026-10-01' },
    { id: 'y', transaction_date: '2026-10-03' },
    { id: 'z', transaction_date: '2026-09-29' },
  ]);
  assert.deepEqual(fwd.map(r => r.id), ['y', 'x', 'z']);
});

test('resortByEffectiveDate is stable: unmoved rows keep their exact order', () => {
  // Same-day rows in a non-id order (the account page has no id tiebreak,
  // the month list breaks ties by amount) must not be reshuffled.
  const rows = [
    { id: '1', transaction_date: '2026-10-02', amount: 5 },
    { id: '9', transaction_date: '2026-10-02', amount: 80 },
    { id: '3', transaction_date: '2026-10-02', amount: 12 },
    { id: '2', transaction_date: '2026-10-01' },
    { id: '7', date: '2026-09-30' },
  ];
  const out = resortByEffectiveDate(rows);
  assert.deepEqual(out.map(r => r.id), ['1', '9', '3', '2', '7'], 'already sorted by date → identical order');
  assert.notEqual(out, rows, 'returns a new array');
  assert.deepEqual(rows.map(r => r.id), ['1', '9', '3', '2', '7'], 'input not mutated');
  assert.deepEqual(resortByEffectiveDate(null), []);
});

test('patchAllTxLists re-sorts every list (and its rollback) on a user_date edit', () => {
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  const start = dash.indexOf('function patchAllTxLists(');
  assert.ok(start > 0, 'patchAllTxLists moved — update this test');
  const body = dash.slice(start, dash.indexOf('\n  }\n', start));
  assert.match(body, /const order=fields&&"user_date" in fields\?resortByEffectiveDate:list=>list;/);
  assert.match(body, /setAcctTxs\(prev=>prev\?order\(prev\.map\(apply\)\):prev\)/,
    'the account page is never refetched after an edit — it must be re-sorted');
  assert.match(body, /setSearchRes\(prev=>prev\?\{\.\.\.prev,transactions:order\(prev\.transactions\.map\(apply\)\)\}:prev\)/,
    'search results are never refetched after an edit — they must be re-sorted');
  assert.match(body, /setAcctTxs\(prev=>prev\?order\(prev\.map\(put\(before\.acct\)\)\):prev\)/, 'the rollback must re-sort too');
  assert.match(body, /transactions:order\(prev\.transactions\.map\(put\(before\.search\)\)\)/, 'the rollback must re-sort too');
});
