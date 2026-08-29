// Does the ledger add up against the bank's own balances?
//
// Mason's question (2026-08-28): "does the spending and income totals for each
// month match the total amount of money in the observable accounts linked to
// the app? I'm worried spending or income may be over-counted." The honest
// answer is NO, and not because anything is broken — money moves between and
// out of the linked accounts in ways that deliberately count as neither income
// nor spending. This module makes that difference EXPLICIT instead of leaving
// it as a discrepancy nobody can name: every dollar of the gap gets a labelled
// bucket, and whatever is left over is the number worth looking at.
//
// THE IDENTITY. Stored `amount` is positive = money OUT, and displayBalance
// negates credit/loan, so a row's effect on the DISPLAYED balance total is
// uniformly `-amount` on every account type. Partition a month's rows into
// P (isSpend), Q (isIncome) and Z (neither); P and Q are disjoint (pinned by a
// property test). Then, over the accounts in scope:
//
//     deltaLedger := -Σ_in-scope amount  =  (income - spending) + Σ bucketImpacts
//
// where each in-scope Z row contributes `-amount` to its bucket, and each
// COUNTED row on an out-of-scope account contributes `+amount` to `outOfScope`.
// That is an algebraic identity, not an estimate — `test/reconciliation.test.js`
// pins it over random ledgers. The buckets are therefore a complete explanation
// of why income - spending is not the month's balance change:
//
//   transfer     washed pairs between linked accounts (net $0 when both legs
//                land in the month — a boundary-straddling pair does not, and
//                that is the documented honest edge, not a bug)
//   cardPayment  card payments: paired legs, the payer leg of a payment to an
//                unlinked or hidden card (the biggest one-sided class by
//                design — the card's purchases were never in the ledger
//                either), and card credits held back by isCardPaymentReceived
//   excluded     rows excluded by hand
//   outOfScope   counted rows on accounts outside the balance view
//   other        anything else, rendered only when nonzero (unknowns stay
//                visible — a silently dropped row is the failure this module
//                exists to catch)
//
// WHAT IS LEFT is `unexplained = deltaObserved - deltaLedger`: interest
// accrual, fees the feed reports only as a balance change, pending-vs-posted
// timing, and snapshot timing (captured_on is the sync's UTC date, so an
// evening-PT sync lands on the next UTC day). Small residuals are normal. A
// large one on an ordinary month is real over- or under-counting — a double
// import, a duplicated row — which is exactly what Mason asked for.
//
// SCOPE is the cash boundary: non-hidden depository + credit accounts. Loan
// accounts are out of BOTH sides — their rows are in Z and their balances are
// out of the total, so they cancel exactly rather than needing a bucket (the
// counted leg of a loan payment is the depository outflow, which is in scope).
// Hidden accounts are already excluded at the query level, rows and balances
// alike, so they are consistent by construction.
//
// Membership in P/Q/Z comes from the ONE predicates, imported below — never
// re-derived here. A second copy of "is this spending?" is the exact hazard
// `counted` (toTxShape) exists to prevent; the same rule applies to a surface
// whose whole purpose is agreeing with the totals it audits. Bucket LABELLING
// likewise reuses effectiveTxType rather than re-listing the veto rules.
//
// Pure and plain-Node importable (the spending.js/netWorth.js precedent — the
// imports are all pure too). Never throws: it runs during the render of a
// diagnostics panel, and a reconciliation that crashes is worse than none.
import { isSpend, sumSpending, effectiveTxType, displayName } from './spending.js';
import { isIncome, cashIncome, INTERNAL_MATCH_WINDOW_DAYS } from './cashFlow.js';
import { displayBalance } from './accountBalance.js';

// The cash boundary. Loans are deliberately absent — see the scope note above.
export const RECON_SCOPE_TYPES = ['depository', 'credit'];

export const BUCKET_ORDER = ['transfer', 'cardPayment', 'excluded', 'outOfScope', 'other'];

