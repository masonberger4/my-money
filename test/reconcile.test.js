// Tests for the comparison-audit core in src/csvImport.js — reconcileCsv,
// descSimilarity, csvDateRange. Every "audit" and "both" statement import
// renders their output; until now the matching logic (its own Kuhn's
// max-matching plus a second amount-mismatch pass) had no coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCsv, descSimilarity, csvDateRange } from '../src/csvImport.js';
import { lcg } from './helpers/pdfFixtures.js';

// Row builders. csv rows carry the built-row shape (amount positive = out);
// feed rows carry the synced-row shape reconcileCsv documents. Ids make the
// deterministic sort total so order-invariance can compare whole results.
const C = (id, date, amount, desc, cat = 'Groceries') => ({
  plaid_tx_id: `csvrow:${id}`,
  date,
  amount,
  description: desc,
  mapped_category: cat,
});
const P = (id, date, amount, desc, extra = {}) => ({
  plaid_tx_id: `sfin:${id}`,
  date,
  amount,
  description: desc,
  merchant_name: '',
  mapped_category: 'Groceries',
  user_category: null,
  pending: false,
  ...extra,
});

// --- descSimilarity ----------------------------------------------------------

test('descSimilarity: Jaccard over meaningful tokens', () => {
  assert.equal(descSimilarity('ACME BISTRO DOWNTOWN', 'ACME BISTRO DOWNTOWN'), 1);
  // {ACME, BISTRO, DOWNTOWN} vs {ACME, BISTRO} → 2/3
  assert.ok(Math.abs(descSimilarity('ACME BISTRO DOWNTOWN', 'ACME BISTRO') - 2 / 3) < 1e-9);
  assert.equal(descSimilarity('ACME BISTRO', 'NORTH HARDWARE'), 0);
});

test('descSimilarity: stopwords, pure-numeric and short tokens carry no signal', () => {
  // Generic bank filler must not make two unrelated rows look "similar" —
  // that would let the amount-mismatch pass hide a real sync gap.
  assert.equal(descSimilarity('POS PURCHASE DEBIT CARD', 'POS PURCHASE'), 0);
  assert.equal(descSimilarity('12345 99', '12345'), 0, 'store/ref numbers are noise');
  assert.equal(descSimilarity('AB CD', 'AB CD'), 0, 'sub-3-char tokens are dropped');
  assert.equal(descSimilarity('', 'ACME'), 0);
});

// --- csvDateRange ------------------------------------------------------------

test('csvDateRange: min/max across rows, missing dates skipped', () => {
  assert.deepEqual(
    csvDateRange([{ date: '2026-03-05' }, { date: null }, { date: '2026-02-01' }, { date: '' }]),
    { min: '2026-02-01', max: '2026-03-05' }
  );
  assert.deepEqual(csvDateRange([]), { min: null, max: null });
  assert.deepEqual(csvDateRange([{ date: null }]), { min: null, max: null });
});

// --- reconcileCsv buckets ----------------------------------------------------

test('exact match: same amount, same date → matched with no flags', () => {
  const r = reconcileCsv(
    [C(1, '2026-03-05', 45, 'RIVER GROCERY 12')],
    [P(1, '2026-03-05', 45, 'RIVER GROCERY #12')]
  );
  assert.equal(r.counts.matched, 1);
  assert.equal(r.matched[0].dateGapDays, 0);
  assert.equal(r.matched[0].dateMismatch, false);
  assert.equal(r.matched[0].categoryMismatch, false);
});

test('date drift inside the ±4-day window still matches, flagged; outside it does not', () => {
  const inside = reconcileCsv(
    [C(1, '2026-03-05', 45, 'RIVER GROCERY')],
    [P(1, '2026-03-08', 45, 'RIVER GROCERY')]
  );
  assert.equal(inside.counts.matched, 1);
  assert.equal(inside.matched[0].dateGapDays, 3);
  assert.equal(inside.matched[0].dateMismatch, true);

  const outside = reconcileCsv(
    [C(1, '2026-03-05', 45, 'RIVER GROCERY')],
    [P(1, '2026-03-10', 45, 'RIVER GROCERY')]
  );
  assert.equal(outside.counts.matched, 0);
  assert.equal(outside.counts.csvOnly, 1);
  assert.equal(outside.counts.plaidOnly, 1);
});

