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
import { readFileSync } from 'node:fs';
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
import { withEffectiveDate, getReconciliation } from '../src/dataAdapter.js';
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
  const { led, rows, snaps } = julyFixture();
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

test('a month that balances to the cent renders 0, never a float-noise "−$0" (F60)', () => {
  // 10.10 + 20.20 + 30.30 is 60.599999999999994 in floating point, so the raw
  // residual against a -60.60 balance move was -7e-15 — which the panel's
  // signed() printed as "−$0" on the one line it tells the household to watch.
  // Two excluded rows (0.10 + 0.20) give a bucket whose raw sum is
  // -0.30000000000000004, the same class of noise on a bucket line.
  const A = makeAccounts();
  const rows = [
    makeTx(A.checking, 'a', '2026-07-03', 10.1, 'SAFEWAY 1467 EVERETT WA'),
    makeTx(A.checking, 'b', '2026-07-04', 20.2, 'SAFEWAY 1467 EVERETT WA'),
    makeTx(A.checking, 'c', '2026-07-05', 30.3, 'SAFEWAY 1467 EVERETT WA'),
    makeTx(A.checking, 'd', '2026-07-06', 0.1, 'MYSTERY VENDOR LLC', { excluded: true }),
    makeTx(A.checking, 'e', '2026-07-07', 0.2, 'MYSTERY VENDOR LLC', { excluded: true }),
  ];
  markInternalTransfers(rows);
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: [snap(A.checking.id, '2026-06-30', 100), snap(A.checking.id, '2026-07-31', 39.1)],
    accounts: [A.checking],
    today: '2026-08-28',
  });
  const m = months[0];
  assert.equal(m.unexplained, 0);
  assert.ok(!Object.is(m.unexplained, -0), 'a −0 renders as "−$0"');
  assert.equal(m.spending, 60.6);
  assert.equal(m.net, -60.6);
  assert.equal(m.deltaLedger, -60.9);
  assert.equal(m.deltaObserved, -60.9);
  const by = Object.fromEntries(m.buckets.map(b => [b.key, b]));
  assert.equal(by.excluded.impact, -0.3, 'bucket lines are cent-exact too');
  assert.equal(by.excluded.moneyOut, 0.3);
  assert.equal(by.excluded.moneyIn, 0);
  // A month whose income and spending cancel nets to +0, not −0.
  const flat = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows: [] }],
    snapshots: [snap(A.checking.id, '2026-06-30', 100), snap(A.checking.id, '2026-07-31', 100)],
    accounts: [A.checking],
    today: '2026-08-28',
  }).months[0];
  for (const k of ['net', 'income', 'spending', 'deltaLedger', 'deltaObserved', 'unexplained']) {
    assert.ok(Object.is(flat[k], 0), `${k} is ${flat[k]}`);
  }
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

// ------------------------------------------------------ date edits (F24)
//
// The ledger rows are EFFECTIVE-date month reads (rule 3: the panel must wash
// exactly what Overview washes), but balances move on the BANK's date. A row
// the household re-dated across a month edge used to leave its amount in one
// month's ledger and its balance move in the other's, so every date edit
// showed as ± its amount of "Unexplained" in two months. The shift is now a
// named line, `dateMoved`, and the residual stays the interest/fees/timing
// number it is documented to be.

// A row the way getMonthTransactions delivers it after a date edit: `date` is
// the effective date and the bank's rides as `bank_date` (withEffectiveDate).
const redated = (account, id, bankDate, userDate, amount, description, extra = {}) =>
  withEffectiveDate([
    makeTx(account, id, bankDate, amount, description, { user_date: userDate, effective_date: userDate, ...extra }),
  ])[0];
const bucketOf = (m, key) => m.buckets.find(b => b.key === key);
const grossPin = m => m.deltaLedger - (bucketOf(m, 'dateMoved')?.impact ?? 0);

