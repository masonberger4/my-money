// The ledger-vs-balance reconciliation core (src/reconciliation.js).
//
// What these guard, in order of how much they matter:
//   1. THE IDENTITY. deltaLedger === net + Σ bucketImpacts is what makes the
//      panel's "Unexplained" line mean something. If a future Z class stops
//      being classified, or a predicate's precedence moves, the identity breaks
//      and every residual on screen becomes noise — silently. Property-tested
//      over random ledgers rather than examples, because the failure is a
//      MISSING case and an example suite can only pin the cases it thought of.
//   2. isSpend/isIncome DISJOINTNESS. The identity's derivation assumes it and
//      nothing anywhere asserted it until now — one instance was pinned in
//      test/cashFlow.test.js, never the property.
//   3. null-vs-0 on balances. balancesAsOf must return null when an account has
//      no snapshot yet: a silent 0 there manufactures a residual that reads as
//      exactly the over-counting this panel exists to detect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markInternalTransfers, isIncome } from '../src/cashFlow.js';
import { isSpend } from '../src/spending.js';
import {
  buildReconciliation,
  balancesAsOf,
  classifyUncounted,
  classifyFlow,
  nearMissTransfers,
  monthEdges,
  reconciliationScope,
  BUCKET_ORDER,
  FLOW_ORDER,
  RECON_SCOPE_TYPES,
  NEAR_MISS_MIN_AMOUNT,
} from '../src/reconciliation.js';
import { standardLedger, randomLedger, makeTx, makeAccounts, lcg } from './helpers/ledger.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
// The scope set for the standard fixture: every non-hidden depository/credit
// account. The mortgage is out (loan), the hidden card is out (query level).
const scopeOf = A => reconciliationScope(Object.values(A).filter(a => !a.hidden));
const snap = (account_id, captured_on, balance) => ({ account_id, captured_on, balance });

// ---------------------------------------------------------------- month edges

test('month edges are read off the date STRING, never parsed as UTC', () => {
  assert.deepEqual(monthEdges('2026-09'), {
    start: '2026-09-01',
    end: '2026-09-30',
    prevEnd: '2026-08-31',
  });
  // January's previous month crosses the year.
  assert.deepEqual(monthEdges('2026-01').prevEnd, '2025-12-31');
  // Leap year, and the month before a 29-day February.
  assert.equal(monthEdges('2028-02').end, '2028-02-29');
  assert.equal(monthEdges('2028-03').prevEnd, '2028-02-29');
  for (const junk of [null, undefined, '', '2026', '2026-13', 'nonsense', 42]) {
    assert.equal(monthEdges(junk), null);
  }
});

// --------------------------------------------------------------- balancesAsOf

test('balancesAsOf carries the last snapshot forward across a gap', () => {
  const accounts = [{ id: 'a', type: 'depository' }, { id: 'b', type: 'credit' }];
  const snaps = [
    snap('a', '2026-09-03', 1000),
    snap('a', '2026-09-20', 1200),
    snap('b', '2026-09-05', 400), // stored positive = owed
  ];
  // Sept 30: a carries 1200, b carries 400 owed => 1200 - 400.
  assert.equal(balancesAsOf(snaps, accounts, '2026-09-30').total, 800);
  // Sept 10: a's later snapshot is not yet visible.
  assert.equal(balancesAsOf(snaps, accounts, '2026-09-10').total, 600);
  // Exact-date snapshots are included (on-or-BEFORE).
  assert.equal(balancesAsOf(snaps, accounts, '2026-09-05').total, 600);
});

test('an account with no snapshot yet makes the total null, not zero', () => {
  const accounts = [{ id: 'a', type: 'depository' }, { id: 'b', type: 'credit' }];
  const snaps = [snap('a', '2026-09-03', 1000)];
  const r = balancesAsOf(snaps, accounts, '2026-09-30');
  assert.equal(r.total, null, 'a silent 0 here would fake a residual');
  assert.deepEqual(r.missing, ['b']);
  // Before ANY snapshot exists, every account is missing.
  assert.equal(balancesAsOf(snaps, accounts, '2026-09-01').total, null);
  // No accounts at all: nothing to claim.
  assert.equal(balancesAsOf(snaps, [], '2026-09-30').total, null);
});

test('balancesAsOf ignores snapshots for accounts outside the set, and never returns -0', () => {
  const accounts = [{ id: 'a', type: 'credit' }];
  const snaps = [snap('a', '2026-09-03', 0), snap('zzz', '2026-09-04', 9999)];
  const r = balancesAsOf(snaps, accounts, '2026-09-30');
  assert.equal(r.total, 0);
  assert.ok(!Object.is(r.total, -0), 'a paid-off card must not render as -$0.00');
});