export const BUCKET_LABELS = {
  transfer: 'Transfers between linked accounts',
  cardPayment: 'Card payments',
  excluded: 'Excluded by hand',
  outOfScope: 'Counted rows on other accounts',
  other: 'Other uncounted rows',
};

export function reconciliationScope(accounts) {
  return (accounts || []).filter(a => a && a.id && RECON_SCOPE_TYPES.includes(a.type));
}

const pad2 = n => String(n).padStart(2, '0');

// Month edges off the 'YYYY-MM' key. Day counts come from numeric-argument
// Date construction (the monthBounds trick) — never `new Date('YYYY-MM-DD')`,
// which parses as UTC and lands a month edge on the wrong day west of
// Greenwich. Returns null for a key that isn't a real month.
export function monthEdges(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  if (!(m >= 1 && m <= 12)) return null;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return {
    start: `${month}-01`,
    end: `${month}-${pad2(new Date(y, m, 0).getDate())}`,
    prevEnd: `${py}-${pad2(pm)}-${pad2(new Date(py, pm, 0).getDate())}`,
  };
}

// The total displayed balance across `accounts` as of a date — each account's
// LAST snapshot on or before it, carried forward.
//
// Deliberately NOT netWorthSeries' fold. That one lets an account with no
// snapshot yet contribute 0, which is right for a net-worth line (there is
// nothing honest to claim for it) and WRONG here: a missing account would
// silently understate the balance total and manufacture a residual that reads
// as miscounting. Snapshots are written on balance CHANGE only and nothing
// backfills them, so "no row on or before this date" genuinely means unknown.
// So the total is null unless EVERY account resolves — null = can't see, never
// 0 = saw nothing.
//
// snapshots: [{ account_id, captured_on: 'YYYY-MM-DD', balance }] in the
// STORED convention (debts positive = owed), any order; the returned total is
// SIGNED (through displayBalance) — never run it through displayBalance again.
// Returns { date, total: number|null, missing: [accountId] }.
export function balancesAsOf(snapshots, accounts, dateISO) {
  const list = validAccounts(accounts);
  if (typeof dateISO !== 'string' || list.length === 0) {
    return { date: dateISO ?? null, total: null, missing: list.map(a => a.id) };
  }
  const typeById = new Map(list.map(a => [a.id, a.type]));
  // Latest snapshot per account at or before the date. The (account_id,
  // captured_on) unique index makes a same-date tie unreachable from the DB;
  // on garbage input the first one seen wins, which keeps the fold total.
  const best = new Map();
  for (const s of snapshots || []) {
    if (!s || !typeById.has(s.account_id)) continue;
    const on = s.captured_on;
    if (typeof on !== 'string' || on > dateISO) continue;
    const cur = best.get(s.account_id);
    if (!cur || on > cur.captured_on) best.set(s.account_id, s);
  }
  const missing = list.filter(a => !best.has(a.id)).map(a => a.id);
  if (missing.length) return { date: dateISO, total: null, missing };
  let total = 0;
  for (const a of list) total += displayBalance(best.get(a.id).balance, a.type);
  return { date: dateISO, total: total === 0 ? 0 : total, missing: [] };
}

// balancesAsOf totals exactly the accounts it is handed — it does NOT re-scope
// them. buildReconciliation passes the already-scoped list; a caller wanting a
// different set (a single account, say) gets that set's total.
function validAccounts(accounts) {
  return Array.isArray(accounts) ? accounts.filter(a => a && a.id) : [];
}

// Which bucket an UNCOUNTED row belongs to. DISPLAY LABELLING ONLY — whether a
// row is uncounted at all was already decided by isSpend/isIncome; this only
// names the reason, reusing effectiveTxType (the ONE deriver) so the label can
// never disagree with the type pill the same row shows in the Spending list.
//
// 'loan' is unreachable in practice (loan accounts are out of scope, so their
// rows are never classified) and falls to 'other' rather than inventing a
// bucket for a row whose balance is not in the total anyway.
export function classifyUncounted(t) {
  if (!t) return 'other';
  if (t.excluded) return 'excluded';
  const ty = effectiveTxType(t);
  if (ty === 'transfer') return 'transfer';
  if (ty === 'card_payment') return 'cardPayment';
  return 'other';
}

