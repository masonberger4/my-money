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
  monthEdges,
  reconciliationScope,
  BUCKET_ORDER,
  RECON_SCOPE_TYPES,
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