test('balancesAsOf degrades on garbage instead of throwing', () => {
  const accounts = [{ id: 'a', type: 'depository' }];
  assert.equal(balancesAsOf(null, accounts, '2026-09-30').total, null);
  assert.equal(balancesAsOf([null, {}, { account_id: 'a' }], accounts, '2026-09-30').total, null);
  assert.equal(balancesAsOf([snap('a', '2026-09-01', 5)], accounts, null).total, null);
  assert.equal(balancesAsOf(undefined, undefined, undefined).total, null);
});

// ------------------------------------------------------- the standard fixture

// The fixture's July, with hand-built snapshots at both month edges for the
// five in-scope accounts. Balances are chosen so the observed change equals the
// ledger's own movement exactly — any residual here is the code's fault.
function julyFixture({ drift = 0 } = {}) {
  const led = standardLedger();
  const rows = led.visibleRows();
  markInternalTransfers(rows);
  const scope = scopeOf(led.accounts);
  // -Σ amount per in-scope account is that account's displayed movement.
  const move = new Map(scope.map(a => [a.id, 0]));
  for (const t of rows) if (move.has(t.account_id)) move.set(t.account_id, move.get(t.account_id) - t.amount);
  const snaps = [];
  for (const a of scope) {
    const startStored = 1000;
    // Displayed movement -> stored movement: debts store the opposite sign.
    const storedDelta = a.type === 'credit' ? -move.get(a.id) : move.get(a.id);
    snaps.push(snap(a.id, '2026-06-30', startStored));
    snaps.push(snap(a.id, '2026-07-31', startStored + storedDelta));
  }
  if (drift) {
    // Nudge one depository account's END balance: money that moved with no row
    // behind it, which is exactly what "Unexplained" is supposed to catch.
    const i = snaps.findIndex(s => s.account_id === led.accounts.checking.id && s.captured_on === '2026-07-31');
    snaps[i] = { ...snaps[i], balance: snaps[i].balance + drift };
  }
  return { led, rows, scope, snaps };
}

test('the standard ledger reconciles to the penny, with every bucket named', () => {
  const { led, rows, scope, snaps } = julyFixture();
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: snaps,
    accounts: Object.values(led.accounts).filter(a => !a.hidden),
    today: '2026-08-28',
  });
  const m = months[0];
  // The headline pair is the shared model's, unchanged.
  assert.equal(m.income, 2501.25);
  assert.equal(m.spending, 729.0);
  assert.equal(m.net, 2501.25 - 729.0);
  // Balances were built from the rows, so nothing is left over.
  assert.ok(near(m.unexplained, 0), `unexplained ${m.unexplained}`);
  assert.ok(near(m.deltaObserved, m.deltaLedger));

  const by = Object.fromEntries(m.buckets.map(b => [b.key, b]));
  // chk5 -> sav1, the structural wash: both legs present, so it nets to zero.
  assert.ok(near(by.transfer.impact, 0));
  assert.equal(by.transfer.count, 2);
  // chk4 -> c1b, the card payment: also both legs, also nets.
  assert.ok(near(by.cardPayment.impact, 0));
  assert.equal(by.cardPayment.count, 2);
  // chk6, excluded by hand: real money out, in neither total.
  assert.equal(by.excluded.count, 1);
  assert.ok(near(by.excluded.impact, -40));
  assert.ok(near(by.excluded.moneyOut, 40));
  // The mortgage is out of scope on BOTH sides, so it needs no bucket at all.
  assert.equal(by.outOfScope, undefined);
  assert.equal(by.other, undefined, 'nothing should land in the catch-all here');
});

test('money that moved with no row behind it lands in Unexplained, exactly', () => {
  const { led, rows, snaps } = julyFixture({ drift: -12.34 });
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: snaps,
    accounts: Object.values(led.accounts).filter(a => !a.hidden),
    today: '2026-08-28',
  });
  assert.ok(near(months[0].unexplained, -12.34), `got ${months[0].unexplained}`);
});

test('no balance history for a month reports null rather than guessing zero', () => {
  const { led, rows } = julyFixture();
  const { months, coverage } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: [],
    accounts: Object.values(led.accounts).filter(a => !a.hidden),
    today: '2026-08-28',
  });
  assert.equal(months[0].deltaObserved, null);
  assert.equal(months[0].unexplained, null);
  assert.equal(coverage.earliestSnapshot, null);
  // The rows half still renders — the decomposition does not need balances.
  assert.equal(months[0].income, 2501.25);
  assert.ok(months[0].buckets.length > 0);
});