// ---------------------------------------------------------------------------
// GROSS FLOWS — where the money went, as opposed to what it netted to.
//
// Mason, 2026-08-29: "It looks like spending and income are just being compared
// to each other. What we want is spending being calculated by totaling spending
// transactions to be compared to the total money that left accounts (not
// transfers between accounts)."
//
// READ THIS BEFORE TREATING IT AS A SECOND MEASUREMENT. It is not one, and the
// reason is structural: `balance_snapshots` stores a scalar LEVEL per account
// per day, `accounts` stores only levels, and the SimpleFIN protocol ships no
// period totals — so gross debits and gross credits are algebraically
// unrecoverable from a balance difference (they differ by any k added to both
// halves). A gross figure can therefore only come from the ledger, which means
// this fold SPLITS EACH TERM of the identity above into its money-out and
// money-in halves; it adds no new external cross-check and `unexplained` is
// byte-identical with or without it. What it buys is CLASSIFICATION: every
// dollar that moved, and what we called it, so a dollar that left and belongs
// to no class is visible instead of averaged away.
//
// The payoff that justifies it on its own: `isSpend` admits NEGATIVE rows since
// refund netting and `sumSpending` adds them, so the reported Spending figure is
// ALREADY net — purchases minus refunds — and nothing in the app has ever shown
// that split. Same on the income side via returned income (`cashIncome` folds
// `-amount`). The standard fixture: 764.00 of purchases − 35.00 of refunds =
// the 729.00 every other screen prints.
//
// Sign note, easy to get backwards: positive `amount` is money OUT, and
// `deltaLedger = -Σ amount`, so `deltaLedger === moneyIn.total - moneyOut.total`
// — NOT the reverse. Property-pinned.
//
// NAME CLASH, deliberate and worth knowing before grepping: `moneyOut`/`moneyIn`
// appear on TWO different objects in this file. On a BUCKET (the `add()` tally)
// they are per-bucket magnitudes of the uncounted rows only. On `flows` they are
// the whole month's sections, every class, counted rows included. Same words
// because they mean the same thing in both places — the magnitude of what moved
// each way — but only the second pair totals the month.
export const FLOW_ORDER = ['spending', 'income', 'transfer', 'cardPayment', 'excluded', 'other'];

// Per-DIRECTION labels: the same class means two different things by sign, and
// that asymmetry is the whole point — "Purchases" out vs "Refunds" in is the
// split that was invisible before.
export const FLOW_LABELS = {
  spending: { out: 'Purchases', in: 'Refunds' },
  income: { out: 'Income sent back', in: 'Income' },
  transfer: { out: 'Moved to another account', in: 'Moved in from another account' },
  cardPayment: { out: 'Card payments made', in: 'Card payments received' },
  excluded: { out: 'Excluded by hand', in: 'Excluded by hand' },
  other: { out: 'Other uncounted', in: 'Other uncounted' },
};

// The classes whose money came back to another account the household owns, so
// it never left. Subtracted to get `leftAndStayedGone`.
export const INTERNAL_FLOW_CLASSES = ['transfer', 'cardPayment'];

// Which flow class a row belongs to. The ONE predicates answer first and
// `classifyUncounted` names the reason for everything they reject — so this is
// three lines by construction, and no rule is restated. An `excluded` row falls
// through both predicates into classifyUncounted's own first branch; a loan row
// lands in 'other' exactly as documented there.
export function classifyFlow(t) {
  if (!t) return 'other';
  if (isSpend(t)) return 'spending';
  if (isIncome(t)) return 'income';
  return classifyUncounted(t);
}