test('a row re-dated across a month edge is named, not left as two Unexplained residuals', () => {
  const A = makeAccounts();
  // Posted Sep 30, counted in October by the household (the lensdiff repro).
  const row = redated(A.checking, 'm1', '2026-09-30', '2026-10-01', 100, 'SAFEWAY 1467 EVERETT WA');
  assert.equal(row.date, '2026-10-01');
  assert.equal(row.bank_date, '2026-09-30');
  const oct = [row];
  markInternalTransfers(oct);
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-09', rows: [] }, { month: '2026-10', rows: oct }],
    // The balance dropped in SEPTEMBER — that is when the bank moved it.
    snapshots: [
      snap(A.checking.id, '2026-08-31', 1000),
      snap(A.checking.id, '2026-09-30', 900),
      snap(A.checking.id, '2026-10-31', 900),
    ],
    accounts: [A.checking],
    today: '2026-11-15',
  });
  const [o, s] = months;
  assert.equal(o.spending, 100, 'October still counts it — Overview parity is untouched');
  assert.equal(s.spending, 0);
  assert.equal(s.unexplained, 0, `September unexplained ${s.unexplained}`);
  assert.equal(o.unexplained, 0, `October unexplained ${o.unexplained}`);
  assert.equal(bucketOf(s, 'dateMoved').impact, -100, 'moved OUT of the bank month');
  assert.equal(bucketOf(s, 'dateMoved').count, 1);
  assert.equal(bucketOf(o, 'dateMoved').impact, 100, 'moved INTO the effective month');
  assert.equal(bucketOf(o, 'dateMoved').label, 'Moved by a date edit');
  for (const m of months) {
    assert.ok(near(m.deltaLedger, m.net + m.buckets.reduce((a, b) => a + b.impact, 0)), `identity ${m.month}`);
    assert.ok(near(grossPin(m), m.flows.moneyIn.total - m.flows.moneyOut.total), `gross ${m.month}`);
  }
  // The gross view describes the effective month's rows and nothing else.
  assert.equal(s.flows.moneyOut.total, 0);
  assert.equal(o.flows.moneyOut.total, 100);
});

test('a row re-dated out of the fetched span is corrected from the movedOut read', () => {
  const A = makeAccounts();
  // Posted Sep 2, re-dated back into July — outside a Sep..Oct span, so no
  // month read returns it and only the bank-date read can.
  const away = redated(A.checking, 'm2', '2026-09-02', '2026-07-15', 60, 'ACE HARDWARE STORE 12');
  const input = {
    monthsRows: [{ month: '2026-09', rows: [] }, { month: '2026-10', rows: [] }],
    snapshots: [
      snap(A.checking.id, '2026-08-31', 1000),
      snap(A.checking.id, '2026-09-30', 940),
      snap(A.checking.id, '2026-10-31', 940),
    ],
    accounts: [A.checking],
    today: '2026-11-15',
  };
  const sep = buildReconciliation({ ...input, movedOut: [away] }).months[1];
  assert.equal(sep.month, '2026-09');
  assert.equal(sep.unexplained, 0);
  assert.equal(bucketOf(sep, 'dateMoved').impact, -60);
  // Without the read it is exactly the old residual — the reason it exists.
  assert.equal(buildReconciliation(input).months[1].unexplained, -60);
  // A movedOut row that duplicates a month row (same id) is not counted twice.
  const dupe = buildReconciliation({
    ...input,
    monthsRows: [{ month: '2026-09', rows: [] }, { month: '2026-10', rows: [] }, { month: '2026-07', rows: [away] }],
    movedOut: [away],
  }).months.find(m => m.month === '2026-09');
  assert.equal(bucketOf(dupe, 'dateMoved').impact, -60);
  // A row posted BEFORE the span and re-dated into it needs no extra read:
  // the month read carries its bank date.
  const into = redated(A.checking, 'm3', '2026-08-30', '2026-09-01', 25, 'ACE HARDWARE STORE 12');
  const s2 = buildReconciliation({
    ...input,
    monthsRows: [{ month: '2026-09', rows: [into] }, { month: '2026-10', rows: [] }],
    snapshots: [
      snap(A.checking.id, '2026-08-31', 1000),
      snap(A.checking.id, '2026-09-30', 1000),
      snap(A.checking.id, '2026-10-31', 1000),
    ],
  }).months[1];
  assert.equal(s2.unexplained, 0);
  assert.equal(bucketOf(s2, 'dateMoved').impact, 25);
});