test('categoryMismatch compares against the EFFECTIVE category — user_category wins', () => {
  // Feed row auto-categorized Dining out but corrected to Groceries by the
  // user: the CSV's Groceries must NOT read as a mismatch.
  const corrected = reconcileCsv(
    [C(1, '2026-03-05', 45, 'RIVER GROCERY', 'Groceries')],
    [P(1, '2026-03-05', 45, 'RIVER GROCERY', { mapped_category: 'Dining out', user_category: 'Groceries' })]
  );
  assert.equal(corrected.matched[0].categoryMismatch, false);

  // …and an override AWAY from the CSV's category is a mismatch even though
  // the mapped categories agree.
  const overridden = reconcileCsv(
    [C(1, '2026-03-05', 45, 'RIVER GROCERY', 'Groceries')],
    [P(1, '2026-03-05', 45, 'RIVER GROCERY', { mapped_category: 'Groceries', user_category: 'Dining out' })]
  );
  assert.equal(overridden.matched[0].categoryMismatch, true);
});

test('amount mismatch pairs leftovers only when descriptions are clearly the same merchant', () => {
  // Close amounts + similar descriptions → surfaced as an amount discrepancy.
  const paired = reconcileCsv(
    [C(1, '2026-03-05', 52.75, 'ACME BISTRO DOWNTOWN')],
    [P(1, '2026-03-05', 45, 'ACME BISTRO')]
  );
  assert.equal(paired.counts.amountMismatches, 1);
  assert.equal(paired.amountMismatches[0].amountDiff, 7.75);
  assert.equal(paired.counts.csvOnly, 0);

  // Dissimilar descriptions → both stay real discrepancies.
  const dissimilar = reconcileCsv(
    [C(1, '2026-03-05', 52.75, 'ACME BISTRO DOWNTOWN')],
    [P(1, '2026-03-05', 45, 'NORTH HARDWARE SUPPLY')]
  );
  assert.equal(dissimilar.counts.amountMismatches, 0);
  assert.equal(dissimilar.counts.csvOnly, 1);
  assert.equal(dissimilar.counts.plaidOnly, 1);
});

test('a LARGE amount gap at the same merchant is two purchases, not a mismatch pair', () => {
  // 200 vs 45: > $15 apart and > 30% — pairing them would swallow a real
  // sync gap.
  const r = reconcileCsv(
    [C(1, '2026-03-05', 200, 'ACME BISTRO DOWNTOWN')],
    [P(1, '2026-03-05', 45, 'ACME BISTRO DOWNTOWN')]
  );
  assert.equal(r.counts.amountMismatches, 0);
  assert.equal(r.counts.csvOnly, 1);
  assert.equal(r.counts.plaidOnly, 1);
});

test('csvOnly and plaidOnly leftovers survive as sync-gap / timing rows', () => {
  const r = reconcileCsv(
    [
      C(1, '2026-03-05', 45, 'RIVER GROCERY'),
      C(2, '2026-03-12', 9.5, 'MISSED BY THE FEED'),
    ],
    [
      P(1, '2026-03-05', 45, 'RIVER GROCERY'),
      P(2, '2026-03-20', 60, 'PENDING NOT EXPORTED'),
    ]
  );
  assert.equal(r.counts.matched, 1);
  assert.deepEqual(r.csvOnly.map(x => x.description), ['MISSED BY THE FEED']);
  assert.deepEqual(r.plaidOnly.map(x => x.description), ['PENDING NOT EXPORTED']);
});

// --- counts conservation -----------------------------------------------------