const finite = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// POSSIBLE MISSED TRANSFERS — the one over-count no balance check can ever see.
//
// A balance comparison catches DUPLICATION (the ledger claims movement that
// never happened, so the identity breaks). It is structurally blind to
// MISCLASSIFICATION: when a genuine transfer between two of the household's own
// accounts fails to pair, the money really did move, the identity holds
// perfectly, and yet the outflow counts as spending AND the inflow counts as
// income. That is the F1 double-count shape — $23k/quarter before the
// 2026-08-03 linked-boundary rewrite — and nothing in the app surfaces it.
//
// THE DAMAGE GATE is the sharpest guard here, and it is what keeps this from
// being a wording heuristic: a pair is only reported when `isSpend(out)` AND
// `isIncome(in)` — i.e. it is inflating both totals RIGHT NOW. That single
// condition eliminates, for free and without naming any of them, card payments
// (both legs are vetoed, so an unpaired one costs nothing), excluded rows, loan
// rows, purchase-vs-refund coincidences, and everything out of scope. It also
// makes the claim on screen precise: these rows are miscounted today.
//
// ELIGIBILITY MIRRORS cashFlow.js's pairing pool exactly — `excluded`, loan
// accounts, and any non-null `user_type` are skipped. The last one is not an
// optimization: `user_type` IS the human saying what a row is, and re-flagging
// a row someone already typed would undo the false-wash fix it exists for.
//
// Deliberately NO descriptor/wording gate. Wording-dependence is precisely what
// the linked-boundary model deleted; the descriptors are DISPLAYED so a human
// can judge in one glance, and displaying a string can never move a total.
//
// Provable emptiness worth knowing: for two same-month rows of identical amount
// on different accounts, both eligible, within the pairing window, Kuhn's
// maximum matching CANNOT leave both unmatched (an edge between two unmatched
// vertices contradicts maximality). So every `exact` hit is necessarily
// cross-month or outside the window. The region is still scanned — a hit there
// would mean the pairing itself broke, which is exactly what this surfaces.
export const NEAR_MISS_WINDOW_DAYS = 14;
export const NEAR_MISS_MIN_AMOUNT = 100;
export const NEAR_MISS_TOLERANCE_CAP = 1;
export const NEAR_MISS_TOLERANCE_RATE = 0.005;
export const NEAR_MISS_LIMIT = 8;

// Private, mirroring cashFlow.js's own helper. Not imported from there because
// an ISO->day-number conversion is mechanical, not a decision — the WINDOW is
// the decision, and that one is imported.
function dayNum(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) / 86400000;
}

const nearMissEligible = t =>
  t &&
  typeof t.id === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') &&
  Number.isFinite(Number(t.amount)) &&
  Number(t.amount) !== 0 &&
  // The cashFlow.js:50 mirror, stated explicitly so a future reader greps it.
  !t.excluded &&
  t.accounts?.type !== 'loan' &&
  t.user_type == null &&
  !t._internal;

const leg = t => ({
  id: t.id,
  date: t.date,
  month: t.date.slice(0, 7),
  amount: r2(Math.abs(Number(t.amount))),
  name: displayName(t) || t.description || '',
  accountId: t.account_id ?? null,
});

