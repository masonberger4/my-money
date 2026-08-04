import { getServiceClient } from './supabase.js';
import { applyAccountRules } from '../../src/categoryMap.js';
import { displayBalance } from '../../src/accountBalance.js';
import { detectRecurring } from '../../src/recurring.js';
// THE unified spending model (Mason, 2026-08-03). This module is the assistant's
// only spending figure, so it reads the SAME pure core every screen reads —
// never a private fold. See the fold below for why that is load-bearing.
import { aggregateEnvelopeSpending, isSpend, spendingGroups } from '../../src/spending.js';
import { markInternalTransfers } from '../../src/cashFlow.js';
import { walkEnvelopes, shiftMonthKey } from '../../src/envelopes.js';
import { isRangeExhaustedError } from '../../src/ruleHistory.js';

function monthKey(dateStr) {
  return (dateStr || '').slice(0, 7);
}

// Missing-TABLE test only (the budget tables carry no optional columns this
// module reads, so the sync.js missing-column companion isn't needed here).
// Kept separate-and-narrow per the sync.js gotcha: a missing-column error names
// its table too, so a loose "mentions the table" check would misread one.
function isMissingTableError(error, table) {
  if (!error) return false;
  if (error.code === 'PGRST205' || error.code === '42P01') return true;
  const blob = `${error.message || ''} ${error.details || ''}`.toLowerCase();
  return (
    blob.includes(String(table).toLowerCase()) &&
    /could not find the table|relation .* does not exist/.test(blob)
  );
}

// Envelope inputs for formatSpendingContext, or null when the budget tables
// aren't installed / nothing is budgeted (section omitted either way).
//
// Cost decision (weighed, per the backlog): the full walk needs (a) a paginated
// budget_months read — same discipline as dataAdapter's getAssignmentsThrough,
// no date clamp, because dropping old assignment rows drops real dollars out of
// rollover balances — (b) one small budgets read, and (c) ONE paginated
// transactions read from the earliest assignment month (the already-fetched
// 90-day/1500-row context slice can't serve it: it's both too short for carry
// and row-capped, so "spent" would silently under-count). Each is a single
// bounded table read that grows only with budgeting history — the identical
// price the Budget tab pays on every load — so the full walk is included rather
// than a degraded assigned-only summary.
async function fetchBudgetInputs(supabase, householdId, visibleIds, year, month) {
  const targetKey = `${year}-${String(month).padStart(2, '0')}`;

  // (a) every assignment through the viewed month, paginated; (b) settings.
  const assignments = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('budget_months')
      .select('category, month, assigned')
      .eq('household_id', householdId)
      .lte('month', `${targetKey}-01`)
      .order('month', { ascending: true })
      .order('category', { ascending: true })
      .range(from, from + page - 1);
    if (error) {
      if (isRangeExhaustedError(error)) break; // 416 = end-of-data (exact page multiple)
      if (isMissingTableError(error, 'budget_months')) return null; // pre-migration
      throw error;
    }
    assignments.push(...(data || []));
    if (!data || data.length < page) break;
  }

  const { data: budgetRows, error: bErr } = await supabase
    .from('budgets')
    .select('category, monthly_limit, rollover, target_kind, target_date')
    .eq('household_id', householdId);
  if (bErr) {
    if (isMissingTableError(bErr, 'budgets')) return null;
    throw bErr;
  }
  const settings = (budgetRows || []).map(r => ({
    category: r.category,
    target: r.monthly_limit,
    targetKind: r.target_kind,
    targetDate: r.target_date,
    rollover: r.rollover,
  }));

  if (!assignments.length && !settings.length) return null; // nothing budgeted

  // (c) spending back to the earliest non-zero assignment (the walk can't use
  // anything older — mirrors dataAdapter.getEnvelopes), visible accounts only:
  // the pure layer never sees hidden rows.
  let earliestKey = targetKey;
  for (const row of assignments) {
    const key = String(row.month).slice(0, 7);
    if ((Number(row.assigned) || 0) !== 0 && key < earliestKey) earliestKey = key;
  }
  const spendTxs = [];
  if (visibleIds.length) {
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase
        .from('transactions')
        // description/merchant_name feed the unified isSpend()'s card-payment
        // veto; account_id feeds markInternalTransfers' different-account rule.
        .select('account_id, date, amount, description, merchant_name, mapped_category, user_category, excluded')
        .eq('household_id', householdId)
        .in('account_id', visibleIds)
        .gte('date', `${earliestKey}-01`)
        .lt('date', `${shiftMonthKey(targetKey, 1)}-01`)
        .order('date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + page - 1);
      if (error) {
        if (isRangeExhaustedError(error)) break; // 416 = end-of-data (exact page multiple)
        throw error;
      }
      spendTxs.push(...(data || []));
      if (!data || data.length < page) break;
    }
  }
  return { year, month, assignments, settings, spendTxs };
}