// ------------------------------------------------------------- the properties

// user_type is absent from the shared fixture, so sprinkle it deterministically
// BEFORE pairing (overridden rows never enter the pool — that ordering is the
// point). This is what exercises the one-sided-override class, the sharpest
// divergence source the buckets have to name.
function sprinkleTypes(rows, seed) {
  const rand = lcg(seed);
  const pool = ['spending', 'inflow', 'transfer', 'card_payment'];
  for (const t of rows) {
    if (rand() < 0.12) t.user_type = pool[Math.floor(rand() * pool.length)];
  }
  return rows;
}

for (const seed of [1, 7, 42, 1234, 98765]) {
  test(`identity holds on random ledger seed ${seed}: deltaLedger === net + Σ impacts`, () => {
    const led = randomLedger(seed);
    const rows = sprinkleTypes(led.visibleRows(), seed);
    markInternalTransfers(rows);
    const { months } = buildReconciliation({
      monthsRows: [{ month: '2026-07', rows }],
      snapshots: [],
      accounts: Object.values(led.accounts).filter(a => !a.hidden),
      today: '2026-08-28',
    });
    const m = months[0];
    const sum = m.buckets.reduce((a, b) => a + b.impact, 0);
    assert.ok(
      near(m.deltaLedger, m.net + sum),
      `deltaLedger ${m.deltaLedger} !== net ${m.net} + impacts ${sum}`
    );
  });

  test(`bucket conservation on seed ${seed}: impacts account for every uncounted dollar`, () => {
    const led = randomLedger(seed);
    const rows = sprinkleTypes(led.visibleRows(), seed);
    markInternalTransfers(rows);
    const scopeIds = new Set(scopeOf(led.accounts).map(a => a.id));
    let expected = 0;
    for (const t of rows) {
      const amount = Number(t.amount);
      if (!Number.isFinite(amount) || !amount) continue;
      const inScope = scopeIds.has(t.account_id);
      const counted = isSpend(t) || isIncome(t);
      if (inScope && !counted) expected -= amount;
      else if (!inScope && counted) expected += amount;
    }
    const { months } = buildReconciliation({
      monthsRows: [{ month: '2026-07', rows }],
      snapshots: [],
      accounts: Object.values(led.accounts).filter(a => !a.hidden),
      today: '2026-08-28',
    });
    const sum = months[0].buckets.reduce((a, b) => a + b.impact, 0);
    assert.ok(near(sum, expected), `impacts ${sum} !== expected ${expected}`);
  });

  test(`no row is ever both spending and income (seed ${seed})`, () => {
    const led = randomLedger(seed);
    const rows = sprinkleTypes(led.visibleRows(), seed);
    markInternalTransfers(rows);
    for (const t of rows) {
      assert.ok(
        !(isSpend(t) && isIncome(t)),
        `row ${t.id} (${t.amount}, ${t.accounts.type}, user_type=${t.user_type}) is in BOTH totals`
      );
    }
  });
}

// --------------------------------------------------------- the honest edges

test('a boundary-straddling transfer pair inflates both months but explains itself', () => {
  const A = makeAccounts();
  // Per-month pairing (getMonthTransactions) cannot see across the boundary, so
  // neither leg is washed: July counts the outflow as spending, August counts
  // the inflow as income. Both months still reconcile — the point of the test.
  const july = [makeTx(A.checking, 'out', '2026-07-31', 500, 'ONLINE BANKING TRANSFER TO SAVINGS')];
  const august = [makeTx(A.savings, 'in', '2026-08-02', -500, 'ONLINE BANKING TRANSFER FROM CHECKING')];
  markInternalTransfers(july);
  markInternalTransfers(august);
  const accounts = [A.checking, A.savings];
  const snaps = [
    snap(A.checking.id, '2026-06-30', 1000), snap(A.savings.id, '2026-06-30', 1000),
    snap(A.checking.id, '2026-07-31', 500),  snap(A.savings.id, '2026-07-31', 1000),
    snap(A.checking.id, '2026-08-31', 500),  snap(A.savings.id, '2026-08-31', 1500),
  ];
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows: july }, { month: '2026-08', rows: august }],
    snapshots: snaps,
    accounts,
    today: '2026-09-15',
  });
  const [aug, jul] = months; // newest first
  assert.equal(jul.spending, 500, 'the unpaired outflow counts in July');
  assert.equal(aug.income, 500, 'the unpaired inflow counts in August');
  assert.ok(near(jul.unexplained, 0), 'July still reconciles');
  assert.ok(near(aug.unexplained, 0), 'August still reconciles');
});