test('the month in progress corrects against its own window, on the bank date', () => {
  const A = makeAccounts();
  // Today Oct 16; the newest balance reading is Oct 10.
  const snaps = [
    snap(A.checking.id, '2026-08-31', 1000),
    snap(A.checking.id, '2026-09-30', 1000),
    snap(A.checking.id, '2026-10-10', 900),
  ];
  // Posted Oct 15 — AFTER the Oct 10 reading — and re-dated back into
  // September. September is corrected; October's window never saw the
  // posting, so it must not be corrected for it.
  const late = redated(A.checking, 'p1', '2026-10-15', '2026-09-28', 40, 'ACE HARDWARE STORE 12');
  // Posted Oct 3 (inside the window) and re-dated to Oct 14 (after it): the
  // Oct 10 balance already shows it, the effective-date slice does not.
  const pushed = redated(A.checking, 'p2', '2026-10-03', '2026-10-14', 100, 'SAFEWAY 1467 EVERETT WA');
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-09', rows: [late] }, { month: '2026-10', rows: [pushed] }],
    snapshots: snaps,
    accounts: [A.checking],
    today: '2026-10-16',
  });
  const [o, s] = months;
  assert.equal(o.partial, true);
  assert.equal(o.balanceEnd.date, '2026-10-10');
  assert.equal(o.spending, 0, 'the Oct 14 row is after the cutoff');
  assert.equal(o.unexplained, 0, `October unexplained ${o.unexplained}`);
  assert.equal(bucketOf(o, 'dateMoved').impact, -100, 'only the in-window posting is corrected');
  assert.equal(bucketOf(o, 'dateMoved').count, 1);
  assert.equal(s.unexplained, 0, `September unexplained ${s.unexplained}`);
  assert.equal(bucketOf(s, 'dateMoved').impact, 40);
});

test('getReconciliation feeds the builder a BANK-date read of rows re-dated out of the span', () => {
  // Source scan (the txDate.test.js precedent): the extra read is what makes
  // a row re-dated out of the span reconcile, and it is easy to lose.
  const adapter = readFileSync(new URL('../src/dataAdapter.js', import.meta.url), 'utf8');
  const fn = adapter.slice(adapter.indexOf('export async function getReconciliation('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes(".not('user_date', 'is', null)"), 'only re-dated rows');
  assert.ok(/\.gte\('date', spanStart\)\s*\.lte\('date', spanEnd\)/.test(body), 'ranged on the BANK date');
  assert.ok(body.includes(".eq('accounts.hidden', false)"), 'hidden accounts excluded at the query level');
  assert.ok(body.includes('withEffectiveDate('), 'same row shape as the month reads');
  assert.ok(/buildReconciliation\(\{[^}]*\bmovedOut\b[^}]*\}\)/.test(body), 'handed to the builder');
  // The month rows themselves stay effective-date reads (rule 3 parity): the
  // injectable month read defaults to getMonthTransactions, and it is the one
  // the month loop calls.
  assert.ok(body.includes('fetchMonth = getMonthTransactions'));
  assert.ok(body.includes('fetchMonth(year, month)'));
});

