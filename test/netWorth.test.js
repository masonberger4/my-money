// Net worth fold — hand-computed constants against src/netWorth.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { netWorthSeries } from '../src/netWorth.js';

const ACCTS = [
  { id: 'chk', type: 'depository' },
  { id: 'sav', type: 'depository' },
  { id: 'card', type: 'credit' },
  { id: 'loan', type: 'loan' },
];

test('empty inputs give an empty series', () => {
  assert.deepEqual(netWorthSeries([], ACCTS), []);
  assert.deepEqual(netWorthSeries(null, ACCTS), []);
  assert.deepEqual(netWorthSeries([{ account_id: 'chk', captured_on: '2026-08-01', balance: 5 }], []), []);
});

test('single account, assets stay positive', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 1000 },
      { account_id: 'chk', captured_on: '2026-08-03', balance: 1250.5 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 1000 },
    { date: '2026-08-03', total: 1250.5 },
  ]);
});

test('debts subtract via the displayBalance sign rule (credit AND loan)', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 2000 },
      { account_id: 'card', captured_on: '2026-08-01', balance: 500 }, // stored positive = owed
      { account_id: 'loan', captured_on: '2026-08-01', balance: 3000 },
    ],
    ACCTS,
  );
  // 2000 − 500 − 3000
  assert.deepEqual(out, [{ date: '2026-08-01', total: -1500 }]);
});

test('carry-forward: an account that did not move keeps its last value', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 1000 },
      { account_id: 'card', captured_on: '2026-08-01', balance: 400 },
      // 08-02: only the card reported — checking must carry forward, not drop to 0
      { account_id: 'card', captured_on: '2026-08-02', balance: 300 },
      // 08-04: only checking reported — card carries at 300
      { account_id: 'chk', captured_on: '2026-08-04', balance: 1100 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 600 },  // 1000 − 400
    { date: '2026-08-02', total: 700 },  // 1000 − 300
    { date: '2026-08-04', total: 800 },  // 1100 − 300
  ]);
});

test('an account with no snapshot yet contributes 0 until its first one', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 500 },
      { account_id: 'sav', captured_on: '2026-08-03', balance: 250 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 500 },  // sav not yet seen → 0, not dropped
    { date: '2026-08-03', total: 750 },
  ]);
});

test('snapshots for accounts NOT in the list (hidden) are ignored entirely', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: 100 },
      { account_id: 'ghost', captured_on: '2026-08-01', balance: 9999 },
      { account_id: 'ghost', captured_on: '2026-08-02', balance: 9999 },
    ],
    ACCTS,
  );
  // The ghost's rows must not even mint a 08-02 point.
  assert.deepEqual(out, [{ date: '2026-08-01', total: 100 }]);
});

test('one point per date, and unsorted input is sorted by date', () => {
  const out = netWorthSeries(
    [
      { account_id: 'card', captured_on: '2026-08-02', balance: 50 },
      { account_id: 'chk', captured_on: '2026-08-01', balance: 300 },
      { account_id: 'sav', captured_on: '2026-08-02', balance: 20 },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [
    { date: '2026-08-01', total: 300 },
    { date: '2026-08-02', total: 270 }, // 300 + 20 − 50, single merged point
  ]);
});

test('numeric-string balances (PostgREST) coerce like displayBalance does', () => {
  const out = netWorthSeries(
    [
      { account_id: 'chk', captured_on: '2026-08-01', balance: '100.25' },
      { account_id: 'card', captured_on: '2026-08-01', balance: '40.25' },
    ],
    ACCTS,
  );
  assert.deepEqual(out, [{ date: '2026-08-01', total: 60 }]);
});