test('the month in progress reconciles to the newest snapshot, with rows sliced to match', () => {
  const A = makeAccounts();
  const rows = [
    makeTx(A.checking, 'a', '2026-09-03', 100, 'SAFEWAY 1467 EVERETT WA'),
    makeTx(A.checking, 'b', '2026-09-25', 250, 'ACE HARDWARE STORE 12'), // after the last snapshot
  ];
  markInternalTransfers(rows);
  const snaps = [snap(A.checking.id, '2026-08-31', 1000), snap(A.checking.id, '2026-09-10', 900)];
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-09', rows }],
    snapshots: snaps,
    accounts: [A.checking],
    today: '2026-09-27',
  });
  const m = months[0];
  assert.equal(m.partial, true);
  assert.equal(m.balanceEnd.date, '2026-09-10', 'the window ends at the newest snapshot');
  assert.equal(m.spending, 100, 'the row after the cutoff is outside the window');
  assert.ok(near(m.unexplained, 0));
});

test('a month whose newest snapshot predates it reports no balance coverage', () => {
  const A = makeAccounts();
  const rows = [makeTx(A.checking, 'a', '2026-09-03', 100, 'SAFEWAY 1467 EVERETT WA')];
  markInternalTransfers(rows);
  // Last sync was August: a September window ending Aug 31 would be zero-length
  // and would compute a truthful-looking 0 = 0 that answers nothing.
  const snaps = [snap(A.checking.id, '2026-08-31', 1000)];
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-09', rows }],
    snapshots: snaps,
    accounts: [A.checking],
    today: '2026-09-27',
  });
  assert.equal(months[0].deltaObserved, null);
  assert.equal(months[0].balanceEnd, null);
  assert.equal(months[0].spending, 100, 'the rows half still renders');
});

// ------------------------------------------------------------- classification

test('bucket classification follows the model precedence, never a second copy of it', () => {
  const A = makeAccounts();
  // excluded beats a structural wash.
  const pair = [
    makeTx(A.checking, 'x1', '2026-07-10', 300, 'ONLINE BANKING TRANSFER TO SAVINGS', { excluded: true }),
    makeTx(A.savings, 'x2', '2026-07-11', -300, 'ONLINE BANKING TRANSFER FROM CHECKING'),
  ];
  markInternalTransfers(pair);
  assert.equal(classifyUncounted(pair[0]), 'excluded');
  // A one-sided override: the row itself is a transfer, and its former partner
  // re-derives structurally — the impact is nonzero, which is the tell.
  const oneSided = makeTx(A.checking, 'y', '2026-07-10', 300, 'SAFEWAY 1467 EVERETT WA', {});
  oneSided.user_type = 'transfer';
  assert.equal(classifyUncounted(oneSided), 'transfer');
  // A card credit held back by the card-side veto.
  const payment = makeTx(A.card1, 'z', '2026-07-16', -400, 'CAPITAL ONE MOBILE PYMT AUTOPAY');
  assert.equal(isSpend(payment), false);
  assert.equal(classifyUncounted(payment), 'cardPayment');
  // A hand-set transfer category on a money-out row.
  const handSet = makeTx(A.checking, 'w', '2026-07-10', 75, 'MYSTERY VENDOR LLC', {
    user_category: 'Transfers and card payments',
  });
  assert.equal(classifyUncounted(handSet), 'cardPayment');
  assert.equal(classifyUncounted(null), 'other');
});

test('a counted row on an out-of-scope account corrects the headline via outOfScope', () => {
  const A = makeAccounts();
  // An investment account: not in RECON_SCOPE_TYPES, so its balance is not in
  // the total — but isSpend still counts its outflows (a documented asymmetry).
  const brokerage = { id: 'acc-inv', type: 'investment', subtype: null, hidden: false };
  const rows = [
    makeTx(A.checking, 'a', '2026-07-03', 100, 'SAFEWAY 1467 EVERETT WA'),
    makeTx(brokerage, 'b', '2026-07-04', 60, 'TOTALLY UNKNOWN VENDOR 9'),
  ];
  markInternalTransfers(rows);
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: [snap(A.checking.id, '2026-06-30', 1000), snap(A.checking.id, '2026-07-31', 900)],
    accounts: [A.checking, brokerage],
    today: '2026-08-28',
  });
  const m = months[0];
  assert.equal(m.spending, 160, 'both rows count as spending');
  const by = Object.fromEntries(m.buckets.map(b => [b.key, b]));
  assert.ok(near(by.outOfScope.impact, 60));
  assert.ok(near(by.outOfScope.moneyOut, 60), 'a money-OUT row reads as money out');
  assert.ok(near(m.deltaLedger, m.net + m.buckets.reduce((a, b) => a + b.impact, 0)));
  assert.ok(near(m.unexplained, 0), 'the correction is what keeps this at zero');
});

