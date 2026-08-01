// Client-side recurring/subscription detection. Pure module: operates on
// transactions in the dataAdapter's toTxShape ({ merchant_name, description,
// transaction_date 'YYYY-MM-DD', amount, category, account_id }), touches no
// network, so it stays testable and reusable by server code later.
//
// Heuristic (roadmap spec): a merchant is "recurring" when it has >= 3
// charges at a ~monthly cadence (median gap 28±4 days, most gaps within ±4
// days of that median) with similar amounts (within ±20% of the median).

import { TRANSFER_CATEGORY, RETURN_CATEGORY } from './categoryMap.js';

// 'YYYY-MM-DD' → whole days since epoch. String split, not new Date(string),
// so day arithmetic can't pick up UTC off-by-one surprises.
function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function isoFromDayNumber(n) {
  const dt = new Date(n * 86400000);
  const p = x => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mostFrequent(values) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const v of values) {
    if (v == null || v === '') continue;
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

// "TRADER JOE'S #553" → "TRADER JOE S"; "AMAZON.COM*MK1AB23" → "AMAZON COM MK AB".
// Store numbers and per-charge codes vary; the letters are the merchant.
export function normalizeMerchant(raw) {
  return (raw || '')
    .toUpperCase()
    .replace(/[0-9#*]+/g, ' ')
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

// `today` ('YYYY-MM-DD', optional): when given, each item gains dueSoon
// (nextDate within 7 days) / overdue (nextDate past). Null keeps the module
// pure — callers pass the clock in; with no clock the due fields are null.
export function detectRecurring(transactions, today = null) {
  const groups = new Map();
  for (const t of transactions) {
    if (!(t.amount > 0)) continue; // money in can't be a subscription
    if (t.category === TRANSFER_CATEGORY || t.category === RETURN_CATEGORY) continue;
    if (!t.transaction_date) continue;
    const key = normalizeMerchant(t.merchant_name || t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const out = [];
  for (const [key, all] of groups) {
    if (all.length < 3) continue;

    // Similar amounts: keep charges within ±20% of the median; a group where
    // fewer than ~80% qualify is variable spend (groceries), not a subscription.
    const amounts = all.map(t => t.amount).sort((a, b) => a - b);
    const medAmount = median(amounts);
    const kept = all.filter(t => Math.abs(t.amount - medAmount) <= 0.2 * medAmount);
    if (kept.length < 3 || kept.length < 0.8 * all.length) continue;

    // ~Monthly cadence: median gap 28±4 days, and most gaps near the median.
    const days = kept.map(t => dayNumber(t.transaction_date)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
    if (!gaps.length) continue;
    const medGap = median([...gaps].sort((a, b) => a - b));
    if (medGap < 24 || medGap > 32) continue;
    const near = gaps.filter(g => Math.abs(g - medGap) <= 4).length;
    if (near < Math.ceil((gaps.length * 2) / 3)) continue;

    const keptAmounts = kept.map(t => t.amount).sort((a, b) => a - b);
    const lastDay = days[days.length - 1];
    // Tie-break same-day charges on amount so the pick is input-order
    // independent (the output-ordering test feeds reversed input).
    const lastAmount = kept.reduce((best, t) => {
      const dt = dayNumber(t.transaction_date), db = dayNumber(best.transaction_date);
      return dt > db || (dt === db && t.amount > best.amount) ? t : best;
    }).amount;
    const nextDay = lastDay + Math.round(medGap);
    const todayDay = today ? dayNumber(today) : null;
    out.push({
      key,
      name: mostFrequent(kept.map(t => t.merchant_name)) || titleCase(key),
      category: mostFrequent(kept.map(t => t.category)) || 'Shopping and gear',
      account_id: mostFrequent(kept.map(t => t.account_id)) || null,
      monthlyAmount: median(keptAmounts),
      count: kept.length,
      lastDate: isoFromDayNumber(lastDay),
      nextDate: isoFromDayNumber(nextDay),
      avgGapDays: Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length),
      lastAmount,
      // Strictly more than 5% over the median: exactly 5% is not creep.
      priceCreep: lastAmount > 1.05 * medAmount,
      dueSoon: todayDay == null ? null : nextDay >= todayDay && nextDay - todayDay <= 7,
      overdue: todayDay == null ? null : nextDay < todayDay,
    });
  }

  return out.sort((a, b) => b.monthlyAmount - a.monthlyAmount);
}
