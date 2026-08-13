// THE spending model — one model since the 2026-08-03 unification, so the old
// "purchase-based" name (which distinguished it from a second, cash-flow model
// that no longer exists) is gone. Extracted pure (no Supabase/React) so it
// is importable from plain Node — the same move that produced cashFlow.js,
// envelopes.js and taxReport.js. dataAdapter.js does the I/O and delegates
// here; it re-exports these helpers so existing importers keep working.
//
// IMPORTANT SCOPE NOTE: hidden-account exclusion is NOT here, deliberately.
// It lives at the QUERY level (`accounts!inner … .eq('accounts.hidden',
// false)` in dataAdapter.js), so this layer never sees hidden rows in
// production. Do not add a hidden check to isSpend — the decided design is
// that every read the totals are built from already receives only unhidden
// rows (test/helpers/ledger.js models that contract with visibleRows()).
//
// Rows are expected in the post-join query shape: the raw transaction columns
// plus `t.accounts = { type, subtype, … }` from the accounts join. toTxShape's
// `counted` needs accounts.type (see isLoanAccount); a row missing the join is
// treated as non-loan — every caller of toTxShape selects accounts.type.

import { UNCATEGORIZED, TRANSFER_CATEGORY } from './categoryMap.js';
import { isCardPaymentDescriptor } from './txClassify.js';

// User override wins over the classifier's answer.
export function effectiveCategory(t) {
  return t.user_category || t.mapped_category || UNCATEGORIZED;
}

// Some banks send masked descriptors ("****** *********"). Treat those as
// empty so the UI falls through to something readable.
function looksMasked(s) {
  return !!s && /^[\s*·.xX_-]+$/.test(s);
}

// The bank's own name for the row, with no user override applied — the
// counterpart to mapped_category, and what "reset name" falls back to.
export function bankName(t) {
  const merchant = looksMasked(t.merchant_name) ? '' : t.merchant_name;
  const desc = looksMasked(t.description) ? '' : t.description;
  return merchant || desc || 'Card transaction';
}

export function displayName(t) {
  return t.user_description || bankName(t);
}

// A debit on a LOAN account is loan accounting (a suspense posting, a
// reversal), not a purchase — and by the linked-boundary model's own decision
// the COUNTED leg of a mortgage/auto payment is the depository outflow that
// paid it (loan accounts never participate in transfer pairing, so that leg
// stays unpaired and counts). Counting the loan's own ledger too would
// double-count every payment. SimpleFIN ships the servicer's real transaction
// list, so this guard is load-bearing. It guards `loan` ONLY: credit-card
// *purchases* are exactly what spending measures.
export function isLoanAccount(t) {
  return t.accounts?.type === 'loan';
}

// The card-payment veto — the ONE category-shaped exclusion the linked-boundary
// model keeps (Mason, 2026-08-03): a card payment never counts as spending,
// even when its card is unlinked/hidden so structural pairing cannot wash it.
// An explicit user pick of "Transfers and card payments" is honored as the
// same verdict (user edits win); any OTHER explicit user category means the
// row counts whatever its wording says. A positive amount on a credit account
// is a purchase by definition (a payment arrives as money in), so the
// descriptor test is skipped there — same guard as txClassify's write path.
function isCardPaymentRow(t) {
  if (t.user_category) return t.user_category === TRANSFER_CATEGORY;
  if (t.accounts?.type === 'credit') return false;
  return isCardPaymentDescriptor(t.description) || isCardPaymentDescriptor(t.merchant_name);
}

// THE spending test of the unified linked-boundary model (Mason, 2026-08-03).
// Every surface goes through it — Categories tab, Overview headline, budgets,
// envelopes, toTxShape's `counted`, AND Trends (cashSpending delegates to
// sumSpending) — so no two screens can disagree on spending by construction.
// Positive = money out. Counts: card purchases, depository outflows, transfers
// that LEAVE the linked boundary (to an unlinked or hidden account — they
// arrive here unpaired), and the depository leg of a loan payment. Never
// counts: rows washed by markInternalTransfers (`_internal` — an equal-amount
// counter-leg exists on another visible linked account; run the pairing before
// aggregating, or boundary-internal transfers will count), card payments
// (isCardPaymentRow, paired or not), loan accounts' own ledger rows, excluded
// rows, and money in (which is where "Return" lands — credit negatives are
// never spending or income). NOTE the narrowed meaning of "Transfers and card
// payments": the CATEGORY no longer excludes a row — internal is decided by
// structure, and only the card-payment verdict vetoes an unpaired row. An
// unpaired transfer-worded row crossed the boundary and counts (it shows in
// Categories under the transfer label — visible, like Uncategorized).
export function isSpend(t) {
  if (t.excluded || t._internal || isLoanAccount(t)) return false;
  if (t.amount <= 0) return false;
  return !isCardPaymentRow(t);
}

export function sumSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (isSpend(t)) total += t.amount;
  }
  return total;
}

