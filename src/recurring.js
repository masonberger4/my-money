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
//
// evalDays — how far back from the group's NEWEST charge the amount/gap gates
// look. The candidate window is wide (~40 months, sized for annual — see
// CANDIDATE_WINDOW_MONTHS), so without a recency bound a monthly sub's amount
// median spans YEARS: a price change mid-window then fails the ±20%/80% gate
// (a live sub vanishes until the new price dominates) and priceCreep re-flags
// a hike that settled a year ago. Weekly/monthly judge the sub's RECENT shape
// (monthly's 190 days ≈ the 6-month adapter window the original detector
// shipped against); annual is null = the whole group (three yearly charges
// have no meaningful "recent slice"). Anchored at the newest CHARGE, not the
// clock, so the function stays pure without `today`.
//
// staleDays — with a clock, an item whose nextDate is more than this far past
// is treated as cancelled and dropped: roughly two more missed cycles (14/60),
// capped at 60 days for annual. Without it the wide window resurrects every
// sub cancelled in the last ~3 years as a red "overdue" row whose
// monthlyEquivalent inflates the Recurring headline /mo total.
const CADENCES = [
  { cadence: 'weekly', minGap: 5, maxGap: 9, gapTol: 2, dueSoonDays: 2, perMonth: 52 / 12, evalDays: 84, staleDays: 14 },
  { cadence: 'monthly', minGap: 24, maxGap: 32, gapTol: 4, dueSoonDays: 7, perMonth: 1, evalDays: 190, staleDays: 60 },
  { cadence: 'annual', minGap: 350, maxGap: 380, gapTol: 15, dueSoonDays: 30, perMonth: 1 / 12, evalDays: null, staleDays: 60 },
];

// How many months of transactions the adapter feeds detection
// (getRecurringCandidates' default). Sized by the ANNUAL worst case, which is
// NOT "two year-gaps" (the 25 first shipped on that arithmetic left annual
// items visible only in their renewal month): the three most recent renewals
// span ~2×366 days ending at the LAST renewal, which itself can be up to
// ~366 days + staleDays old before the staleness cutoff retires the item,
// plus the window's month alignment (it starts at the 1st) and posting drift.
// 732 + 366 + 60 + slack ⇒ 40 months (39 whole months ≥ ~1185 days). Pinned
// by the year-round sweep in test/recurring.test.js.
export const CANDIDATE_WINDOW_MONTHS = 40;

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
  for (const [key, group] of groups) {
    if (group.length < 3) continue;
    const all = [...group].sort(
      (a, b) => dayNumber(a.transaction_date) - dayNumber(b.transaction_date)
    );
    const newestDay = dayNumber(all[all.length - 1].transaction_date);

    // Try each cadence over its own recency slice (evalDays above). The bands
    // don't overlap, so on any one slice at most one band can match — the
    // first hit wins and the scan is deterministic. On histories shorter than
    // every evalDays the slices all equal the whole group, which makes this
    // byte-identical to the original single-pass detector.
    let hit = null;
    for (const c of CADENCES) {
      const windowed =
        c.evalDays == null
          ? all
          : all.filter(t => newestDay - dayNumber(t.transaction_date) <= c.evalDays);
      if (windowed.length < 3) continue;

      // Similar amounts: keep charges within ±20% of the median; a group where
      // fewer than ~80% qualify is variable spend (groceries), not a subscription.
      const amounts = windowed.map(t => t.amount).sort((a, b) => a - b);
      const medAmount = median(amounts);
      const kept = windowed.filter(t => Math.abs(t.amount - medAmount) <= 0.2 * medAmount);
      if (kept.length < 3 || kept.length < 0.8 * windowed.length) continue;

      // Steady cadence: the median gap must land inside this band, and most
      // gaps must sit within the band's tolerance of the median.
      const days = kept.map(t => dayNumber(t.transaction_date)).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
      if (!gaps.length) continue;
      const medGap = median([...gaps].sort((a, b) => a - b));
      if (medGap < c.minGap || medGap > c.maxGap) continue;
      const near = gaps.filter(g => Math.abs(g - medGap) <= c.gapTol).length;
      if (near < Math.ceil((gaps.length * 2) / 3)) continue;
      hit = { spec: c, kept, days, gaps, medGap, medAmount };
      break;
    }
    if (!hit) continue;
    const { spec, kept, days, gaps, medGap, medAmount } = hit;

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
    // Lapsed: more than staleDays past the expected charge means cancelled,
    // not overdue — drop the item rather than flag it. Only with a clock; the
    // pure no-clock call still returns every detected group.
    if (todayDay != null && todayDay - nextDay > spec.staleDays) continue;
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

// Pure merge step for the ignore-list WRITE path: apply one key's toggle to a
// list that was just re-read from settings — never to whatever copy a device
// has held since mount. Rebuilding the whole array from local state let a
// failed mount-time read (recIgnore=[] after a network blip) wipe the
// household's stored list on the first ✕ tap; merging a single-key delta into
// a fresh read shrinks the two-phone race to that one key. Tolerant of
// garbage input, the parseIgnoreList spirit.
export function toggleIgnoreKey(list, key, ignored) {
  const seen = new Set();
  const out = [];
  for (const k of Array.isArray(list) ? list : []) {
    if (typeof k !== 'string' || !k || k === key || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  if (ignored && typeof key === 'string' && key) out.push(key);
  return out;
}