test('scope is the cash boundary: depository and credit, never loans', () => {
  assert.deepEqual(RECON_SCOPE_TYPES, ['depository', 'credit']);
  const A = makeAccounts();
  const ids = reconciliationScope(Object.values(A)).map(a => a.id);
  assert.ok(!ids.includes(A.mortgage.id), 'loan balances and loan rows cancel by being out of both');
  assert.ok(ids.includes(A.checking.id) && ids.includes(A.card1.id));
  assert.deepEqual(reconciliationScope(null), []);
});

// ------------------------------------------------------- degrade and ordering

test('garbage input degrades to an empty shape and never throws', () => {
  assert.deepEqual(buildReconciliation(), {
    months: [],
    coverage: { earliestSnapshot: null, latestSnapshot: null },
    nearMiss: { pairs: [], total: 0 },
  });
  assert.deepEqual(buildReconciliation({}).months, []);
  const r = buildReconciliation({
    monthsRows: [null, { month: 'garbage', rows: [] }, { month: '2026-07', rows: [null, {}] }],
    snapshots: [null, { account_id: 'nope' }],
    accounts: [null, { id: 'a', type: 'depository' }],
    today: null,
  });
  assert.equal(r.months.length, 1, 'unparseable months are dropped, not rendered');
  assert.equal(r.months[0].deltaLedger, 0);
});

test('a NaN amount cannot poison a sum', () => {
  const A = makeAccounts();
  const rows = [makeTx(A.checking, 'a', '2026-07-03', 100, 'SAFEWAY 1467 EVERETT WA')];
  markInternalTransfers(rows);
  rows.push({ ...rows[0], id: 'bad', amount: NaN });
  rows.push({ ...rows[0], id: 'nul', amount: null });
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: [],
    accounts: [A.checking],
    today: '2026-08-28',
  });
  assert.equal(months[0].deltaLedger, -100);
  assert.ok(Number.isFinite(months[0].spending));
});

test('output is deterministic: months newest first, buckets in a fixed order', () => {
  const { led, rows, snaps } = julyFixture();
  const accounts = Object.values(led.accounts).filter(a => !a.hidden);
  const input = {
    monthsRows: [{ month: '2026-06', rows: [] }, { month: '2026-07', rows }, { month: '2026-05', rows: [] }],
    snapshots: snaps,
    accounts,
    today: '2026-08-28',
  };
  const a = buildReconciliation(input);
  const b = buildReconciliation(input);
  assert.deepEqual(a.months.map(m => m.month), ['2026-07', '2026-06', '2026-05']);
  const keys = a.months[0].buckets.map(x => x.key);
  assert.deepEqual(keys, BUCKET_ORDER.filter(k => keys.includes(k)));
  assert.deepEqual(a, b, 'same input twice must give the same answer');
});

// ================================================================ GROSS FLOWS
//
// The gross view adds no new external cross-check — balances report only a
// LEVEL, so gross debits/credits are unrecoverable from them. What it must do
// is stay welded to the identity it decorates: if the class list and the
// signed total can drift apart, the panel starts contradicting itself on
// screen, which is worse than showing nothing.

const flowsOf = (rows, accounts) =>
  buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: [],
    accounts,
    today: '2026-08-29',
  }).months[0];

test('classifyFlow agrees with the ONE predicates and partitions every row exactly once', () => {
  for (const seed of [1, 7, 42, 1234, 98765]) {
    const led = randomLedger(seed);
    const rows = sprinkleTypes(led.visibleRows(), seed);
    markInternalTransfers(rows);
    for (const t of rows) {
      const cls = classifyFlow(t);
      assert.ok(FLOW_ORDER.includes(cls), `${cls} is not a flow class`);
      assert.equal(cls === 'spending', isSpend(t), `spending disagreement on ${t.id}`);
      assert.equal(cls === 'income', isIncome(t), `income disagreement on ${t.id}`);
      if (cls !== 'spending' && cls !== 'income') assert.equal(cls, classifyUncounted(t));
    }
  }
  assert.equal(classifyFlow(null), 'other');
  assert.equal(classifyFlow(undefined), 'other');
});