// The Categories-tab bucketing: per-category amounts/counts over isSpend()
// rows, largest first. Exactly what getSpending() returns as `groups`.
export function spendingGroups(txs) {
  const buckets = new Map();
  let total = 0;

  for (const t of txs) {
    if (!isSpend(t)) continue;
    const cat = effectiveCategory(t);
    if (!buckets.has(cat)) buckets.set(cat, { amount: 0, count: 0 });
    const b = buckets.get(cat);
    b.amount += t.amount;
    b.count += 1;
    total += t.amount;
  }

  return Array.from(buckets.entries())
    .map(([label, b]) => ({
      label,
      amount: b.amount,
      transaction_count: b.count,
      percent_of_total: total ? (b.amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

// The Trends "Biggest movers" core: per-category month-over-month deltas.
// Both row sets go through spendingGroups (and therefore the ONE unified
// isSpend(), which reads `_internal` — rows must arrive already
// markInternalTransfers-marked, like every isSpend consumer); the caller
// supplies each month's rows already sliced (this layer doesn't inspect
// dates, same contract as spendingGroups). A category present in only one month still shows: absent
// means $0, so a brand-new category is a rise from 0 and a disappeared one is
// a fall to 0. delta = curr − prev, so positive = MORE money spent.
//
// Cutoff (decided): the top `limit` (5) categories by |delta|, skipping any
// delta under `minDelta` ($1) — sub-dollar drift is noise at monthly grain and
// would let a $0.40 wobble occupy a slot. Ties in |delta| break alphabetically
// so the same data always renders the same list.
export function biggestMovers(currRows, prevRows, { limit = 5, minDelta = 1 } = {}) {
  const curr = new Map(spendingGroups(currRows).map(g => [g.label, g.amount]));
  const prev = new Map(spendingGroups(prevRows).map(g => [g.label, g.amount]));
  const movers = [];
  for (const label of new Set([...curr.keys(), ...prev.keys()])) {
    const c = curr.get(label) || 0;
    const p = prev.get(label) || 0;
    const delta = c - p;
    if (Math.abs(delta) < minDelta) continue;
    movers.push({ label, curr: c, prev: p, delta });
  }
  movers.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.label.localeCompare(b.label)
  );
  return movers.slice(0, limit);
}

export function toTxShape(t) {
  return {
    id: t.id,
    plaid_tx_id: t.plaid_tx_id,
    account_id: t.account_id,
    merchant_name: displayName(t),
    description: t.description,
    transaction_date: t.date,
    amount: t.amount,
    category: effectiveCategory(t),
    auto_category: t.mapped_category || UNCATEGORIZED,
    // The un-overridden name, so an optimistic rename (or its reset) can
    // recompute `merchant_name` locally the same way displayName() does.
    // Without it the collapse into `merchant_name` is lossy and a list that is
    // never refetched — search results, the account sheet — keeps the old name.
    auto_description: bankName(t),
    user_category: t.user_category || null,
    user_description: t.user_description || null,
    excluded: !!t.excluded,
    // The row's OWN rental assignment (null = inherit the account's default —
    // resolve against accounts.entity_id where the effective value matters).
    entity_id: t.entity_id ?? null,
    is_capital: !!t.is_capital,
    placed_in_service: t.placed_in_service ?? null,
    useful_life_years: t.useful_life_years ?? null,
    // Whether this row is one of the dollars a category bar / envelope Spent is
    // made of. It rides along rather than being re-derived in the UI so a
    // category drill-in's own total can never disagree with the number that was
    // tapped to open it — same reason getEnvelopeSpending aggregates on
    // isSpend() instead of its own copy of the rule. Every caller of toTxShape
    // selects accounts.type, which isLoanAccount() needs. isSpend also reads
    // `_internal`, so `counted` is only fully accurate on rows that went
    // through markInternalTransfers (the month lists do; the single-account
    // sheet and search results cannot pair and may over-report `counted` on a
    // boundary-internal transfer leg — their lists don't render it).
    counted: isSpend(t),
  };
}

// Merge an EDIT into an already-shaped row (toTxShape output) — the optimistic
// patch. The two fields toTxShape DERIVES are recomputed here, the same way it
// derives them, so a caller can't update the raw column and leave the derived
// one stale on screen (the shipped "a rename never appeared" / "a category
// change made from search never appeared" bugs — the saveTx Gotcha in
// CLAUDE.md):
//   category      = user_category || auto_category      (effectiveCategory)
//   merchant_name = user_description || auto_description (displayName)
// `counted` is deliberately NOT recomputed — isSpend needs accounts.type,
// which the shape doesn't carry. Its one reader (CategorySheet) must render
// from a list that gets refetched (`transactions`, via reloadData).
export function patchTxShape(t, fields) {
  const next = { ...t, ...fields };
  if ('user_category' in fields) next.category = fields.user_category || t.auto_category;
  if ('user_description' in fields) next.merchant_name = fields.user_description || t.auto_description;
  return next;
}

// The envelope-spending fold: per-(category, month) spend sums over the same
// isSpend() predicate the Categories bars use, so an envelope's Spent can
// never disagree with the bar rendered beside it. Keyed 'YYYY-MM' + category,
// sliced at a fixed offset rather than split on a separator — category labels
// contain spaces ("Coffee and snacks"). getEnvelopeSpending() delegates here.
export function aggregateEnvelopeSpending(rows) {
  const byKey = new Map();
  for (const t of rows) {
    if (!isSpend(t)) continue;
    const key = `${(t.date || '').slice(0, 7)}${effectiveCategory(t)}`;
    byKey.set(key, (byKey.get(key) || 0) + t.amount);
  }
  const spending = [];
  for (const [key, amount] of byKey) {
    spending.push({ category: key.slice(7), month: key.slice(0, 7), spent: amount });
  }
  return spending;
}
