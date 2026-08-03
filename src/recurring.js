// Client-side recurring/subscription detection. Pure module: operates on
// transactions in the dataAdapter's toTxShape ({ merchant_name, description,
// transaction_date 'YYYY-MM-DD', amount, category, account_id }), touches no
// network, so it stays testable and reusable by server code later.
//
// Heuristic (roadmap spec, extended to three cadences): a merchant is
// "recurring" when it has >= 3 charges at a steady cadence — weekly (median
// gap 7±2 days), monthly (28±4, the original detector, thresholds unchanged)
// or annual (365±15) — with most gaps near the median (tolerance scaled to
// the band) and similar amounts (within ±20% of the median). Gaps outside
// every band (biweekly ~14, quarterly ~91) stay undetected.

import { TRANSFER_CATEGORY, RETURN_CATEGORY } from './categoryMap.js';

// Price creep: flag when the most recent charge exceeds the group median by
// STRICTLY more than this fraction. A Netflix-style hike (~10–15%) hides
// comfortably inside the ±20% similar-amount band that detection needs, so
// without this signal a raised subscription still reads as "recurring, fine".
// Cadence-independent: a weekly box that creeps is flagged the same way.
const PRICE_CREEP_PCT = 0.05;

// The cadence bands. gapTol is the "most gaps near the median" tolerance and
// dueSoonDays the 'due-soon' window — both scale with the cycle length (a
// weekly sub is due soon within 2 days, an annual one within a month). The
// MONTHLY row is the ORIGINAL shipped detector verbatim (24–32 gap window,
// ±4 near-tolerance, 7-day due window) — pinned by tests; never loosen it.
// perMonth normalizes the per-charge amount to a monthly figure so mixed
// cadences can sum and sort on one field (monthlyEquivalent).
const CADENCES = [
  { cadence: 'weekly', minGap: 5, maxGap: 9, gapTol: 2, dueSoonDays: 2, perMonth: 52 / 12 },
  { cadence: 'monthly', minGap: 24, maxGap: 32, gapTol: 4, dueSoonDays: 7, perMonth: 1 },
  { cadence: 'annual', minGap: 350, maxGap: 380, gapTol: 15, dueSoonDays: 30, perMonth: 1 / 12 },
];

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

// `today` ('YYYY-MM-DD', optional): the caller's as-of clock. When given, each
// item gains dueSoon (nextDate within DUE_SOON_DAYS) / overdue (nextDate past)
// plus the one-field summary dueStatus ('due-soon' | 'overdue' | null). Null
// keeps the module pure — callers pass the clock in; with no clock every due
// field is null.
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

    // Steady cadence: the median gap must land inside one band (the bands
    // don't overlap, so the match is unambiguous), and most gaps must sit
    // within that band's tolerance of the median.
    const days = kept.map(t => dayNumber(t.transaction_date)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
    if (!gaps.length) continue;
    const medGap = median([...gaps].sort((a, b) => a - b));
    const spec = CADENCES.find(c => medGap >= c.minGap && medGap <= c.maxGap);
    if (!spec) continue;
    const near = gaps.filter(g => Math.abs(g - medGap) <= spec.gapTol).length;
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
      // Historical name: the median PER-CHARGE amount (for monthly the two are
      // the same thing, which is where the name came from). For weekly/annual
      // it is the per-cycle charge — use monthlyEquivalent for a per-month
      // figure; consumers that render it should suffix by cadence.
      monthlyAmount: median(keptAmounts),
      monthlyEquivalent: median(keptAmounts) * spec.perMonth,
      cadence: spec.cadence,
      count: kept.length,
      lastDate: isoFromDayNumber(lastDay),
      nextDate: isoFromDayNumber(nextDay),
      avgGapDays: Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length),
      lastAmount,
      // The value priceCreep compares against — surfaced so the UI can say
      // "was $20.00, now $21.20" instead of a bare flag.
      medianAmount: medAmount,
      // Strictly more than PRICE_CREEP_PCT over the median: exactly 5% is not creep.
      priceCreep: lastAmount > (1 + PRICE_CREEP_PCT) * medAmount,
      dueSoon: todayDay == null ? null : nextDay >= todayDay && nextDay - todayDay <= spec.dueSoonDays,
      overdue: todayDay == null ? null : nextDay < todayDay,
      // One-field summary of the two booleans above; a nextDate more than the
      // cadence's due-soon window out is null even with a clock.
      dueStatus:
        todayDay == null ? null
        : nextDay < todayDay ? 'overdue'
        : nextDay - todayDay <= spec.dueSoonDays ? 'due-soon'
        : null,
    });
  }

  // Monthly-equivalent cost so mixed cadences rank sensibly ($10/wk beats
  // $20/mo). For an all-monthly input this is byte-identical to the original
  // monthlyAmount sort.
  return out.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}

// --- Ignore list -------------------------------------------------------------
// The Recurring tab's mute list: a HOUSEHOLD pref (muting a charge should mute
// it on both phones — Mason's ruling), stored as ONE settings row keyed
// 'rec:ignore' whose value is a JSON array of the items' group keys (the
// normalizeMerchant output detectRecurring emits as `key` — stable across
// re-detection, unlike list order or amounts). Tolerant parse, the
// parseRestoreSet spirit: garbage in the row must never take the tab down.
export function parseIgnoreList(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const out = [];
  for (const k of parsed) {
    if (typeof k !== 'string' || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