for (const seed of [1, 7, 42, 1234, 98765]) {
  test(`gross conservation on seed ${seed}: deltaLedger === moneyIn − moneyOut`, () => {
    const led = randomLedger(seed);
    const rows = sprinkleTypes(led.visibleRows(), seed);
    markInternalTransfers(rows);
    const m = flowsOf(rows, Object.values(led.accounts).filter(a => !a.hidden));
    // Positive amount is money OUT and deltaLedger is −Σ amount, so the
    // direction is IN minus OUT. Getting this backwards is the easy mistake.
    assert.ok(
      near(m.deltaLedger, m.flows.moneyIn.total - m.flows.moneyOut.total, 1e-6),
      `deltaLedger ${m.deltaLedger} !== in ${m.flows.moneyIn.total} − out ${m.flows.moneyOut.total}`
    );
  });

  test(`the reported spending and income figures are reconstructible on seed ${seed}`, () => {
    const led = randomLedger(seed);
    const rows = sprinkleTypes(led.visibleRows(), seed);
    markInternalTransfers(rows);
    const m = flowsOf(rows, Object.values(led.accounts).filter(a => !a.hidden));
    const f = m.flows;
    // The split that was invisible before: the headline figure is already net.
    assert.ok(near(f.purchases - f.refunds, f.spending));
    assert.ok(near(f.incomeReceived - f.incomeReturned, f.income));
    // ...and adding back the out-of-scope share returns the headline exactly.
    assert.ok(near(f.spending + f.outOfScope.spending, m.spending), 'spending');
    assert.ok(near(f.income + f.outOfScope.income, m.income), 'income');
    // The sentence on screen must equal the list under it.
    assert.ok(near(f.leftAndStayedGone, f.spending + f.excludedNet + f.otherNet));
    // Sections add up from their own printed parts.
    for (const side of [f.moneyOut, f.moneyIn]) {
      assert.ok(near(side.total, side.classes.reduce((a, c) => a + c.amount, 0)));
      const keys = side.classes.map(c => c.key);
      assert.deepEqual(keys, FLOW_ORDER.filter(k => keys.includes(k)), 'class order');
      for (const c of side.classes) assert.ok(!Object.is(c.amount, -0));
    }
    assert.ok(!Object.is(f.moneyOut.total, -0) && !Object.is(f.moneyIn.total, -0));
  });
}

test('the standard fixture splits its spending into purchases and refunds', () => {
  const { led, rows } = julyFixture();
  const m = flowsOf(rows, Object.values(led.accounts).filter(a => !a.hidden));
  const f = m.flows;
  // 764.00 is the pre-refund-netting total recorded in test/helpers/ledger.js —
  // visible on a screen for the first time.
  assert.equal(f.purchases, 764.0);
  assert.equal(f.refunds, 35.0);
  assert.equal(f.spending, 729.0);
  assert.equal(f.spending, m.spending, 'must equal what every other screen prints');
  assert.equal(f.incomeReceived, 2501.25);
  assert.equal(f.incomeReturned, 0);
  assert.equal(f.moneyOut.total, 1504.0);
  assert.equal(f.moneyIn.total, 3236.25);
  assert.equal(m.deltaLedger, 1732.25);
  // Both internal classes have both legs in the month, so they net to zero.
  assert.equal(f.internalOut, 700);
  assert.equal(f.internalIn, 700);
  // 729 spending + 40 excluded by hand.
  assert.equal(f.leftAndStayedGone, 769.0);
});

// ==================================================== POSSIBLE MISSED TRANSFERS
//
// The failure mode no balance check can see: a real transfer that failed to
// pair counts as spending AND income while the identity still balances
// perfectly. These guard the detector's precision — a false positive here
// costs a glance, but a detector that cries wolf gets ignored, and then the
// $23k/quarter shape it exists for goes unnoticed again.

// A straddling pair: out Jul 31, in Aug 2. Per-month pairing cannot see across
// the boundary, so both legs count today.
function straddle(overrides = {}) {
  const A = makeAccounts();
  const july = [makeTx(A.checking, 'so', '2026-07-31', 500, 'ONLINE BANKING TRANSFER TO SAVINGS', overrides.out || {})];
  const august = [makeTx(A.savings, 'si', '2026-08-02', -500, 'ONLINE BANKING TRANSFER FROM CHECKING', overrides.in || {})];
  markInternalTransfers(july);
  markInternalTransfers(august);
  if (overrides.outType) july[0].user_type = overrides.outType;
  if (overrides.inType) august[0].user_type = overrides.inType;
  return { A, july, august, all: july.concat(august) };
}

