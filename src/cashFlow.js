// Pure linked-boundary pairing + income (no Supabase/React/env) — importable
// from plain Node, e.g. by the CSV-import dry-run harness. dataAdapter.js
// re-exports the public pieces, so existing importers are unchanged.
//
// THE LINKED-BOUNDARY MODEL (Mason, 2026-08-03 — supersedes the old two-model
// design; see CLAUDE.md). Detection of "my own money moving between my own
// accounts" is STRUCTURAL, not descriptor-based: a positive (money out) row on
// one visible linked account pairs with a negative (money in) row of equal
// amount on a DIFFERENT visible linked account within the window, across ALL
// account-type combinations EXCEPT loan accounts, which never participate —
// a mortgage/auto payment's depository leg must stay unpaired and count as
// spending (the loan's own ledger rows are excluded by isLoanAccount instead).
// Both legs of a matched pair are `_internal`: excluded from income AND
// spending. The old gates — raw_category TRANSFER_IN/OUT wording on both legs,
// depository↔depository only — are GONE: wording-dependence let $23k/quarter
// of cross-bank ACH self-transfers count as spending and income (the F1
// double count), and the depository→credit restriction is unnecessary now that
// spending is unified (a washed card payment is exactly what "card payments
// never count" wants; the checking leg is no longer the counted proxy for card
// purchases — the purchases themselves count).
// Hidden accounts are excluded at the QUERY level, so their legs never enter
// pairing — a transfer to a hidden account is unpaired and counts as spending
// (hidden = outside the linked boundary, by decision).
import { sumSpending } from './spending.js';

const INTERNAL_MATCH_WINDOW_DAYS = 4;

function dayNumber(iso) {
  const [y, m, d] = (iso || '').split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) / 86400000;
}

