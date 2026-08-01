import test from 'node:test';
import assert from 'node:assert/strict';
import { createRangeMemo } from '../src/monthMemo.js';
import { markInternalTransfers } from '../src/cashFlow.js';
import { applyAccountRules } from '../src/categoryMap.js';

// A tiny fake fetch layer that counts calls and serves date-filtered rows,
// like the real PostgREST range query would.
function makeFetch(rows) {
  const calls = [];
  const fetchRange = async (start, end) => {
    calls.push(`${start}|${end}`);
    // Simulate network: resolve on a later microtask/macrotask.
    await new Promise(r => setTimeout(r, 0));
    return rows.filter(t => t.date >= start && t.date <= end);
  };
  return { calls, fetchRange };
}

const LEDGER = [
  { id: 5, date: '2026-08-02', amount: 40, mapped_category: 'Groceries', raw_category: null, accounts: { type: 'depository', subtype: 'checking' } },
  { id: 4, date: '2026-08-01', amount: -40, mapped_category: 'Groceries', raw_category: null, accounts: { type: 'credit', subtype: null } },
  { id: 3, date: '2026-07-15', amount: 12, mapped_category: 'Eating out', raw_category: null, accounts: { type: 'depository', subtype: 'checking' } },
  { id: 2, date: '2026-06-03', amount: 500, mapped_category: 'Transfers and card payments', raw_category: 'TRANSFER_OUT', accounts: { type: 'depository', subtype: 'checking' } },
  { id: 1, date: '2026-06-04', amount: -500, mapped_category: 'Transfers and card payments', raw_category: 'TRANSFER_IN', account_id: 'b', accounts: { type: 'depository', subtype: 'savings' } },
];

test('two parallel callers over the same range share one fetch', async () => {
  const { calls, fetchRange } = makeFetch(LEDGER);
  const memo = createRangeMemo(fetchRange);
  const [a, b] = await Promise.all([
    memo.getCopy('2026-08-01', '2026-08-31'),
    memo.getCopy('2026-08-01', '2026-08-31'),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  assert.notEqual(a[0], b[0], 'rows must be distinct copies, not shared objects');
});

test('a contained range is sliced from the superset fetch (either call order)', async () => {
  for (const order of ['subset-first', 'superset-first']) {
    const { calls, fetchRange } = makeFetch(LEDGER);
    const memo = createRangeMemo(fetchRange);
    const reqs =
      order === 'subset-first'
        ? [memo.getCopy('2026-08-01', '2026-08-31'), memo.getCopy('2026-06-01', '2026-08-31')]
        : [memo.getCopy('2026-06-01', '2026-08-31'), memo.getCopy('2026-08-01', '2026-08-31')];
    const results = await Promise.all(reqs);
    assert.equal(calls.length, 1, order);
    assert.deepEqual(calls, ['2026-06-01|2026-08-31'], order);
    const aug = order === 'subset-first' ? results[0] : results[1];
    assert.deepEqual(aug.map(t => t.id), [5, 4], order);
  }
});

test('disjoint / non-contained ranges fetch separately', async () => {
  const { calls, fetchRange } = makeFetch(LEDGER);
  const memo = createRangeMemo(fetchRange);
  await Promise.all([
    memo.getCopy('2026-07-01', '2026-07-31'),
    memo.getCopy('2026-06-01', '2026-06-30'),
  ]);
  assert.equal(calls.length, 2);
});

test('clear() (the reload gen bump) forces a refetch', async () => {
  const { calls, fetchRange } = makeFetch(LEDGER);
  const memo = createRangeMemo(fetchRange);
  await memo.getCopy('2026-08-01', '2026-08-31');
  await memo.getCopy('2026-08-01', '2026-08-31');
  assert.equal(calls.length, 1);
  memo.clear();
  await memo.getCopy('2026-08-01', '2026-08-31');
  assert.equal(calls.length, 2);
});

test('sequential callers after resolution still share the fetch', async () => {
  const { calls, fetchRange } = makeFetch(LEDGER);
  const memo = createRangeMemo(fetchRange);
  const a = await memo.getCopy('2026-06-01', '2026-08-31');
  const b = await memo.getCopy('2026-08-01', '2026-08-31'); // sliced, post-resolve
  assert.equal(calls.length, 1);
  assert.notEqual(a.find(t => t.id === 5), b.find(t => t.id === 5), 'distinct copies');
});

// MUTATION-ALIASING REGRESSION — the exact bug the backlog caution warns
// about: getCashFlow marks transfers on ITS copy; a later purchase-model
// caller over the same memoized range must see pristine rows.
test('REGRESSION: cash-flow transfer marks never leak into another caller\'s copy', async () => {
  const { fetchRange } = makeFetch(LEDGER);
  const memo = createRangeMemo(fetchRange);

  // Simulate getCashFlow's pipeline on its own copy.
  const cfRows = await memo.getCopy('2026-06-01', '2026-08-31');
  for (const t of cfRows) {
    t.mapped_category = applyAccountRules(t.mapped_category, t.amount, t.accounts?.type);
  }
  markInternalTransfers(cfRows);
  assert.ok(cfRows.some(t => t._internal), 'sanity: the transfer pair was marked');
  const cfReturn = cfRows.find(t => t.id === 4);
  assert.equal(cfReturn.mapped_category, 'Return', 'sanity: account rules applied');

  // A purchase-model caller over the same range gets un-marked, un-rewritten rows.
  const spRows = await memo.getCopy('2026-06-01', '2026-08-31');
  assert.ok(spRows.every(t => !('_internal' in t)), 'no _internal on a fresh copy');
  assert.equal(spRows.find(t => t.id === 4).mapped_category, 'Groceries', 'no mapped_category rewrite either');
});

// REJECTION EVICTION — a failed shared fetch must not poison the memo until
// the next reload: the entry is evicted on rejection, so a later caller
// retries and succeeds. (Found in review: without eviction, one transient
// network error made every lazy-tab read of that range fail until the next
// full reload cleared the map.)
test('a rejected fetch is evicted — the next caller retries instead of inheriting the failure', async () => {
  let calls = 0;
  const memo = createRangeMemo(async () => {
    calls++;
    if (calls === 1) throw new Error('transient');
    return [{ id: 1, date: '2026-07-05', amount: 10 }];
  });
  await assert.rejects(memo.getCopy('2026-07-01', '2026-07-31'), /transient/);
  const rows = await memo.getCopy('2026-07-01', '2026-07-31');
  assert.equal(calls, 2);
  assert.equal(rows.length, 1);
});

test('parallel joiners of a failing fetch all see the rejection; a caller sliced from it too', async () => {
  let calls = 0;
  const memo = createRangeMemo(async () => {
    calls++;
    throw new Error('down');
  });
  const wide = memo.getCopy('2026-02-01', '2026-07-31');
  const narrow = memo.getCopy('2026-07-01', '2026-07-31'); // contained → joins wide
  await assert.rejects(wide, /down/);
  await assert.rejects(narrow, /down/);
  assert.equal(calls, 1, 'the contained range joined the doomed fetch, not a second one');
  // Both entries evicted (the sliced one rejects via its superset and evicts itself).
  await assert.rejects(memo.getCopy('2026-07-01', '2026-07-31'), /down/); // retries: a new fetch
  assert.equal(calls, 2);
});