test('a straddling transfer is found only when both months are seen together', () => {
  const { july, all } = straddle();
  const r = nearMissTransfers(all);
  assert.equal(r.total, 1);
  assert.equal(r.pairs.length, 1);
  const p = r.pairs[0];
  assert.equal(p.tier, 'exact');
  assert.equal(p.crossMonth, true);
  assert.equal(p.gapDays, 2);
  assert.equal(p.amount, 500);
  assert.equal(p.delta, 0);
  assert.equal(p.out.id, 'so');
  assert.equal(p.in.id, 'si');
  assert.equal(p.out.accountId, 'acc-chk');
  assert.equal(p.in.accountId, 'acc-sav');
  // The whole reason the pass folds every fetched month together.
  assert.equal(nearMissTransfers(july).total, 0, 'one month alone can never see it');
});

test('a row the human already typed is never flagged (the cashFlow.js:50 mirror)', () => {
  // user_type IS the human saying what this row is; re-flagging it would undo
  // the false-wash fix the override exists for.
  assert.equal(nearMissTransfers(straddle({ outType: 'transfer' }).all).total, 0);
  assert.equal(nearMissTransfers(straddle({ inType: 'transfer' }).all).total, 0);
  assert.equal(nearMissTransfers(straddle({ outType: 'spending' }).all).total, 0);
  // Excluded rows are out of the pool too.
  assert.equal(nearMissTransfers(straddle({ out: { excluded: true } }).all).total, 0);
  assert.equal(nearMissTransfers(straddle({ in: { excluded: true } }).all).total, 0);
});

test('a loan leg is never flagged — loan rows are out of the pairing pool', () => {
  const A = makeAccounts();
  const july = [makeTx(A.checking, 'lo', '2026-07-31', 500, 'ONLINE BANKING TRANSFER TO SAVINGS')];
  const august = [makeTx(A.mortgage, 'li', '2026-08-02', -500, 'PAYMENT RECEIVED THANK YOU')];
  markInternalTransfers(july);
  markInternalTransfers(august);
  assert.equal(nearMissTransfers(july.concat(august)).total, 0);
});

test('the damage gate: a straddling CARD PAYMENT is not reported, because nothing is over-counted', () => {
  const A = makeAccounts();
  // Both legs are vetoed by the card-payment guards, so an unpaired card
  // payment counts in NEITHER total — there is no error to report.
  const july = [makeTx(A.checking, 'po', '2026-07-31', 400, 'CAPITAL ONE AUTOPAY PYMT')];
  const august = [makeTx(A.card1, 'pi', '2026-08-02', -400, 'CAPITAL ONE MOBILE PYMT AUTOPAY')];
  markInternalTransfers(july);
  markInternalTransfers(august);
  assert.equal(isSpend(july[0]), false, 'payer leg is vetoed');
  assert.equal(isIncome(august[0]), false, 'card leg is not income');
  assert.equal(nearMissTransfers(july.concat(august)).total, 0);
});

test('the amount floor keeps small coincidences out', () => {
  const A = makeAccounts();
  const mk = amt => {
    const j = [makeTx(A.checking, 'fo', '2026-07-31', amt, 'ONLINE BANKING TRANSFER TO SAVINGS')];
    const a = [makeTx(A.savings, 'fi', '2026-08-02', -amt, 'ONLINE BANKING TRANSFER FROM CHECKING')];
    markInternalTransfers(j);
    markInternalTransfers(a);
    return j.concat(a);
  };
  assert.equal(nearMissTransfers(mk(50)).total, 0, 'below the floor');
  assert.equal(nearMissTransfers(mk(NEAR_MISS_MIN_AMOUNT)).total, 1, 'at the floor');
});

test('the near tier catches a sub-dollar discrepancy, and nothing looser', () => {
  const A = makeAccounts();
  const mk = inAmt => {
    const rows = [
      makeTx(A.checking, 'no', '2026-07-10', 500, 'ONLINE BANKING TRANSFER TO SAVINGS'),
      makeTx(A.savings, 'ni', '2026-07-12', -inAmt, 'ONLINE BANKING TRANSFER FROM CHECKING'),
    ];
    markInternalTransfers(rows);
    return rows;
  };
  const hit = nearMissTransfers(mk(499.6));
  assert.equal(hit.total, 1);
  assert.equal(hit.pairs[0].tier, 'near');
  assert.equal(hit.pairs[0].delta, 0.4);
  // $5 apart is not "a fee shaved the receiving leg" — it is two transactions.
  assert.equal(nearMissTransfers(mk(495)).total, 0);
});