// Exported so the CSV-import dry-run harness can verify washing against the
// real logic (a transfer pair cancels across CSV + feed legs).
export function markInternalTransfers(rows) {
  // Structural eligibility (see the header): every non-excluded row on a
  // non-loan account participates — positive rows as outs, negative as ins.
  // No raw_category / wording gate. A row missing the accounts join is treated
  // as non-loan, matching isLoanAccount's convention (and a single-account row
  // set can never pair with itself anyway).
  const outsByAmount = new Map();
  const insByAmount = new Map();
  for (const t of rows) {
    // A non-null user_type is an EXPLICIT verdict (the 4-type override,
    // 2026-08-15) — it never pairs. Dropping the row from the pool is the
    // whole transfer-override mechanism (isSpend/cashIncome read user_type
    // directly), and it is also what makes the false-wash fix work: override
    // one leg and its former partner re-derives structurally on the next
    // read (an unpaired depository inflow is income again).
    if (t.excluded || t.accounts?.type === 'loan' || t.user_type) continue;
    if (t.amount > 0) {
      pushTo(outsByAmount, t.amount.toFixed(2), t);
    } else if (t.amount < 0) {
      pushTo(insByAmount, (-t.amount).toFixed(2), t);
    }
  }

  // Match within each equal-amount bucket — amounts must be equal to pair, so
  // the buckets are independent and each stays small.
  for (const [amount, outs] of outsByAmount) {
    const ins = insByAmount.get(amount);
    if (!ins || !ins.length) continue;
    for (const [out, inn] of maxMatchTransfers(outs, ins)) {
      out._internal = true;
      inn._internal = true;
    }
  }
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Pair up equal-amount transfer legs, washing AS MANY genuine pairs as
// possible.
//
// The previous version walked the outs in date order and gave each one its
// nearest unused in. That is greedy, and a nearer partner taken early can
// strand a later pair whose only remaining partner is then outside the window:
// outs on the 4th and 9th with ins on the 1st and 6th have a perfect pairing
// (4↔1, 9↔6, both 3 days apart), but the 4th grabs the 6th (2 days) and the 9th
// is left with the 1st, 8 days away. One real transfer then stays counted,
// inflating BOTH Trends income and spending by the same amount.
//
// A maximum bipartite matching (Kuhn's augmenting paths — the same approach
// reconcileCsv uses for the statement audit) has no such ordering sensitivity:
// if a full pairing exists, it finds one.
function maxMatchTransfers(outs, ins) {
  // Deterministic order, so the same data always washes the same pairs
  // regardless of the order rows arrived from the database.
  const byRow = (a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
    String(a.account_id).localeCompare(String(b.account_id)) ||
    String(a.plaid_tx_id || a.id || '').localeCompare(String(b.plaid_tx_id || b.id || ''));
  const L = [...outs].sort(byRow);
  const R = [...ins].sort(byRow);

  // Candidate ins for each out, nearest first: among the maximum matchings, this
  // biases towards the most plausible (closest-dated) pairing.
  //
  // R is date-sorted, so the in-window candidates are a CONTIGUOUS slice — found
  // by binary search rather than by scanning every in for every out. Years of
  // imported history can put hundreds of same-amount transfers in one bucket,
  // and building the full product there would cost quadratic time on the main
  // thread every time Trends loads.
  //
  // Load-bearing invariant: `byRow` orders by the date STRING, and these are
  // canonical padded ISO (a Postgres `date not null` column), where lexicographic
  // order equals chronological order — so rDays below is non-decreasing and the
  // early `break` is safe. Keep byRow's first key the date if you touch it;
  // sorting by anything else first would silently truncate the candidate walk.
  const rDays = R.map(r => dayNumber(r.date));
  const firstFrom = target => {
    let lo = 0;
    let hi = rDays.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rDays[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const adj = L.map(out => {
    const od = dayNumber(out.date);
    const edges = [];
    for (let j = firstFrom(od - INTERNAL_MATCH_WINDOW_DAYS); j < R.length; j++) {
      const gap = rDays[j] - od;
      if (!(gap <= INTERNAL_MATCH_WINDOW_DAYS)) break; // sorted → nothing later fits
      if (R[j].account_id === out.account_id) continue;
      edges.push({ j, gap: Math.abs(gap) });
    }
    edges.sort((a, b) => a.gap - b.gap || a.j - b.j);
    return edges.map(e => e.j);
  });

  const matchOfIn = new Array(R.length).fill(-1);
  const matchOfOut = new Array(L.length).fill(-1);
  const augment = (i, seen) => {
    for (const j of adj[i]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (matchOfIn[j] === -1 || augment(matchOfIn[j], seen)) {
        matchOfIn[j] = i;
        matchOfOut[i] = j;
        return true;
      }
    }
    return false;
  };
  // Fewest candidates first — the constrained legs claim a partner before the
  // flexible ones do, which reaches a maximum matching with less backtracking.
  const order = L.map((_, i) => i).sort((a, b) => adj[a].length - adj[b].length || a - b);
  for (const i of order) {
    if (adj[i].length) augment(i, new Array(R.length).fill(false));
  }

  const pairs = [];
  for (let i = 0; i < L.length; i++) {
    if (matchOfOut[i] >= 0) pairs.push([L[i], R[matchOfOut[i]]]);
  }
  return pairs;
}

// --- The unified income/spending reads ---------------------------------------
// ONE model everywhere (Mason, 2026-08-03): Trends spending IS the shared
// isSpend() total — the same number as the Categories tab / Overview headline /
// envelopes, by construction. cashSpending stays exported under its old name so
// existing importers and harnesses keep working; it simply delegates.
export function cashSpending(txs) {
  return sumSpending(txs);
}

// Income = money into a depository (checking or savings) account from OUTSIDE
// the linked boundary: an unpaired depository inflow. Paired inflows are the
// household's own money arriving from another linked account and were washed
// by markInternalTransfers. Credit-account negatives are never income — they
// are payments received or refunds ("Return" via applyAccountRules).
// Exported for the CSV-import dry-run harness (see markInternalTransfers).
export function cashIncome(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded || t._internal) continue;
    if (t.accounts?.type !== 'depository' || t.amount >= 0) continue;
    // The 4-type override: any non-'inflow' verdict vetoes income; 'inflow'
    // (which also pulled the row out of the pairing pool) forces a
    // falsely-washed paycheck to count. The depository-only gate above stays
    // OUTSIDE the override — income counts depository inflows ONLY, so
    // 'inflow' on a credit negative behaves like Return: in neither total.
    if (t.user_type && t.user_type !== 'inflow') continue;
    total += Math.abs(t.amount);
  }
  return total;
}
