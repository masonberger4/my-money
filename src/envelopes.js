// Pure envelope-budgeting model (no Supabase/React/env) — importable from plain
// Node, so the walk is covered by test/envelopes.test.js. dataAdapter.js does
// all the I/O: it reads the rows, aggregates spending through the shared
// isSpend() predicate, and hands plain arrays in here.
//
//   available(cat, m) = assigned(cat, m) + carry(cat, m-1) - spent(cat, m)
//
// carry is the previous month's available for a rolling category and 0 for a
// non-rolling one. A month with no assignment contributes 0 — never the funding
// target — so a category cannot accrue a phantom balance out of months nobody
// actually budgeted. Every assignment comes from an explicit user action, which
// keeps the number on screen equal to the number the walk rolls forward.
//
// Deliberate deviation from real YNAB: YNAB takes *cash* overspending out of
// next month's Ready to Assign and lets the category start fresh. This app has
// no cash-vs-credit envelope split, so an overspent category just carries
// negative.

// Runaway guard on the month loop — NOT a correctness clamp. A rolling balance
// is the sum of every assignment and every dollar spent since the envelope
// opened, so the walk has to start at the category's first assignment however
// old that is: truncating the window would silently freeze a long-running
// sinking fund at a stale balance and drift further from the truth every month.
// 600 months is 50 years; tripping it means a corrupt `month` value, not a real
// budget, so the result is flagged `truncated` rather than quietly shortened.
export const MAX_WALK_MONTHS = 600;

export function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Accepts 'YYYY-MM' or a full 'YYYY-MM-DD' date, which is what Postgres hands
// back for budget_months.month.
export function normalizeMonthKey(value) {
  const s = String(value || '').slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null;
}

export function shiftMonthKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return monthKey(Math.floor(total / 12), (total % 12) + 1);
}

// Whole months between two 'YYYY-MM' keys (b - a).
function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// Money math accumulates float residue over a long walk; snapping to cents
// keeps a zeroed-out envelope from rendering as a red "−$0". Rounding a tiny
// negative residue yields -0, which passes `>= 0` but fails `> 0` — enough to
// print a minus sign in front of a zero — so it is normalized away here.
export function cents(n) {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
}

// Months from `year`/`month` through the target date, counting this one.
export function monthsUntil(dateStr, year, month) {
  const target = normalizeMonthKey(dateStr);
  if (!target) return 1;
  const diff = monthDiff(monthKey(year, month), target) + 1;
  return diff > 0 ? diff : 1;
}

// What this month still needs for the category to hit its target. A monthly
// target wants topping up to the target every month. A by-date target spreads
// what's still missing (counting money already carried in, not what's been
// spent out) over the months left, then asks only for THIS month's share — so
// funding it twice in one month is a no-op rather than a double payment.
export function targetNeed(row, { year, month }) {
  if (!row || row.target == null) return 0;
  if (row.targetKind === 'by_date') {
    const share = (row.target - row.rolledOver) / monthsUntil(row.targetDate, year, month);
    const need = share - row.assigned;
    return need > 0 ? cents(need) : 0;
  }
  const left = row.target - row.assigned;
  return left > 0 ? cents(left) : 0;
}

const DEFAULT_SETTING = { target: null, targetKind: 'monthly', targetDate: null, rollover: true };