// rows: every fetched month concatenated — the straddling pair (out Jul 31, in
// Aug 2) is the commonest miss of all, and per-month pairing can never see it.
// Returns { pairs, total }; never throws, never mutates a row, deterministic.
export function nearMissTransfers(rows, { limit = NEAR_MISS_LIMIT, minAmount = NEAR_MISS_MIN_AMOUNT } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(nearMissEligible);
  const outs = list.filter(t => Number(t.amount) > 0 && Math.abs(Number(t.amount)) >= minAmount && isSpend(t));
  const ins = list.filter(t => Number(t.amount) < 0 && Math.abs(Number(t.amount)) >= minAmount && isIncome(t));
  if (!outs.length || !ins.length) return { pairs: [], total: 0 };

  const candidates = [];
  for (const o of outs) {
    const oa = r2(Math.abs(Number(o.amount)));
    const od = dayNum(o.date);
    for (const i of ins) {
      if (i.account_id === o.account_id) continue; // pairing requires two accounts
      const ia = r2(Math.abs(Number(i.amount)));
      const gap = dayNum(i.date) - od;
      const delta = r2(Math.abs(oa - ia));
      let tier = null;
      if (delta === 0 && Math.abs(gap) <= NEAR_MISS_WINDOW_DAYS) tier = 'exact';
      else if (
        delta > 0 &&
        delta <= Math.min(NEAR_MISS_TOLERANCE_CAP, oa * NEAR_MISS_TOLERANCE_RATE) &&
        Math.abs(gap) <= INTERNAL_MATCH_WINDOW_DAYS
      ) tier = 'near';
      // Each tier is tight in a DIFFERENT dimension — exact amounts get the
      // wide window, a sub-dollar discrepancy only gets the pairing window —
      // so neither is loose in both and "similar-ish" amounts never match.
      if (!tier) continue;
      candidates.push({
        key: `${o.id}|${i.id}`,
        amount: oa,
        delta,
        gapDays: gap,
        tier,
        crossMonth: o.date.slice(0, 7) !== i.date.slice(0, 7),
        out: leg(o),
        in: leg(i),
      });
    }
  }

  // Greedy, one use per row: without it a single recurring $500 inflow matches
  // every $500 outflow in the window and the section becomes noise. Sort is
  // total (no ties), so the output is deterministic under any input order.
  candidates.sort(
    (a, b) =>
      b.amount - a.amount ||
      Math.abs(a.gapDays) - Math.abs(b.gapDays) ||
      (a.tier === b.tier ? 0 : a.tier === 'exact' ? -1 : 1) ||
      (a.out.id < b.out.id ? -1 : a.out.id > b.out.id ? 1 : 0) ||
      (a.in.id < b.in.id ? -1 : a.in.id > b.in.id ? 1 : 0)
  );
  const used = new Set();
  const kept = [];
  for (const c of candidates) {
    if (used.has(c.out.id) || used.has(c.in.id)) continue;
    used.add(c.out.id);
    used.add(c.in.id);
    kept.push(c);
  }
  // `total` counts survivors, not raw candidates: "showing 8 of 40" would
  // overstate by counting overlaps the greedy walk already rejected.
  return { pairs: kept.slice(0, Math.max(0, limit)), total: kept.length };
}

const r2 = n => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v; // never -0: a "−$0.00" in a diagnostics panel reads as a bug
};

// Assemble the gross view from the per-class magnitudes the month's loop
// collected. Every figure is derived from the ROUNDED class amounts, so the
// column the panel prints always adds up on screen — a total rounded
// independently of its parts is how a reconciliation surface ends up visibly
// contradicting itself.
function buildFlows(gross, outOfScope) {
  const side = m => {
    const classes = FLOW_ORDER.filter(k => m.has(k)).map(k => {
      const g = m.get(k);
      return { key: k, amount: r2(g.amount), count: g.count };
    });
    return { total: r2(classes.reduce((a, c) => a + c.amount, 0)), classes };
  };
  const moneyOut = side(gross.out);
  const moneyIn = side(gross.in);
  const at = (s, k) => s.classes.find(c => c.key === k)?.amount ?? 0;

  // The reported Spending figure is net — this is the split nothing else shows.
  const purchases = at(moneyOut, 'spending');
  const refunds = at(moneyIn, 'spending');
  const incomeReceived = at(moneyIn, 'income');
  const incomeReturned = at(moneyOut, 'income');

  const internalOut = r2(INTERNAL_FLOW_CLASSES.reduce((a, k) => a + at(moneyOut, k), 0));
  const internalIn = r2(INTERNAL_FLOW_CLASSES.reduce((a, k) => a + at(moneyIn, k), 0));

  // "Left and stayed gone": money out, minus what moved between accounts the
  // household owns, minus what came back. Derived from the SAME class figures
  // the panel itemizes, so the headline sentence and the list below it can
  // never disagree — the alternative (grossOut − internalOut) is looser and
  // would leave the reader an unexplained gap to reconcile by hand.
  // Refunds are netted here (they are inside `spending`) and called out on
  // their own line, so the one difference this sentence can show is money in
  // no total at all: excluded rows and the catch-all.
  const spending = r2(purchases - refunds);
  const excludedNet = r2(at(moneyOut, 'excluded') - at(moneyIn, 'excluded'));
  const otherNet = r2(at(moneyOut, 'other') - at(moneyIn, 'other'));

  return {
    moneyOut,
    moneyIn,
    purchases,
    refunds,
    spending,
    incomeReceived,
    incomeReturned,
    income: r2(incomeReceived - incomeReturned),
    internalOut,
    internalIn,
    excludedNet,
    otherNet,
    leftAndStayedGone: r2(spending + excludedNet + otherNet),
    outOfScope: { spending: r2(outOfScope.spending), income: r2(outOfScope.income) },
  };
}

