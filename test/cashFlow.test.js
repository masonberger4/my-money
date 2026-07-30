// Tests for the pure cash-flow model (src/cashFlow.js).
//
// CLAUDE.md records that markInternalTransfers' pairing was "verified maximum
// against brute force" — this file makes that verification runnable: random
// small instances are washed through markInternalTransfers (maxMatchTransfers
// is not exported; the public entry point exercises it) and the number of
// washed pairs is compared against an exhaustive brute-force maximum matching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markInternalTransfers, cashSpending, cashIncome } from '../src/cashFlow.js';

const WINDOW = 4; // must mirror INTERNAL_MATCH_WINDOW_DAYS (not exported)

const iso = dayOffset => new Date(Date.UTC(2026, 2, 1 + dayOffset)).toISOString().slice(0, 10);
const day = isoStr => {
  const [y, m, d] = isoStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

const CHK = { type: 'depository', subtype: 'checking' };
const SAV = { type: 'depository', subtype: 'savings' };
const CC = { type: 'credit', subtype: 'credit card' };

let seq = 0;
function out(amount, dayOffset, account_id = 'acc-chk', accounts = CHK) {
  return { plaid_tx_id: `o${seq++}`, account_id, accounts, date: iso(dayOffset), amount, raw_category: 'TRANSFER_OUT' };
}
function inn(amount, dayOffset, account_id = 'acc-sav', accounts = SAV) {
  return { plaid_tx_id: `i${seq++}`, account_id, accounts, date: iso(dayOffset), amount: -amount, raw_category: 'TRANSFER_IN' };
}

// --- markInternalTransfers semantics ----------------------------------------

test('equal-amount depository OUT/IN pair on different accounts within the window washes both legs', () => {
  const o = out(500, 0);
  const i = inn(500, 3);
  markInternalTransfers([o, i]);
  assert.equal(o._internal, true);
  assert.equal(i._internal, true);
});

test('a depository→credit pair is NOT washed (card payments must stay countable)', () => {
  const o = out(500, 0); // checking leg of a card payment
  const i = inn(500, 1, 'acc-cc', CC); // credit-card side
  markInternalTransfers([o, i]);
  assert.ok(!o._internal);
  assert.ok(!i._internal);
});

test('legs outside the window, or on the same account, do not pair', () => {
  const farOut = out(75, 0);
  const farIn = inn(75, WINDOW + 1);
  const sameOut = out(30, 10, 'acc-chk');
  const sameIn = inn(30, 10, 'acc-chk', CHK);
  markInternalTransfers([farOut, farIn, sameOut, sameIn]);
  for (const t of [farOut, farIn, sameOut, sameIn]) assert.ok(!t._internal);
});

test('straddle case: maximum matching washes all four legs where greedy nearest-partner strands a pair', () => {
  // From the maxMatchTransfers comment: outs on the 4th and 9th, ins on the 1st
  // and 6th. Greedy gives the day-4 out the nearer day-6 in (2 days), leaving
  // the day-9 out only the day-1 in, 8 days away — one real transfer stays
  // counted. The maximum matching pairs 4↔1 and 9↔6 (both 3 days).
  const o1 = out(200, 3); // the 4th
  const o2 = out(200, 8); // the 9th
  const i1 = inn(200, 0); // the 1st
  const i2 = inn(200, 5); // the 6th
  markInternalTransfers([i1, o1, i2, o2]);
  for (const t of [o1, o2, i1, i2]) assert.equal(t._internal, true);
});

// --- maxMatchTransfers ≡ brute-force maximum matching -----------------------

// Tiny seeded LCG so failures are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Exhaustive maximum matching over the same eligibility rules the real code
// applies: equal amount, different account, |date gap| ≤ window. Fine at n ≤ 8.
function bruteMax(outs, ins) {
  const adj = outs.map(o =>
    ins
      .map((r, j) => j)
      .filter(j => {
        const r = ins[j];
        if (o.amount.toFixed(2) !== (-r.amount).toFixed(2)) return false;
        if (r.account_id === o.account_id) return false;
        return Math.abs(day(r.date) - day(o.date)) <= WINDOW;
      })
  );
  const usedIn = new Array(ins.length).fill(false);
  const rec = i => {
    if (i === outs.length) return 0;
    let best = rec(i + 1); // leave this out unmatched
    for (const j of adj[i]) {
      if (usedIn[j]) continue;
      usedIn[j] = true;
      best = Math.max(best, 1 + rec(i + 1));
      usedIn[j] = false;
    }
    return best;
  };
  return rec(0);
}

test('random instances: washed-pair count equals brute-force maximum matching', () => {
  const rand = lcg(20260726);
  const randInt = n => Math.floor(rand() * n);
  const amounts = [5, 5, 12.5, 80];
  const accountIds = ['acc-a', 'acc-b', 'acc-c'];
  for (let trial = 0; trial < 200; trial++) {
    seq = 0;
    const outs = [];
    const ins = [];
    const nOuts = randInt(9);
    const nIns = randInt(9);
    for (let i = 0; i < nOuts; i++) {
      outs.push(out(amounts[randInt(amounts.length)], randInt(13), accountIds[randInt(3)]));
    }
    for (let j = 0; j < nIns; j++) {
      ins.push(inn(amounts[randInt(amounts.length)], randInt(13), accountIds[randInt(3)]));
    }
    const rows = [...outs, ...ins];
    for (let k = rows.length - 1; k > 0; k--) {
      const j = randInt(k + 1);
      [rows[k], rows[j]] = [rows[j], rows[k]];
    }
    markInternalTransfers(rows);
    const matchedOuts = outs.filter(t => t._internal).length;
    const matchedIns = ins.filter(t => t._internal).length;
    assert.equal(matchedOuts, matchedIns, `trial ${trial}: unbalanced washing`);
    assert.equal(matchedOuts, bruteMax(outs, ins), `trial ${trial}: not a maximum matching`);
  }
});

// --- cashSpending / cashIncome ----------------------------------------------

test('cashSpending counts checking outflows only; cashIncome counts depository inflows; _internal and excluded rows skip both', () => {
  const rows = [
    { accounts: CHK, amount: 50 }, // checking outflow → spending
    { accounts: { type: 'depository', subtype: null }, amount: 10 }, // lenient subtype → spending
    { accounts: SAV, amount: 200 }, // savings outflow → NOT spending
    { accounts: CC, amount: 30 }, // credit purchase → NOT spending
    { accounts: CHK, amount: -1000 }, // checking inflow → income
    { accounts: SAV, amount: -250 }, // savings inflow → income
    { accounts: CC, amount: -25 }, // credit refund → NOT income
    { accounts: CHK, amount: 75, _internal: true }, // washed transfer legs skip both
    { accounts: SAV, amount: -75, _internal: true },
    { accounts: CHK, amount: 40, excluded: true }, // user-excluded skips both
    { accounts: CHK, amount: -40, excluded: true },
  ];
  assert.equal(cashSpending(rows), 60);
  assert.equal(cashIncome(rows), 1250);
});