test('counts conservation: every row lands in exactly one bucket', () => {
  const csv = [
    C(1, '2026-03-01', 45, 'RIVER GROCERY'),
    C(2, '2026-03-02', 45, 'RIVER GROCERY'),
    C(3, '2026-03-05', 52.75, 'ACME BISTRO DOWNTOWN'),
    C(4, '2026-03-09', 12, 'NOWHERE ELSE'),
  ];
  const feed = [
    P(1, '2026-03-01', 45, 'RIVER GROCERY'),
    P(2, '2026-03-05', 45, 'ACME BISTRO'),
    P(3, '2026-03-20', 33, 'FEED ONLY ROW'),
  ];
  const r = reconcileCsv(csv, feed);
  assert.equal(r.counts.matched + r.counts.amountMismatches + r.counts.csvOnly, r.counts.csvTotal);
  assert.equal(r.counts.matched + r.counts.amountMismatches + r.counts.plaidOnly, r.counts.plaidTotal);
  assert.equal(r.counts.csvTotal, csv.length);
  assert.equal(r.counts.plaidTotal, feed.length);
});

// --- input-order invariance --------------------------------------------------

test('reconcile is input-order invariant — the pre-matching sort exists for exactly this', () => {
  // Includes a count-imbalanced equal-amount cluster, where only some rows can
  // match and an order-dependent implementation would pick different ones.
  const csv = [
    C(1, '2026-03-01', 25, 'ACME COFFEE'),
    C(2, '2026-03-03', 25, 'ACME COFFEE'),
    C(3, '2026-03-05', 25, 'ACME COFFEE'),
    C(4, '2026-03-08', 60, 'NORTH HARDWARE'),
    C(5, '2026-03-11', 52.75, 'ACME BISTRO DOWNTOWN'),
  ];
  const feed = [
    P(1, '2026-03-02', 25, 'ACME COFFEE'),
    P(2, '2026-03-06', 25, 'ACME COFFEE'),
    P(3, '2026-03-08', 60, 'NORTH HARDWARE'),
    P(4, '2026-03-11', 45, 'ACME BISTRO'),
  ];
  const baseline = reconcileCsv(csv, feed);

  const rand = lcg(20260731);
  const shuffle = arr => {
    const a = [...arr];
    for (let k = a.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    return a;
  };
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(reconcileCsv(shuffle(csv), shuffle(feed)), baseline, `shuffle ${i}`);
  }
});

// --- brute-force max-matching parity (seeded), mirroring test/cashFlow.test.js

const WINDOW = 4; // must mirror RECONCILE_WINDOW_DAYS (not exported)

const iso = dayOffset => `2026-03-${String(1 + dayOffset).padStart(2, '0')}`;
const dayNum = d => Number(d.slice(8, 10));

// Exhaustive maximum matching over reconcile's first-pass eligibility:
// exact amount + |date gap| ≤ window. Fine at n ≤ 7.
function bruteMax(csv, feed) {
  const adj = csv.map(c =>
    feed
      .map((_, j) => j)
      .filter(j => {
        const p = feed[j];
        if (Number(c.amount).toFixed(2) !== Number(p.amount).toFixed(2)) return false;
        return Math.abs(dayNum(c.date) - dayNum(p.date)) <= WINDOW;
      })
  );
  const used = new Array(feed.length).fill(false);
  const rec = i => {
    if (i === csv.length) return 0;
    let best = rec(i + 1);
    for (const j of adj[i]) {
      if (used[j]) continue;
      used[j] = true;
      best = Math.max(best, 1 + rec(i + 1));
      used[j] = false;
    }
    return best;
  };
  return rec(0);
}

test('random instances: matched count equals brute-force maximum matching', () => {
  const rand = lcg(20260801);
  const randInt = n => Math.floor(rand() * n);
  const amounts = [5, 5, 12.5, 80];
  const descs = ['ACME COFFEE', 'RIVER GROCERY', 'NORTH GYM'];
  for (let trial = 0; trial < 150; trial++) {
    const csv = [];
    const feed = [];
    const nCsv = randInt(8);
    const nFeed = randInt(8);
    for (let i = 0; i < nCsv; i++) {
      csv.push(C(`t${trial}c${i}`, iso(randInt(13)), amounts[randInt(amounts.length)], descs[randInt(3)]));
    }
    for (let j = 0; j < nFeed; j++) {
      feed.push(P(`t${trial}p${j}`, iso(randInt(13)), amounts[randInt(amounts.length)], descs[randInt(3)]));
    }
    const r = reconcileCsv(csv, feed);
    assert.equal(r.counts.matched, bruteMax(csv, feed), `trial ${trial}: not a maximum matching`);
  }
});