// Build the per-month reconciliation.
//
// monthsRows: [{ month: 'YYYY-MM', rows }] — rows for that CALENDAR MONTH, and
//   already run through markInternalTransfers over that same month window. The
//   window is load-bearing: getMonthTransactions pairs per calendar month, so
//   pairing over anything wider here (getCashFlow's 6-month fetch) would wash
//   different rows and this panel would quietly disagree with the Overview and
//   Categories numbers it exists to audit.
// snapshots: full history for the scope accounts (never a windowed fetch — an
//   account that hasn't moved inside the window has no rows in it, and its
//   absence would read as unknown and null out every month).
// accounts: the non-hidden account list; the builder scopes itself.
// today: 'YYYY-MM-DD' local — decides which month is still in progress.
//
// Returns { months: [...newest first], coverage: { earliestSnapshot,
// latestSnapshot } }. Degrades to an empty shape on garbage; never throws.
export function buildReconciliation({ monthsRows, snapshots, accounts, today } = {}) {
  const empty = {
    months: [],
    coverage: { earliestSnapshot: null, latestSnapshot: null },
    nearMiss: { pairs: [], total: 0 },
  };
  const scope = reconciliationScope(accounts);
  const scopeIds = new Set(scope.map(a => a.id));
  const snaps = (snapshots || []).filter(
    s => s && scopeIds.has(s.account_id) && typeof s.captured_on === 'string'
  );
  const dates = snaps.map(s => s.captured_on).sort();
  const coverage = {
    earliestSnapshot: dates[0] ?? null,
    latestSnapshot: dates[dates.length - 1] ?? null,
  };
  if (!Array.isArray(monthsRows) || monthsRows.length === 0) return { ...empty, coverage };

  const currentMonth = typeof today === 'string' ? today.slice(0, 7) : null;

  const months = monthsRows
    .map(entry => {
      if (!entry) return null;
      const edges = monthEdges(entry.month);
      if (!edges) return null;
      const partial = entry.month === currentMonth;

      // The month in progress has no month-end balance yet, so it reconciles
      // against the newest snapshot instead, with the rows sliced to match.
      // Requiring that snapshot to land INSIDE the month is what keeps the
      // window from collapsing to nothing when the app hasn't been opened yet
      // this month (last snapshot Aug 31, viewing September): a zero-length
      // window would compute a truthful-looking 0 = 0 that answers nothing.
      let asOfDate = edges.end;
      let usable = true;
      if (partial) {
        const latest = latestOnOrBefore(snaps, edges.end);
        if (latest && latest > edges.prevEnd) asOfDate = latest;
        else usable = false;
      }

      // Drop null entries up front: cashIncome/sumSpending read `.excluded`
      // off every row, so a null in the array would throw inside a fold that
      // real callers can never hand one to. This module's never-throw promise
      // is its own to keep.
      const all = (Array.isArray(entry.rows) ? entry.rows : []).filter(Boolean);
      // Slice AFTER pairing, on the date string: the _internal marks were made
      // over the whole month and stay valid — a leg whose partner falls after
      // the cutoff simply shows in the transfer bucket, which is the truth
      // (the money left one account and hasn't landed in the other yet).
      const rows =
        partial && usable && asOfDate !== edges.end
          ? all.filter(t => t && typeof t.date === 'string' && t.date <= asOfDate)
          : all;

      // The headline pair is the shared model's own fold over exactly these
      // rows — byte-identical to what Overview and Categories render for a
      // completed month, which is what makes a mismatch a bug and not a
      // second opinion.
      const income = cashIncome(rows);
      const spending = sumSpending(rows);
      const net = income - spending;

      const tally = new Map();
      // `amount` is the row's own direction (positive = money out) and drives
      // the moneyOut/moneyIn magnitudes; `impact` is its contribution to the
      // identity, passed separately because outOfScope's sign is inverted
      // relative to every other bucket.
      const add = (key, amount, impact) => {
        const b = tally.get(key) || { key, label: BUCKET_LABELS[key], impact: 0, moneyOut: 0, moneyIn: 0, count: 0 };
        b.impact += impact;
        if (amount > 0) b.moneyOut += amount;
        else b.moneyIn -= amount;
        b.count += 1;
        tally.set(key, b);
      };

      // The gross halves ride the SAME loop, deliberately: a second pass could
      // drift from deltaLedger the moment either one's guards changed, and the
      // panel's whole claim is that its itemization and its total describe the
      // same rows.
      const gross = { out: new Map(), in: new Map() };
      const outOfScope = { spending: 0, income: 0 };
      const addFlow = (side, key, magnitude) => {
        const m = gross[side];
        const g = m.get(key) || { key, amount: 0, count: 0 };
        g.amount += magnitude;
        g.count += 1;
        m.set(key, g);
      };

      let deltaLedger = 0;
      for (const t of rows) {
        if (!t) continue;
        const amount = finite(t.amount);
        if (!amount) continue; // both predicates reject these; a NaN must not poison a sum
        const inScope = scopeIds.has(t.account_id);
        const cls = classifyFlow(t);
        if (inScope) {
          deltaLedger -= amount;
          if (amount > 0) addFlow('out', cls, amount);
          else addFlow('in', cls, -amount);
          if (cls !== 'spending' && cls !== 'income') add(cls, amount, -amount);
        } else if (cls === 'spending' || cls === 'income') {
          // A counted row whose balance is not in the total — an investment or
          // 'other' account. Sign is inverted relative to the Z rows above:
          // this corrects the headline, it does not explain a balance move.
          // Unreachable in production (ACCOUNT_TYPES and api/sync.js's
          // ALLOWED_TYPES are depository|credit|loan), which is why it is kept
          // OUT of the gross totals: those describe the scope whose balances
          // the panel compares against. Tracked separately so
          // flows.spending + outOfScope.spending === the headline spending.
          add('outOfScope', amount, amount);
          if (cls === 'spending') outOfScope.spending += amount;
          else outOfScope.income += -amount;
        }
      }
      const flows = buildFlows(gross, outOfScope);

      const start = usable ? balancesAsOf(snaps, scope, edges.prevEnd) : null;
      const end = usable ? balancesAsOf(snaps, scope, asOfDate) : null;
      const deltaObserved =
        start && end && start.total !== null && end.total !== null ? end.total - start.total : null;

      return {
        month: entry.month,
        label: entry.label ?? entry.month,
        partial,
        income,
        spending,
        net,
        flows,
        deltaLedger,
        buckets: BUCKET_ORDER.filter(k => tally.has(k)).map(k => tally.get(k)),
        balanceStart: start,
        balanceEnd: end,
        deltaObserved,
        unexplained: deltaObserved === null ? null : deltaObserved - deltaLedger,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  // Over every fetched month's UNSLICED rows: a leg after the last snapshot is
  // outside the balance comparison but still double-counts in the totals, and
  // the straddling pair only exists when adjacent months are seen together.
  const nearMiss = nearMissTransfers(monthsRows.flatMap(e => (Array.isArray(e?.rows) ? e.rows : [])));

  return { months, coverage, nearMiss };
}

function latestOnOrBefore(snaps, dateISO) {
  let best = null;
  for (const s of snaps) {
    if (s.captured_on <= dateISO && (best === null || s.captured_on > best)) best = s.captured_on;
  }
  return best;
}
