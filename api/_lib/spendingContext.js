import { getServiceClient } from './supabase.js';
import { applyAccountRules } from '../../src/categoryMap.js';
import { displayBalance } from '../../src/accountBalance.js';

function monthKey(dateStr) {
  return (dateStr || '').slice(0, 7);
}

// Builds a compact plain-text snapshot of the household's finances for the
// assistant's context window. Kept deterministic (stable ordering, fixed
// formatting) so repeat requests produce byte-identical text — that's what
// makes prompt caching hit across the turns of a conversation.
export async function buildSpendingContext(householdId) {
  const supabase = getServiceClient();

  const { data: accounts, error: acctErr } = await supabase
    .from('accounts')
    .select('id, name, nickname, mask, type, subtype, current_balance, hidden, institutions(name)')
    .eq('household_id', householdId)
    .order('type', { ascending: true })
    .order('name', { ascending: true });
  if (acctErr) throw acctErr;

  const visible = accounts.filter(a => !a.hidden);
  const acctById = new Map(accounts.map(a => [a.id, a]));

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
  const visibleIds = visible.map(a => a.id);
  let txs = [];
  if (visibleIds.length) {
    const { data, error: txErr } = await supabase
      .from('transactions')
      .select('account_id, date, amount, merchant_name, description, mapped_category, user_category, user_description, excluded')
      .eq('household_id', householdId)
      .in('account_id', visibleIds)
      .gte('date', sinceStr)
      .order('date', { ascending: false })
      .limit(1500);
    if (txErr) throw txErr;
    txs = data || [];
  }

  // Loan-account debits are loan payments, not purchases — the cash that paid
  // them already counts on its way out of checking (mirrors sumSpending).
  // Excluded transactions are the user saying "don't count this"; honour it.
  const loanIds = new Set(visible.filter(a => a.type === 'loan').map(a => a.id));
  const usable = txs.filter(t => !loanIds.has(t.account_id) && !t.excluded);
  for (const t of usable) {
    // Effective category: the user's override wins over the account rules.
    t.mapped_category = t.user_category || applyAccountRules(
      t.mapped_category,
      t.amount,
      acctById.get(t.account_id)?.type
    );
  }

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
  // conflate the two.
  lines.push('Transaction amounts (unlike the balances above): positive is money out; "Transfers and card payments" and "Return" are not real spending.');
  const byMonthCat = new Map();
  for (const t of usable) {
    if (t.amount <= 0) continue;
    const key = `${monthKey(t.date)}|${t.mapped_category || 'Uncategorized'}`;
    byMonthCat.set(key, (byMonthCat.get(key) || 0) + Number(t.amount));
  }
  const sortedKeys = [...byMonthCat.keys()].sort();
  for (const key of sortedKeys) {
    const [month, cat] = key.split('|');
    lines.push(`- ${month} ${cat}: $${byMonthCat.get(key).toFixed(2)}`);
  }

  lines.push('');
  lines.push('## Transactions (last 90 days, newest first)');
  lines.push('Format: date | account | name | category | amount');
  for (const t of usable) {
    const a = acctById.get(t.account_id);
    const acctLabel = a?.nickname || `${a?.name || 'Account'}${a?.mask ? ` ··${a.mask}` : ''}`;
    const name = t.user_description || t.merchant_name || t.description || 'Card transaction';
    lines.push(
      `${t.date} | ${acctLabel} | ${name} | ${t.mapped_category || 'Uncategorized'} | $${Number(t.amount).toFixed(2)}`
    );
  }

  return lines.join('\n');
}
