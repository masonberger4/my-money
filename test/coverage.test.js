import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCoverage } from '../src/coverage.js';

test('empty input returns an empty object', () => {
  assert.deepEqual(aggregateCoverage([]), {});
  assert.deepEqual(aggregateCoverage(null), {});
});

test('single account, single source', () => {
  const out = aggregateCoverage([
    { account_id: 'a1', date: '2026-01-05', source: 'simplefin' },
    { account_id: 'a1', date: '2026-01-07', source: 'simplefin' },
  ]);
  assert.deepEqual(out, {
    a1: { first: '2026-01-05', last: '2026-01-07', count: 2, sources: { simplefin: 2 } },
  });
});

test('multi-account, multi-source; missing source counts as unknown', () => {
  const out = aggregateCoverage([
    { account_id: 'a1', date: '2026-01-05', source: 'simplefin' },
    { account_id: 'a1', date: '2026-02-01', source: 'csv' },
    { account_id: 'a2', date: '2025-12-31', source: 'pdf' },
    { account_id: 'a2', date: '2026-01-01', source: null },
    { account_id: 'a2', date: '2026-01-02', source: 'manual' },
  ]);
  assert.deepEqual(out.a1.sources, { simplefin: 1, csv: 1 });
  assert.deepEqual(out.a2.sources, { pdf: 1, unknown: 1, manual: 1 });
  assert.equal(out.a1.count, 2);
  assert.equal(out.a2.count, 3);
});

test('date ordering with unsorted input; null dates count but never set first/last', () => {
  const out = aggregateCoverage([
    { account_id: 'a1', date: '2026-03-15', source: 'csv' },
    { account_id: 'a1', date: null, source: 'csv' },
    { account_id: 'a1', date: '2025-11-02', source: 'csv' },
    { account_id: 'a1', date: '2026-01-20', source: 'csv' },
  ]);
  assert.equal(out.a1.first, '2025-11-02');
  assert.equal(out.a1.last, '2026-03-15');
  assert.equal(out.a1.count, 4);
});

test('timestamp dates are truncated to YYYY-MM-DD', () => {
  const out = aggregateCoverage([
    { account_id: 'a1', date: '2026-01-05T10:00:00Z', source: 'simplefin' },
  ]);
  assert.equal(out.a1.first, '2026-01-05');
  assert.equal(out.a1.last, '2026-01-05');
});