// getReconciliation itself, driven through a recording fake of the two
// supabase-js chains it runs (the accounts read and the re-dated bank-date
// read); the month reads and the snapshot read are injected as functions.
function reconClient({ accounts, redated, redatedError = null }, calls) {
  return {
    from(table) {
      const q = { table, columns: null, filters: [] };
      const b = {
        select(cols) {
          q.columns = cols;
          return b;
        },
        eq(c, v) {
          q.filters.push(['eq', c, v]);
          return b;
        },
        not(c, op, v) {
          q.filters.push(['not', c, op, v]);
          return b;
        },
        gte(c, v) {
          q.filters.push(['gte', c, v]);
          return b;
        },
        lte(c, v) {
          q.filters.push(['lte', c, v]);
          return b;
        },
        order() {
          return b;
        },
        range() {
          return b;
        },
        then(resolve, reject) {
          calls.push(q);
          const out =
            table === 'accounts' ? { data: accounts, error: null }
            : redatedError ? { data: null, error: redatedError }
            : { data: redated, error: null };
          return Promise.resolve(out).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

// A raw row of the re-dated read, before withEffectiveDate: `date` is the
// bank's, `effective_date` the generated coalesce(user_date, date).
const rawRedated = (id, account_id, bankDate, effectiveDate, amount) => ({
  id,
  account_id,
  date: bankDate,
  amount,
  user_date: effectiveDate,
  effective_date: effectiveDate,
  accounts: { hidden: false },
});

function reconHarness({ redatedError = null } = {}) {
  const A = makeAccounts();
  const calls = [];
  const monthCalls = [];
  const snapshotCalls = [];
  // Today Oct 15 and the history starts Aug 31, so the span is Aug..Oct:
  // spanStart 2026-08-01, spanEnd 2026-10-31.
  const redated = [
    // Counted OUTSIDE the span (before it, after it): the only rows the
    // builder needs from this read.
    rawRedated('out-before', A.checking.id, '2026-09-10', '2026-07-20', 40),
    rawRedated('out-after', A.checking.id, '2026-10-02', '2026-11-03', 15),
    // Counted INSIDE the span, on both edges: a month read carries these,
    // so the client-side filter must drop them.
    rawRedated('in-start', A.checking.id, '2026-08-05', '2026-08-01', 25),
    rawRedated('in-end', A.checking.id, '2026-09-20', '2026-10-31', 30),
  ];
  const client = reconClient({ accounts: [A.checking], redated, redatedError }, calls);
  const deps = {
    client,
    // Every month read comes back empty, so the dateMoved lines below list
    // EXACTLY the rows the re-dated read let through to the builder.
    fetchMonth: async (year, month) => {
      monthCalls.push([year, month]);
      return [];
    },
    fetchSnapshots: async (ids, since) => {
      snapshotCalls.push([ids, since]);
      // The bank moved -40 in September and -15 by Oct 10 — the two rows
      // posted in the span and counted outside it.
      return [
        snap(A.checking.id, '2026-08-31', 1000),
        snap(A.checking.id, '2026-09-30', 960),
        snap(A.checking.id, '2026-10-10', 945),
      ];
    },
  };
  const run = () => getReconciliation({ now: new Date(2026, 9, 15, 12) }, deps);
  return { A, calls, monthCalls, snapshotCalls, run };
}

test('getReconciliation hands the builder only the re-dated rows counted OUTSIDE the span', async () => {
  const h = reconHarness();
  const out = await h.run();
  assert.equal(out.ok, true);
  assert.deepEqual(h.monthCalls, [[2026, 8], [2026, 9], [2026, 10]]);
  assert.deepEqual(h.snapshotCalls, [[[h.A.checking.id], null]]);

  // The read: re-dated rows only, ranged on the BANK date over the span,
  // hidden accounts excluded at the query level.
  const reads = h.calls.filter(q => q.table === 'transactions');
  assert.equal(reads.length, 1);
  const [read] = reads;
  for (const col of ['date', 'amount', 'account_id', 'user_date', 'effective_date']) {
    assert.ok(read.columns.split(/,\s*/).includes(col), `selects ${col}`);
  }
  for (const f of [
    ['eq', 'accounts.hidden', false],
    ['not', 'user_date', 'is', null],
    ['gte', 'date', '2026-08-01'],
    ['lte', 'date', '2026-10-31'],
  ]) {
    assert.ok(read.filters.some(g => JSON.stringify(g) === JSON.stringify(f)), `filter ${JSON.stringify(f)}`);
  }
  assert.ok(!read.filters.some(g => g[1] === 'effective_date'), 'never ranged on the effective date');

  const byMonth = Object.fromEntries(out.months.map(m => [m.month, m]));
  assert.deepEqual(Object.keys(byMonth).sort(), ['2026-08', '2026-09', '2026-10']);
  // Only the two outside-span rows reached the builder, each in its bank month.
  assert.equal(bucketOf(byMonth['2026-08'], 'dateMoved'), undefined, 'the Aug 1 edge row is inside the span');
  assert.deepEqual(
    [bucketOf(byMonth['2026-09'], 'dateMoved').impact, bucketOf(byMonth['2026-09'], 'dateMoved').count],
    [-40, 1],
    'September carries the row moved to July, never the one moved to Oct 31'
  );
  assert.deepEqual(
    [bucketOf(byMonth['2026-10'], 'dateMoved').impact, bucketOf(byMonth['2026-10'], 'dateMoved').count],
    [-15, 1]
  );
  // ...and those are what the balances did, so both months reconcile.
  assert.equal(byMonth['2026-09'].unexplained, 0);
  assert.equal(byMonth['2026-10'].unexplained, 0);
});

test('a failed re-dated read fails the panel (ok:false), never a fake residual', async () => {
  const h = reconHarness({ redatedError: { code: '57014', message: 'canceling statement due to statement timeout' } });
  const out = await h.run();
  assert.ok(h.calls.some(q => q.table === 'transactions'), 'the failure came from the re-dated read');
  assert.equal(out.ok, false);
  assert.deepEqual(out.months, []);
  assert.deepEqual(out.nearMiss, { pairs: [], total: 0 });
});

test('rows with no date edit, an in-month edit, or out of scope never produce a dateMoved line', () => {
  const A = makeAccounts();
  const rows = [
    // Post-migration row with no override: bank_date === date.
    withEffectiveDate([makeTx(A.checking, 'n1', '2026-07-03', 10, 'SAFEWAY 1467 EVERETT WA', { user_date: null, effective_date: '2026-07-03' })])[0],
    // Pre-migration row: no bank_date at all.
    makeTx(A.checking, 'n2', '2026-07-04', 20, 'SAFEWAY 1467 EVERETT WA'),
    // Re-dated within the month: both dates are inside the window.
    redated(A.checking, 'n3', '2026-07-05', '2026-07-25', 30, 'SAFEWAY 1467 EVERETT WA'),
    // A loan row moved across the edge: out of scope on both sides.
    redated(A.mortgage, 'n4', '2026-06-30', '2026-07-01', 900, 'MORTGAGE PAYMENT'),
  ];
  assert.equal(rows[0].bank_date, rows[0].date);
  markInternalTransfers(rows);
  const { months } = buildReconciliation({
    monthsRows: [{ month: '2026-07', rows }],
    snapshots: [snap(A.checking.id, '2026-06-30', 1000), snap(A.checking.id, '2026-07-31', 940)],
    accounts: [A.checking, A.mortgage],
    today: '2026-08-28',
  });
  assert.equal(bucketOf(months[0], 'dateMoved'), undefined);
  assert.equal(months[0].unexplained, 0);
  assert.ok(BUCKET_ORDER.includes('dateMoved'));
  assert.equal(BUCKET_ORDER.indexOf('dateMoved'), BUCKET_ORDER.indexOf('other') - 1, 'the catch-all stays last');
});

for (const seed of [3, 11, 42, 777]) {
  test(`random re-dates across three months all reconcile to zero on seed ${seed}`, () => {
    // Every July row is bank-dated July; a random slice is re-dated into June,
    // August, or elsewhere in July. Balances are built from the BANK dates —
    // what the bank actually did — so any residual is the code's fault.
    const led = randomLedger(seed);
    const rand = lcg(seed * 31 + 1);
    const targets = ['2026-06-29', '2026-06-03', '2026-08-01', '2026-08-30', '2026-07-30', '2026-07-01'];
    const rows = withEffectiveDate(
      sprinkleTypes(led.visibleRows(), seed).map(t => {
        if (rand() >= 0.2) return { ...t, effective_date: t.date };
        const to = targets[Math.floor(rand() * targets.length)];
        return { ...t, user_date: to, effective_date: to };
      })
    );
    const byMonth = m => rows.filter(t => t.date.slice(0, 7) === m);
    const monthsRows = ['2026-06', '2026-07', '2026-08'].map(month => {
      const r = byMonth(month);
      markInternalTransfers(r);
      return { month, rows: r };
    });
    const scope = scopeOf(led.accounts);
    const move = new Map(scope.map(a => [a.id, 0]));
    for (const t of rows) if (move.has(t.account_id)) move.set(t.account_id, move.get(t.account_id) - t.amount);
    const snaps = [];
    for (const a of scope) {
      const storedDelta = a.type === 'credit' ? -move.get(a.id) : move.get(a.id);
      snaps.push(snap(a.id, '2026-05-31', 1000), snap(a.id, '2026-06-30', 1000));
      snaps.push(snap(a.id, '2026-07-31', 1000 + storedDelta), snap(a.id, '2026-08-31', 1000 + storedDelta));
    }
    const { months } = buildReconciliation({
      monthsRows,
      snapshots: snaps,
      accounts: Object.values(led.accounts).filter(a => !a.hidden),
      today: '2026-09-15',
    });
    assert.equal(months.length, 3);
    let moved = 0;
    for (const m of months) {
      assert.ok(near(m.unexplained, 0, 1e-6), `${m.month} unexplained ${m.unexplained}`);
      assert.ok(near(m.deltaLedger, m.net + m.buckets.reduce((a, b) => a + b.impact, 0)), `identity ${m.month}`);
      assert.ok(near(grossPin(m), m.flows.moneyIn.total - m.flows.moneyOut.total), `gross ${m.month}`);
      moved += bucketOf(m, 'dateMoved')?.count ?? 0;
    }
    assert.ok(moved > 0, 'the fixture must actually move rows across months');
  });
}

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
    // The general pin is deltaLedger − dateMoved === in − out (the date-edit
    // timing correction is in no flow — see the F24 tests above); these
    // ledgers carry no date edits, so the plain form must hold exactly.
    assert.equal(m.buckets.find(b => b.key === 'dateMoved'), undefined);
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
