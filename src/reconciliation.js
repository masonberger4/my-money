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
import { isSpend, sumSpending, effectiveTxType } from './spending.js';
import { isIncome, cashIncome } from './cashFlow.js';
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

const finite = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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
  const empty = { months: [], coverage: { earliestSnapshot: null, latestSnapshot: null } };
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

      let deltaLedger = 0;
      for (const t of rows) {
        if (!t) continue;
        const amount = finite(t.amount);
        if (!amount) continue; // both predicates reject these; a NaN must not poison a sum
        const inScope = scopeIds.has(t.account_id);
        if (inScope) {
          deltaLedger -= amount;
          if (!isSpend(t) && !isIncome(t)) add(classifyUncounted(t), amount, -amount);
        } else if (isSpend(t) || isIncome(t)) {
          // A counted row whose balance is not in the total — an investment or
          // 'other' account. Sign is inverted relative to the Z rows above:
          // this corrects the headline, it does not explain a balance move.
          add('outOfScope', amount, amount);
        }
      }

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

  return { months, coverage };
}

function latestOnOrBefore(snaps, dateISO) {
  let best = null;
  for (const s of snaps) {
    if (s.captured_on <= dateISO && (best === null || s.captured_on > best)) best = s.captured_on;
  }
  return best;
}
