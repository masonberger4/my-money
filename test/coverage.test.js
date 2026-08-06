import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCoverage,
  feedCoverageGaps,
  FEED_REACH_DAYS,
  FEED_GRACE_DAYS,
} from '../src/coverage.js';
import { MAX_LOOKBACK_DAYS } from '../api/_lib/simplefin.js';

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

// ---------------------------------------------------------------------------
// feedCoverageGaps — history the SimpleFIN feed can never fetch.
// ---------------------------------------------------------------------------

const DAY = 86400000;
const CREATED = '2026-05-01T12:00:00Z';
const day = n => new Date(Date.parse(CREATED) + n * DAY).toISOString().slice(0, 10);

test('LOCKSTEP: the reach the UI quotes is the reach the request is clamped to', () => {
  // A second hardcoded copy would let the sentence on the Accounts tab drift
  // away from the window api/sync.js actually asks for.
  assert.equal(MAX_LOOKBACK_DAYS, FEED_REACH_DAYS);
});

test('an account cut off at the feed wall is flagged with its served-from date', () => {
  const out = feedCoverageGaps([
    { account_id: 'a1', created_at: CREATED, first: day(-FEED_REACH_DAYS + 1) },
  ]);
  assert.deepEqual(out, [{ account_id: 'a1', served_from: day(-FEED_REACH_DAYS + 1) }]);
});

test('history reaching BEFORE the wall is not a shortfall — the backfill self-clears it', () => {
  // The whole invalidation story: one imported statement row dated before the
  // wall drops `first` below the lower bound and the notice disappears, with
  // no ack key and nothing to invalidate.
  assert.deepEqual(
    feedCoverageGaps([{ account_id: 'a1', created_at: CREATED, first: day(-FEED_REACH_DAYS - 1) }]),
    []
  );
});

test('a genuinely new account (first row well after we linked it) never nags', () => {
  assert.deepEqual(
    feedCoverageGaps([{ account_id: 'a1', created_at: CREATED, first: day(FEED_GRACE_DAYS + 1) }]),
    []
  );
  // …but inside the grace window it still counts as reachable history.
  assert.equal(
    feedCoverageGaps([{ account_id: 'a1', created_at: CREATED, first: day(FEED_GRACE_DAYS) }]).length,
    1
  );
});

test('boundaries are inclusive on both ends', () => {
  assert.equal(
    feedCoverageGaps([{ account_id: 'a1', created_at: CREATED, first: day(-FEED_REACH_DAYS) }]).length,
    1
  );
});

test('never assert a gap you cannot see: missing/garbage inputs are skipped', () => {
  assert.deepEqual(feedCoverageGaps(null), []);
  assert.deepEqual(feedCoverageGaps([]), []);
  assert.deepEqual(
    feedCoverageGaps([
      null,
      { created_at: CREATED, first: day(0) },                    // no account_id
      { account_id: 'a1', created_at: null, first: day(0) },     // pre-column / unknown
      { account_id: 'a2', created_at: CREATED, first: null },    // never synced
      { account_id: 'a3', created_at: 'nonsense', first: day(0) },
      { account_id: 'a4', created_at: CREATED, first: 'nonsense' },
    ]),
    []
  );
});

test('timestamps are accepted for `first` and truncated in the output', () => {
  const out = feedCoverageGaps([
    { account_id: 'a1', created_at: CREATED, first: '2026-04-20T08:30:00Z' },
  ]);
  assert.deepEqual(out, [{ account_id: 'a1', served_from: '2026-04-20' }]);
});

test('deterministic order: oldest served-from first, account id breaks ties', () => {
  const out = feedCoverageGaps([
    { account_id: 'b', created_at: CREATED, first: day(-10) },
    { account_id: 'a', created_at: CREATED, first: day(-10) },
    { account_id: 'c', created_at: CREATED, first: day(-40) },
  ]);
  assert.deepEqual(out.map(g => g.account_id), ['c', 'a', 'b']);
});