test('two legs on the SAME account never pair — the pairing requires two accounts', () => {
  const A = makeAccounts();
  const rows = [
    makeTx(A.checking, 'ao', '2026-07-10', 500, 'ONLINE BANKING TRANSFER TO SAVINGS'),
    makeTx(A.checking, 'ai', '2026-07-16', -500, 'PAYROLL DIRECT DEP'),
  ];
  markInternalTransfers(rows);
  assert.equal(nearMissTransfers(rows).total, 0);
});

test('no row is reused across candidates', () => {
  const A = makeAccounts();
  // One inflow against three identical outflows: without greedy consumption a
  // single recurring paycheck would match every same-sized outflow in range.
  const rows = [
    makeTx(A.checking, 'r1', '2026-07-10', 500, 'ONLINE BANKING TRANSFER TO SAVINGS'),
    makeTx(A.checking, 'r2', '2026-07-11', 500, 'ONLINE BANKING TRANSFER TO SAVINGS'),
    makeTx(A.checking, 'r3', '2026-07-12', 500, 'ONLINE BANKING TRANSFER TO SAVINGS'),
    makeTx(A.savings, 'r4', '2026-07-13', -500, 'ONLINE BANKING TRANSFER FROM CHECKING'),
  ];
  markInternalTransfers(rows);
  const r = nearMissTransfers(rows);
  const seen = new Set();
  for (const p of r.pairs) {
    for (const id of [p.out.id, p.in.id]) {
      assert.ok(!seen.has(id), `${id} appears in two candidates`);
      seen.add(id);
    }
  }
  assert.ok(r.total <= 1, 'one inflow can back at most one pair');
});

test('output is deterministic under input order, capped, and honest about the count', () => {
  const A = makeAccounts();
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const amt = 100 + i * 50;
    rows.push(makeTx(A.checking, `co${i}`, '2026-07-10', amt, 'ONLINE BANKING TRANSFER TO SAVINGS'));
    rows.push(makeTx(A.savings, `ci${i}`, '2026-07-19', -amt, 'ONLINE BANKING TRANSFER FROM CHECKING'));
  }
  markInternalTransfers(rows);
  const r = nearMissTransfers(rows, { limit: 8 });
  assert.equal(r.total, 12, 'total counts survivors, not just what is shown');
  assert.equal(r.pairs.length, 8);
  const amounts = r.pairs.map(p => p.amount);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), 'largest first');
  assert.equal(amounts[0], 100 + 11 * 50, 'the biggest miss leads');
  // Shuffling the input must not change the answer.
  const rand = lcg(99);
  const shuffled = rows.slice().sort(() => rand() - 0.5);
  assert.deepEqual(nearMissTransfers(shuffled, { limit: 8 }), r);
});

test('the detector never mutates a row and never throws on garbage', () => {
  const { all } = straddle();
  const before = all.map(t => ({ ...t }));
  nearMissTransfers(all);
  all.forEach((t, i) => assert.deepEqual({ ...t }, before[i], 'rows must be left untouched'));
  for (const junk of [undefined, null, [], [null, {}, { amount: NaN }, { id: 'x', amount: 5, date: 'nope' }]]) {
    assert.deepEqual(nearMissTransfers(junk), { pairs: [], total: 0 });
  }
});

test('buildReconciliation surfaces the near miss without disturbing any identity', () => {
  const { A, july, august } = straddle();
  const { months, nearMiss } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows: july }, { month: '2026-08', rows: august }],
    snapshots: [],
    accounts: [A.checking, A.savings],
    today: '2026-09-15',
  });
  assert.equal(nearMiss.total, 1);
  assert.equal(nearMiss.pairs[0].amount, 500);
  // The pair really is being double-counted today — that is the whole claim.
  assert.equal(months[1].spending, 500, 'July counts the outflow as spending');
  assert.equal(months[0].income, 500, 'August counts the inflow as income');
  // And every identity still holds on both months.
  for (const m of months) {
    assert.ok(near(m.deltaLedger, m.net + m.buckets.reduce((a, b) => a + b.impact, 0)));
    assert.ok(near(m.deltaLedger, m.flows.moneyIn.total - m.flows.moneyOut.total));
  }
});