// Builds a compact plain-text snapshot of the household's finances for the
// assistant's context window. Kept deterministic (stable ordering, fixed
// formatting) so repeat requests produce byte-identical text — that's what
// makes prompt caching hit across the turns of a conversation.
//
// buildSpendingContext does the two queries (its only I/O) and delegates all
// formatting to formatSpendingContext, which is pure and covered by
// test/spendingContext.test.js for byte-determinism.
//
// The `new Date()` cutoff DOES reach the output text (as the partial-month
// marker), so the determinism contract is the one the recurring and envelope
// sections already live under: same DB state + same day ⇒ byte-identical. What
// must never happen is two same-state calls on one day differing — a
// wall-clock TIMESTAMP in the text would break exactly that; a date-only query
// boundary does not.
export async function buildSpendingContext(householdId) {
  const supabase = getServiceClient();

  const { data: accounts, error: acctErr } = await supabase
    .from('accounts')
    .select('id, name, nickname, mask, type, subtype, current_balance, hidden, institutions(name)')
    .eq('household_id', householdId)
    .order('type', { ascending: true })
    .order('name', { ascending: true });
  if (acctErr) throw acctErr;

  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceStr = since.toISOString().slice(0, 10);

  // Filter to visible accounts in the QUERY, not after: the 1500-row cap is
  // applied by the database, so post-filtering would let hidden rows eat the
  // budget. That became a real problem when SimpleFIN started landing a second,
  // hidden copy of the household's ledger alongside the Plaid one — half the
  // assistant's context would have been rows it then threw away.
  //
  // The user's EDITS come along too (user_category / user_description /
  // excluded): the assistant must describe the household's data as the
  // household has curated it, not as the feed delivered it.
  const visibleIds = accounts.filter(a => !a.hidden).map(a => a.id);
  let txs = [];
  if (visibleIds.length) {
    const { data, error: txErr } = await supabase
      .from('transactions')
      .select('account_id, date, amount, merchant_name, description, mapped_category, user_category, user_description, excluded')
      .eq('household_id', householdId)
      .in('account_id', visibleIds)
      .gte('date', sinceStr)
      .order('date', { ascending: false })
      // id as the tiebreak: `date` alone leaves same-day rows in whatever order
      // Postgres happens to return, which both reorders the transaction list and
      // (at the 1500 cap) can change WHICH rows arrive — the two ways the text
      // could differ for one DB state. Same ordering discipline as
      // fetchBudgetInputs' paged read.
      .order('id', { ascending: false })
      .limit(1500);
    if (txErr) throw txErr;
    txs = data || [];
  }

  // The envelope month is "now" in UTC — same clock discipline as `since`:
  // it shapes the queries and the section's month label, never a timestamp in
  // the text, so same DB state + same day ⇒ same bytes.
  const now = new Date();
  const budget = await fetchBudgetInputs(
    supabase,
    householdId,
    visibleIds,
    now.getUTCFullYear(),
    now.getUTCMonth() + 1
  );

  // `since` travels into the text: the oldest calendar month of a rolling
  // 90-day window is partial, and the formatter must be able to SAY so rather
  // than print it as a complete month (see partialMonth there).
  return formatSpendingContext(accounts, txs, { budget, since: sinceStr });
}