// assignments: [{ category, month, assigned }]  — month may be YYYY-MM or a date
// spending:    [{ category, month, spent }]     — pre-aggregated by the adapter
// settings:    [{ category, target, targetKind, targetDate, rollover }]
export function walkEnvelopes({ assignments = [], spending = [], settings = [], year, month }) {
  const targetKey = monthKey(year, month);

  // category -> 'YYYY-MM' -> dollars, plus the earliest month anyone assigned in.
  const assigned = new Map();
  let earliestKey = targetKey;
  for (const row of assignments) {
    const key = normalizeMonthKey(row.month);
    // A row we can't place in a month can't be walked; dropping it is the only
    // safe move, and it can only come from a corrupt write.
    if (!key || key > targetKey) continue;
    const amount = Number(row.assigned) || 0;
    if (!assigned.has(row.category)) assigned.set(row.category, new Map());
    const byMonth = assigned.get(row.category);
    byMonth.set(key, (byMonth.get(key) || 0) + amount);
    // Only a non-zero assignment opens an envelope — see catStart below.
    if (amount !== 0 && key < earliestKey) earliestKey = key;
  }

  const spent = new Map();
  for (const row of spending) {
    const key = normalizeMonthKey(row.month);
    if (!key) continue;
    if (!spent.has(row.category)) spent.set(row.category, new Map());
    const byMonth = spent.get(row.category);
    byMonth.set(key, cents((byMonth.get(key) || 0) + (Number(row.spent) || 0)));
  }

  const settingByCategory = new Map();
  for (const row of settings) {
    settingByCategory.set(row.category, {
      target: row.target == null ? null : Number(row.target),
      targetKind: row.targetKind === 'by_date' ? 'by_date' : 'monthly',
      targetDate: row.targetDate || null,
      rollover: row.rollover !== false,
    });
  }

  // The walk window: the earliest month anyone assigned in, through the month
  // being viewed. Viewing a month that predates every assignment walks just
  // that one month, carry 0.
  let startKey = earliestKey;
  const truncated = monthDiff(startKey, targetKey) >= MAX_WALK_MONTHS;
  if (truncated) startKey = shiftMonthKey(targetKey, -(MAX_WALK_MONTHS - 1));

  const months = [];
  for (let cur = startKey; ; cur = shiftMonthKey(cur, 1)) {
    months.push(cur);
    if (cur === targetKey) break;
  }

  // Every category that has an assignment, a target, or spending this month.
  const categories = new Set([...assigned.keys(), ...settingByCategory.keys()]);
  for (const [category, byMonth] of spent) {
    if (byMonth.has(targetKey)) categories.add(category);
  }

  const rows = [];
  for (const category of categories) {
    const setting = settingByCategory.get(category) || DEFAULT_SETTING;
    const assignedByMonth = assigned.get(category);
    const spentByMonth = spent.get(category);

    // A category's envelope begins at ITS OWN first assignment — never at the
    // household's. Walking a never-assigned category from someone else's start
    // month would turn its ordinary past spending into rolled-over "debt".
    // A zero assignment does not open one: moving money out of an envelope can
    // leave a 0 row behind, and that must stay equivalent to no row at all.
    let catStart = targetKey;
    if (assignedByMonth) {
      for (const [key, amount] of assignedByMonth) {
        if (amount !== 0 && key < catStart) catStart = key;
      }
    }
    if (catStart < startKey) catStart = startKey;

    let carry = 0;
    let row = null;
    for (const key of months) {
      if (key < catStart) continue;
      const a = assignedByMonth?.get(key) || 0;
      const s = spentByMonth?.get(key) || 0;
      const available = a + carry - s;
      if (key === targetKey) {
        row = {
          category,
          assigned: cents(a),
          rolledOver: cents(carry),
          spent: cents(s),
          available: cents(available),
          ...setting,
        };
      }
      carry = setting.rollover ? available : 0;
    }
    if (row) rows.push(row);
  }

  rows.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

  // Totals describe the BUDGET, so they cover only categories that actually
  // have an envelope or a target — spending in an unbudgeted category is not
  // "over" anything.
  const totals = rows
    .filter(r => r.assigned !== 0 || r.rolledOver !== 0 || r.target != null)
    .reduce(
      (acc, r) => ({
        assigned: cents(acc.assigned + r.assigned),
        rolledOver: cents(acc.rolledOver + r.rolledOver),
        spent: cents(acc.spent + r.spent),
        available: cents(acc.available + r.available),
        target: cents(acc.target + (r.target || 0)),
      }),
      { assigned: 0, rolledOver: 0, spent: 0, available: 0, target: 0 }
    );

  return { month: targetKey, categories: rows, totals, truncated };
}

// Rule 1, as far as this app can honestly go. `income` is hand-entered — the
// household's real take-home is not measurable from the feed (only the two
// joint BECU accounts sync; Trends' cashIncome is a proxy that includes
// personal→joint transfers). Deliberately NOT carried over from prior months:
// with hand-entered income a carry-forward would compound whatever months the
// user never filled in. One month in, one month out.
// Returns null when no income is set, so the UI can hide the number instead of
// showing a confident zero.
export function readyToAssign(income, totals) {
  const n = Number(income);
  if (income == null || income === '' || !Number.isFinite(n)) return null;
  return cents(n - (totals?.assigned || 0));
}

// Moving money between envelopes is rule 3's actual mechanic: cover an
// overspent category from one that has room. Pure so the arithmetic (and the
// "leaves exactly zero" case, which must delete the row rather than store a 0)
// is testable without a database.
export function planMove({ from, to, amount, assignedByCategory = {} }) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!from || !to || from === to) return null;
  return [
    { category: from, assigned: cents((Number(assignedByCategory[from]) || 0) - n) },
    { category: to, assigned: cents((Number(assignedByCategory[to]) || 0) + n) },
  ];
}
