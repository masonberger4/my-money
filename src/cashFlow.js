// Pure cash-flow model (no Supabase/React/env) — importable from plain Node,
// e.g. by the CSV-import dry-run harness. dataAdapter.js re-exports the public
// pieces, so existing importers are unchanged.

// Mark both legs of a transfer between the household's own deposit accounts
// (BECU checking ↔ savings) as `_internal` so cash-flow totals skip them.
// A Plaid TRANSFER_OUT on one depository account pairs with a TRANSFER_IN on a
// *different* depository account of the same amount within a few days (legs
// often post on different days). Restricting to TRANSFER_IN/OUT legs and to
// depository↔depository leaves real income (an unmatched deposit that merely
// arrives tagged TRANSFER_IN) and credit-card payments (checking → credit,
// which IS cash leaving checking) counted.
const INTERNAL_MATCH_WINDOW_DAYS = 4;

function dayNumber(iso) {
  const [y, m, d] = (iso || '').split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) / 86400000;
}

// Exported so the CSV-import dry-run harness can verify washing against the
// real logic (a personal↔joint transfer pair cancels across CSV + Plaid legs).
export function markInternalTransfers(rows) {
  // Eligibility is unchanged: a depository TRANSFER_OUT pairs with a depository
  // TRANSFER_IN of equal amount, on a DIFFERENT account, within the window.
  // Keep the depository↔depository restriction tight — matching a
  // depository→credit leg would wrongly wash out card payments (which
  // cashSpending must count) and unmatched real-income deposits.
  const outsByAmount = new Map();
  const insByAmount = new Map();
  for (const t of rows) {
    if (t.excluded || t.accounts?.type !== 'depository') continue;
    const raw = (t.raw_category || '').toUpperCase();
    if (t.amount > 0 && raw.startsWith('TRANSFER_OUT')) {
      pushTo(outsByAmount, t.amount.toFixed(2), t);
    } else if (t.amount < 0 && raw.startsWith('TRANSFER_IN')) {
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

// --- Trends cash flow (joint-budget view) ------------------------------------
// The Trends "income vs spending" chart measures cash moving through the
// household's *joint* accounts, treated as one budget:
//   income   = money arriving in the joint checking OR savings accounts
//   spending = money leaving the joint checking account (expenses are paid from
//              checking; money leaving savings is never an expense)
// Transfers between the joint checking and joint savings wash out
// (markInternalTransfers), so moving money to savings isn't "spending" and
// moving it back isn't "income". Money the household moves in from its own
// *personal* accounts (not connected to Plaid) has no matching leg to wash
// against, so it counts as income — deliberate: with only the joint accounts
// synced, funding the joint budget from a personal account is the closest thing
// to measurable income (real paychecks land in the un-connected personal
// accounts). Credit-card *purchases* are not counted here — the card *payment*
// that leaves checking is (that's the cash actually spent). This is deliberately
// different from the Categories tab / Overview headline (sumSpending in
// dataAdapter.js), which break spending down by what was purchased so
// per-category budgets work.
function isHouseholdDepository(t) {
  // Any connected depository account (checking or savings) — the joint budget.
  return t.accounts?.type === 'depository';
}

function isCheckingAccount(t) {
  // Depository and not the savings pot. Lenient on subtype so a null/oddly
  // typed primary account still counts; only "savings" is treated as separate.
  return t.accounts?.type === 'depository' && t.accounts?.subtype !== 'savings';
}

// Expenses are paid from checking only; savings outflows are not spending.
// Exported for the CSV-import dry-run harness (see markInternalTransfers).
export function cashSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded || t._internal) continue;
    if (isCheckingAccount(t) && t.amount > 0) total += t.amount;
  }
  return total;
}

// Income is money into either joint account (checking or savings). Savings is
// included so income that arrives via savings — money moved in from a personal
// account — is not missed.
// Exported for the CSV-import dry-run harness (see markInternalTransfers).
export function cashIncome(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.excluded || t._internal) continue;
    if (isHouseholdDepository(t) && t.amount < 0) total += Math.abs(t.amount);
  }
  return total;
}