// Pure formatter: rows in (the exact column shapes the queries above select),
// deterministic text out. Same accounts + same transactions ⇒ byte-identical
// output — any change here must preserve that, or prompt caching stops
// hitting.
// extras.budget (optional): { year, month, assignments, settings, spendTxs }
// from fetchBudgetInputs. null/absent omits the envelope section (pre-migration
// or nothing budgeted). All new sections stay pure and deterministic: the
// recurring clock is the newest transaction date (below), the envelope walk is
// the pure walkEnvelopes, and every list is stably sorted.
export function formatSpendingContext(accounts, txs, extras = {}) {
  const visible = (accounts || []).filter(a => !a.hidden);
  const acctById = new Map((accounts || []).map(a => [a.id, a]));

  // Loan-account debits are loan payments, not purchases — the cash that paid
  // them already counts on its way out of checking (isSpend's own loan guard
  // agrees; dropping them here also keeps them out of the listing and the
  // recurring detector). Excluded transactions are the user saying "don't count
  // this"; honour it.
  const loanIds = new Set(visible.filter(a => a.type === 'loan').map(a => a.id));
  const usable = (txs || [])
    .filter(t => !loanIds.has(t.account_id) && !t.excluded)
    // Effective category: the user's override wins over the account rules.
    // These are COPIES, which is what lets the pairing pass below stamp
    // `_internal` without mutating the caller's rows.
    .map(t => ({
      ...t,
      // The accounts join every consumer of the shared model expects
      // (isSpend's loan guard + credit-card-purchase guard,
      // markInternalTransfers' loan exclusion). Rows whose account is missing
      // read as non-loan/non-credit, the same convention isLoanAccount uses.
      accounts: { type: acctById.get(t.account_id)?.type },
      mapped_category:
        t.user_category ||
        applyAccountRules(t.mapped_category, t.amount, acctById.get(t.account_id)?.type),
    }));

  // Bucket by month BEFORE pairing, then pair WITHIN each month — because the
  // screens this section claims to match do exactly that: getSpending and
  // getOverview go through getMonthTransactions, which fetches ONE calendar
  // month and runs markInternalTransfers over precisely those rows.
  //
  // Pairing the whole 90-day slice at once is not the same window, and the
  // difference is not symmetric: a wider window washes MORE, never less. An
  // end-of-month sweep — $3,000 out of checking on 07-31, into savings on
  // 08-02 — is ONE washed pair across 90 days but TWO unpaired legs across two
  // month fetches, so July would read $3,000 lower here than on the Overview
  // headline, and the header sentence below promises the opposite.
  //
  // What this deliberately keeps is the month views' own honest window edge: a
  // pair straddling a month boundary stays unpaired on both sides and each leg
  // counts — the same verdict the one model gives any pair crossing a boundary
  // it cannot see across, and the behaviour dataAdapter's getBiggestMovers
  // documents for its month windows. Matching the screens means matching that
  // too, not just the easy cases.
  const byMonth = new Map();
  for (const t of usable) {
    const key = monthKey(t.date);
    const list = byMonth.get(key);
    if (list) list.push(t);
    else byMonth.set(key, [t]);
  }
  // isSpend() reads `_internal`, and the marks land on the `usable` copies —
  // so the transaction list's "not counted as spending" marker further down
  // agrees with these totals by construction, instead of being a second
  // judgement made over a different window. Deterministic per bucket (sorted
  // inputs, maximum matching), so byte-determinism holds.
  for (const monthRows of byMonth.values()) markInternalTransfers(monthRows);

  // The rolling window starts mid-month, so its OLDEST calendar month is
  // PARTIAL (May 6–31, not May) while being emitted in the same
  // `- YYYY-MM cat: $N` shape as every complete month. The header below tells
  // the model to quote these totals as the app's own figure, so an unmarked
  // partial row answers "what did I spend on groceries in May?" with a number
  // the Categories tab contradicts for that same month. Mark it on the ROWS,
  // not only in a header the model has left far behind by line 40.
  // `since` is the query cutoff (YYYY-MM-DD); absent ⇒ nothing is claimed.
  const since = extras.since || null;
  const partialMonth = since && since.slice(8) !== '01' ? since.slice(0, 7) : null;

  const lines = [];

  lines.push('## Accounts');
  // Balances are stated exactly as the dashboard shows them — credit cards and
  // loans negative, because that is money owed. Without this the assistant
  // would quote a card as +$5,127.97 while the screen reads −$5,127.97.
  lines.push('Credit card and loan balances are negative: that is the amount owed.');
  for (const a of visible) {
    const label = a.nickname || `${a.name}${a.mask ? ` ··${a.mask}` : ''}`;
    const inst = a.institutions?.name || 'Unknown bank';
    lines.push(
      `- ${label} (${inst}, ${a.subtype || a.type}): balance $${displayBalance(a.current_balance, a.type).toFixed(2)}`
    );
  }

  lines.push('');
  lines.push('## Monthly spending by category (last 90 days)');
  // "Amounts" here means TRANSACTION amounts, which use the opposite rule from
  // the account balances listed above — spell that out so the model can't
  // conflate the two. The rest of the sentence states the CURRENT model: since
  // 2026-08-03 internal is decided by STRUCTURE (the pairing), so an unpaired
  // transfer-worded row is real spending and only the card-payment verdict
  // vetoes. The old wording told the model to drop the transfer category
  // wholesale, which is now wrong in both directions.
  lines.push('Transaction amounts (unlike the balances above): positive is money out. These totals already apply the app\'s spending rule, the same one the dashboard uses: money in never counts (that includes "Return"), card payments never count, and a transfer counts UNLESS it was matched to an equal-amount opposite leg on another of the household\'s own visible accounts. Quote these totals rather than re-adding the transaction rows below.');
  if (partialMonth) {
    lines.push(
      `The window starts ${since}, so ${partialMonth} is INCOMPLETE: its lines below cover ${since} to the end of that month only, and its earlier days are missing. Say so if you quote them — never present ${partialMonth} as a full month's total.`
    );
  }
  // The fold is the SHARED one. It used to be a private loop here — every
  // positive row on a non-loan account counted — which meant the assistant
  // counted washed self-transfers and card payments that the screens exclude,
  // contradicting the dashboard (CLAUDE.md: this file "must match or the Ask
  // tab contradicts the screen"). spendingGroups applies isSpend() and
  // effectiveCategory; the per-month buckets (and their per-month pairing) were
  // built above, where the reasoning for that window lives.
  //
  // Month ascending, then category — the section's long-standing order (the
  // amount-desc order spendingGroups returns is the Categories tab's concern).
  // Plain string comparison, never localeCompare: the output must not depend on
  // the serverless instance's locale data.
  const byLabel = (a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  for (const month of [...byMonth.keys()].sort()) {
    const partial = month === partialMonth ? ` (partial month: ${since} onward only)` : '';
    for (const g of spendingGroups(byMonth.get(month)).sort(byLabel)) {
      lines.push(`- ${month} ${g.label}: $${g.amount.toFixed(2)}${partial}`);
    }
  }

  // --- Recurring subscriptions -----------------------------------------------
  // detectRecurring runs over the SAME edit-honoring rows as everything above
  // (excluded/loan rows already dropped, user_category/user_description already
  // applied), adapted to the toTxShape field names it expects. The due-status
  // clock is the NEWEST TRANSACTION DATE in the context — not wall-clock
  // Date.now() — so the whole section is a pure function of the queried rows:
  // same DB state ⇒ same bytes, even across days. (The context already embeds
  // dates, so a day rollover changing the QUERY window may change the rows and
  // therefore the text; what must never happen is two same-state calls
  // differing, and a wall clock in the output would break exactly that.)
  lines.push('');
  lines.push('## Recurring charges (detected from the transactions below)');
  let maxDate = '';
  for (const t of usable) if (t.date && t.date > maxDate) maxDate = t.date;
  const recurring = detectRecurring(
    usable.map(t => ({
      merchant_name: t.user_description || t.merchant_name,
      description: t.description,
      transaction_date: t.date,
      amount: Number(t.amount),
      category: t.mapped_category,
      account_id: t.account_id,
    })),
    maxDate || null
  )
    // Stable order: amount desc, then key — detectRecurring's own sort leaves
    // equal-amount ties in Map insertion order, which follows row order.
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!recurring.length) {
    lines.push('None detected.');
  } else {
    lines.push(`Due dates are relative to the newest transaction (${maxDate}).`);
    for (const r of recurring) {
      // monthlyAmount is the PER-CHARGE median — suffix by cadence, or a
      // weekly box would read as a monthly cost (still deterministic: the
      // cadence is a pure function of the same rows).
      const per = r.cadence === 'weekly' ? 'wk' : r.cadence === 'annual' ? 'yr' : 'mo';
      const bits = [
        `- ${r.name}: ~$${r.monthlyAmount.toFixed(2)}/${per} (${r.category}, every ~${r.avgGapDays} days, last ${r.lastDate}, next ~${r.nextDate})`,
      ];
      if (r.priceCreep) bits.push(`price increased: was $${r.medianAmount.toFixed(2)}, now $${r.lastAmount.toFixed(2)}`);
      if (r.dueStatus) bits.push(r.dueStatus === 'overdue' ? 'overdue' : 'due soon');
      lines.push(bits.join(' — '));
    }
  }

  // --- Budget envelopes ------------------------------------------------------
  const budget = extras.budget || null;
  if (budget) {
    // Spending rows need accounts.type for isSpend's loan guard; attach it
    // from the accounts already in hand, run the SAME linked-boundary pairing
    // the app runs (markInternalTransfers is deterministic — sorted inputs —
    // so byte-determinism holds), then aggregate through the SAME pure fold
    // the Budget tab uses so Spent can never disagree with it.
    const spendRows = (budget.spendTxs || []).map(t => ({
      ...t,
      accounts: { type: acctById.get(t.account_id)?.type },
    }));
    markInternalTransfers(spendRows);
    const spending = aggregateEnvelopeSpending(spendRows);
    const walk = walkEnvelopes({
      assignments: budget.assignments || [],
      spending,
      settings: budget.settings || [],
      year: budget.year,
      month: budget.month,
    });
    lines.push('');
    lines.push(`## Budget envelopes (${walk.month})`);
    lines.push('Envelope model: available = assigned + carried over - spent. Assigned/target are budget dollars (positive); spent is money out this month. A negative available is overspending carried in the category.');
    for (const r of walk.categories) {
      let target = '';
      if (r.target != null) {
        target =
          r.targetKind === 'by_date'
            ? `, target $${Number(r.target).toFixed(2)} by ${String(r.targetDate || '').slice(0, 7)}`
            : `, target $${Number(r.target).toFixed(2)}/mo`;
      }
      lines.push(
        `- ${r.category}: assigned $${r.assigned.toFixed(2)}, carried $${r.rolledOver.toFixed(2)}, spent $${r.spent.toFixed(2)}, available $${r.available.toFixed(2)}${target}`
      );
    }
    const t = walk.totals;
    lines.push(
      `Totals: assigned $${t.assigned.toFixed(2)}, carried $${t.rolledOver.toFixed(2)}, spent $${t.spent.toFixed(2)}, available $${t.available.toFixed(2)}`
    );
  }

  lines.push('');
  lines.push('## Transactions (last 90 days, newest first)');
  // The trailing marker is what keeps a model that re-adds the rows from
  // landing on a different number than the totals above: without it, a washed
  // transfer leg and a card payment are indistinguishable from purchases now
  // that categories carry no such hint. Only money-OUT rows are marked (a
  // negative amount is money in, which the header already covers), so the
  // suffix is rare and costs almost nothing in the context window.
  lines.push('Format: date | account | name | category | amount — a trailing "| not counted as spending" marks a money-out row the rule above excludes (a matched internal transfer or a card payment).');
  for (const t of usable) {
    const a = acctById.get(t.account_id);
    const acctLabel = a?.nickname || `${a?.name || 'Account'}${a?.mask ? ` ··${a.mask}` : ''}`;
    const name = t.user_description || t.merchant_name || t.description || 'Card transaction';
    const skipped = Number(t.amount) > 0 && !isSpend(t);
    lines.push(
      `${t.date} | ${acctLabel} | ${name} | ${t.mapped_category || 'Uncategorized'} | $${Number(t.amount).toFixed(2)}${skipped ? ' | not counted as spending' : ''}`
    );
  }

  return lines.join('\n');
}
