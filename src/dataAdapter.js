import { db } from './db.js';
import { isTransferCategory, isReturnCategory, applyAccountRules } from './categoryMap.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthBounds(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  return { start, end };
}

function inMonth(dateStr, year, month) {
  if (!dateStr) return false;
  const ym = `${year}-${pad2(month)}`;
  return dateStr.slice(0, 7) === ym;
}

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });
}

function shiftMonth(year, month, delta) {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

async function getAccountTypeMap() {
  const accounts = await db.accounts.toArray();
  const map = new Map();
  for (const a of accounts) map.set(a.plaidAccountId, a.type);
  return map;
}

async function getMonthTransactions(year, month) {
  const { start, end } = monthBounds(year, month);
  const [txs, accountTypes] = await Promise.all([
    db.transactions.where('date').between(start, end, true, true).toArray(),
    getAccountTypeMap(),
  ]);
  for (const t of txs) {
    t.mappedCategory = applyAccountRules(
      t.mappedCategory,
      t.amount,
      accountTypes.get(t.accountId)
    );
  }
  return txs;
}

function sumSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.amount > 0 && !isTransferCategory(t.mappedCategory)) total += t.amount;
  }
  return total;
}

// Credit-card refunds (now category "Return") are reversals of past spend, not
// income — exclude them so cash-flow isn't inflated.
function sumIncome(txs) {
  let total = 0;
  for (const t of txs) {
    if (t.amount < 0 && !isReturnCategory(t.mappedCategory)) total += Math.abs(t.amount);
  }
  return total;
}

export async function getOverview() {
  const accounts = await db.accounts.toArray();
  const credit = accounts.filter(a => a.type === 'credit');
  const depository = accounts.filter(a => a.type === 'depository');
  const ordered = [...credit, ...depository];

  const now = new Date();
  const last = shiftMonth(now.getFullYear(), now.getMonth() + 1, -1);
  const lastTxs = await getMonthTransactions(last.year, last.month);

  return {
    accounts: ordered.map(a => ({
      balance: { current: a.currentBalance ?? 0 },
      name: a.name,
      mask: a.mask,
      type: a.type,
    })),
    last_month: {
      spending: { amount: sumSpending(lastTxs) },
    },
  };
}

export async function getSpending({ year, month }) {
  const txs = await getMonthTransactions(year, month);
  const buckets = new Map();
  let total = 0;

  for (const t of txs) {
    if (t.amount <= 0) continue;
    if (isTransferCategory(t.mappedCategory)) continue;
    const cat = t.mappedCategory || 'Shopping and gear';
    if (!buckets.has(cat)) buckets.set(cat, { amount: 0, count: 0 });
    const b = buckets.get(cat);
    b.amount += t.amount;
    b.count += 1;
    total += t.amount;
  }

  const groups = Array.from(buckets.entries())
    .map(([label, b]) => ({
      label,
      amount: b.amount,
      transaction_count: b.count,
      percent_of_total: total ? (b.amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return { groups };
}

export async function getTransactions({ year, month }) {
  const txs = await getMonthTransactions(year, month);
  txs.sort((a, b) => {
    if (a.date === b.date) return b.amount - a.amount;
    return a.date < b.date ? 1 : -1;
  });
  return {
    transactions: txs.map(t => ({
      plaid_tx_id: t.plaidTxId,
      merchant_name: t.merchantName,
      description: t.name,
      transaction_date: t.date,
      amount: t.amount,
      category: t.mappedCategory || 'Shopping and gear',
    })),
  };
}

export async function getCashFlow({ num_periods = 6 } = {}) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  const periods = [];
  let spendSum = 0;
  let spendCount = 0;

  for (let i = num_periods - 1; i >= 0; i--) {
    const { year, month } = shiftMonth(curY, curM, -i);
    const txs = await getMonthTransactions(year, month);
    const spending = sumSpending(txs);
    const income = sumIncome(txs);
    const { start } = monthBounds(year, month);
    periods.push({
      label: monthLabel(year, month),
      start,
      spending: { amount: spending },
      income: { amount: income },
    });
    spendSum += spending;
    spendCount += 1;
  }

  return {
    periods,
    averages: {
      spending: { amount: spendCount ? spendSum / spendCount : 0 },
    },
  };
}
