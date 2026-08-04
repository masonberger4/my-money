// Envelope-budgeting I/O (YNAB rules 1–3) — the budgets / budget_months
// writes plus the settings-backed income and pace prefs. Split out of
// dataAdapter.js (2026-08-04 code-health session); INTERNAL: only
// dataAdapter.js imports this module and re-exports its API — consumers and
// the mock harness keep going through the façade.
//
// Deliberately NOT here (pinned into dataAdapter.js by source-scan tests and
// by their coupling to the transaction pipeline): getEnvelopes /
// getEnvelopeSpending / invalidateEnvelopeSpending (spendCache + rangeMemo)
// and getAssignmentsThrough (the paged-loop discipline scan). The
// budget_months.target_override degrade flag lives HERE because setAssigned /
// setTargetOverride flip and read it; getAssignmentsThrough shares it through
// the accessors below.
import { supabase } from '../supabaseClient.js';
import { pad2, shiftMonth, isMissingTableError } from './shared.js';
import { monthKey, planMove, planAutoFill } from '../envelopes.js';
import { isBudgetableCategory } from '../categoryMap.js';
import { getSettings, getSetting, setSetting, deleteSetting } from '../db.js';

// Budgets: one monthly dollar limit per category. No row = no budget.
// RLS scopes reads to the household; household_id fills in server-side via
// its column default (same as settings) — never send it from the client.
// `budgets` maps category → MONTHLY target only. A by-date sinking fund's
// amount is a multi-month TOTAL — handing it to the Categories tab as if it
// were monthly would inflate the Targets strip and every bar denominator by
// the un-prorated balance (a "$6,000 by June" fund is not a $6,000/month
// budget). By-date targets come back separately in `byDate`.
export async function getBudgets() {
  let { data, error } = await supabase
    .from('budgets')
    .select('category, monthly_limit, target_kind, target_date');
  // Pre-envelope-migration schema has no target_kind/target_date (42703);
  // every row is a plain monthly target there.
  if (error && error.code === '42703') {
    ({ data, error } = await supabase.from('budgets').select('category, monthly_limit'));
  }
  if (error) throw error;
  const budgets = {};
  const byDate = {};
  for (const row of data) {
    // A null limit is a category keeping rollover/target settings without a
    // target amount (post-envelope migration) — reads as "no target".
    if (row.monthly_limit == null) continue;
    if (row.target_kind === 'by_date') {
      byDate[row.category] = { target: Number(row.monthly_limit), date: row.target_date || null };
    } else {
      budgets[row.category] = Number(row.monthly_limit);
    }
  }
  return { budgets, byDate };
}

// Sets the category's funding target. Clearing it null-UPDATES the row rather
// than deleting it, so a category keeps its rollover / target_date settings;
// getBudgets() skips null limits, so it still reads as "no target". An UPDATE,
// not an upsert: clearing a target on a category that never had a budgets row
// must stay a no-op — an upserted null row would list that category on the
// Budget tab every month forever, with no UI that ever deletes it.
export async function setBudget(category, limit) {
  const n = limit == null || limit === '' ? NaN : Number(limit);
  const monthly_limit = Number.isFinite(n) && n > 0 ? n : null;
  const { error } =
    monthly_limit === null
      ? await supabase.from('budgets').update({ monthly_limit }).eq('category', category)
      : await supabase
          .from('budgets')
          .upsert({ category, monthly_limit }, { onConflict: 'household_id,category' });
  if (!error) return;
  // `monthly_limit` is NOT NULL until the envelope migration relaxes it, and
  // previews share the PROD database — so on a preview whose migration hasn't
  // been pasted yet, clearing a target would fail where it used to work. Fall
  // back to the old behaviour (drop the row) rather than break it. 23502 is
  // not_null_violation.
  if (monthly_limit === null && error.code === '23502') {
    const { error: delErr } = await supabase.from('budgets').delete().eq('category', category);
    if (delErr) throw delErr;
    return;
  }
  throw error;
}

// True for the errors that mean the envelope schema has not been installed —
// a missing table (PGRST205 from PostgREST's schema cache, 42P01 from
// Postgres) or the budgets columns the migration adds (42703). The dashboard
// uses this to tell "migration not pasted yet" apart from a transient network
// failure: only the former should show the not-set-up notice. Same pattern as
// getCategoryRules.
export function isEnvelopeSchemaMissing(error) {
  // Missing table (shared predicate) OR the budgets columns the migration
  // adds (42703, undefined_column) — this is the one place a column error is
  // deliberately part of a schema-missing verdict; everywhere else the
  // table/column tests stay separate (the api/sync.js rule).
  return !!error && (isMissingTableError(error) || error.code === '42703');
}

// budget_months.target_override lands with migration 20260804000001. Previews
// share the prod database, so reads/writes must work before Mason pastes it —
// but the fallback needs a check STRICTER than isMissingColumnError: the
// Budget tab's gate (isEnvelopeSchemaMissing) treats ANY 42703 as "envelopes
// not installed", so a bare 42703 caused by this one new column escaping
// would shut the whole tab off. Only an error that NAMES target_override
// triggers the retry; everything else still escapes to the gate untouched.
// The flag only ever flips true→false, mirroring the shared-preview reality.
// getAssignmentsThrough (in dataAdapter.js — its paged loop is scan-pinned
// there) shares this flag through the accessors.
let budgetMonthsHaveOverride = true;

export function hasOverrideColumn() {
  return budgetMonthsHaveOverride;
}

export function markOverrideColumnMissing() {
  budgetMonthsHaveOverride = false;
}

export function isMissingOverrideColumnError(error) {
  if (!error) return false;
  if (error.code !== '42703' && error.code !== 'PGRST204') return false;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  return blob.includes('target_override');
}

// Household income for a month, for Ready to Assign. Hand-entered: the feed
// still cannot be trusted for take-home pay (SimpleFIN only syncs what is
// linked and unhidden, and a missed paycheck would silently read as less to
// budget). `budget:income` is the recurring default; `budget:income:YYYY-MM`
// overrides one month. Both live in `settings`, so this needs no migration.
const INCOME_KEY = 'budget:income';

export async function getBudgetIncome({ year, month }) {
  const monthKeyStr = `${INCOME_KEY}:${monthKey(year, month)}`;
  const byKey = await getSettings([INCOME_KEY, monthKeyStr]);
  // settings.value is a TEXT column (see migration 2) — everything stored there
  // is a string, so read it back as one. An empty string is not a zero.
  const read = v => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const override = read(byKey[monthKeyStr]);
  const fallback = read(byKey[INCOME_KEY]);
  return {
    income: override != null ? override : fallback,
    isDefault: override == null && fallback != null,
    monthlyDefault: fallback,
  };
}

// `scope: 'month'` sets just this month; `scope: 'default'` sets the recurring
// amount AND clears this month's override so the new default is what shows.
export async function setBudgetIncome({ year, month }, amount, { scope = 'month' } = {}) {
  const raw = amount == null ? '' : String(amount).trim();
  const n = raw === '' ? null : Number(raw);
  if (raw !== '' && !Number.isFinite(n)) return;
  const monthKeyStr = `${INCOME_KEY}:${monthKey(year, month)}`;
  const key = scope === 'default' ? INCOME_KEY : monthKeyStr;
  if (n == null) await deleteSetting(key);
  else await setSetting(key, String(n));
  if (scope === 'default') await deleteSetting(monthKeyStr);
}

// Per-envelope pace-warning opt-in. Stored as ONE settings row keyed
// 'env:pace' whose value is a JSON map { category: true } — the dash:colors /
// dash:cats pattern (a name-keyed JSON blob), chosen because adding a real
// budgets column would need a migration and this is a pure display preference.
// Default OFF for every category (absent key ⇒ {}), so a fixed bill that spends
// 100% on day 1 never false-alarms; opting in is a deliberate per-envelope act.
const ENV_PACE_KEY = 'env:pace';

export async function getEnvPace() {
  const value = await getSetting(ENV_PACE_KEY);
  if (value == null || String(value).trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function setEnvPace(map) {
  const clean = {};
  for (const [k, v] of Object.entries(map || {})) if (v) clean[k] = true;
  await setSetting(ENV_PACE_KEY, JSON.stringify(clean));
}

// Assigns dollars to a category for one month. Blank or zero removes the
// assignment entirely (which is what keeps "no row = assigned 0" true) —
// UNLESS the row carries a per-month target_override: the zero-row-equivalence
// rule applies to ASSIGNED only, so a row with a non-null override is a REAL
// row and is set to assigned 0 instead of deleted (deleting it would silently
// discard the override). Negative is allowed — that's moving money back out
// of an envelope. `client` is injectable for tests (the addManualTransaction
// pattern).
export async function setAssigned(category, { year, month }, amount, { client = supabase } = {}) {
  const raw = amount == null ? '' : String(amount).trim();
  const n = raw === '' ? 0 : Number(raw);
  // A typo ("1-2") must not silently wipe an assignment — only an empty value
  // clears one. Anything unparseable is ignored.
  if (!Number.isFinite(n)) return;
  const monthStart = `${year}-${pad2(month)}-01`;
  if (n === 0) {
    const del = () => client.from('budget_months').delete().eq('category', category).eq('month', monthStart);
    if (!budgetMonthsHaveOverride) {
      // Pre-migration: the old unconditional delete (no override can exist).
      const { error } = await del();
      if (error) throw error;
      return;
    }
    const { error } = await del().is('target_override', null);
    if (error) {
      // 42703 NAMING target_override = the column isn't there yet — fall back
      // to the old behaviour rather than break clearing an assignment on a
      // preview. Anything else (incl. a bare 42703) escapes untouched.
      if (isMissingOverrideColumnError(error)) {
        budgetMonthsHaveOverride = false;
        const { error: delErr } = await del();
        if (delErr) throw delErr;
        return;
      }
      throw error;
    }
    // A row the delete skipped (non-null override) still needs its assignment
    // cleared. No row matches ⇒ no-op.
    const { error: updErr } = await client
      .from('budget_months')
      .update({ assigned: 0, updated_at: new Date().toISOString() })
      .eq('category', category)
      .eq('month', monthStart);
    if (updErr) throw updErr;
    return;
  }
  const { error } = await client
    .from('budget_months')
    .upsert(
      { category, month: monthStart, assigned: n, updated_at: new Date().toISOString() },
      { onConflict: 'household_id,category,month' }
    );
  if (error) throw error;
}

// Per-month funding-target override (budget_months.target_override). Non-null
// upserts the override — sent-columns-only, so an existing row's `assigned`
// survives, and a fresh row gets the column default assigned 0, which does
// NOT open an envelope (the walk's catStart rule). An override of 0 is a real
// value ("ask nothing this month"), distinct from clearing. Clearing (null or
// blank) null-UPDATEs the row, then deletes it only when it carries nothing
// else (assigned = 0 AND target_override IS NULL) — the setBudget shape.
export async function setTargetOverride(category, { year, month }, amount, { client = supabase } = {}) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const raw = amount == null ? '' : String(amount).trim();
  if (raw === '') {
    const { error } = await client
      .from('budget_months')
      .update({ target_override: null, updated_at: new Date().toISOString() })
      .eq('category', category)
      .eq('month', monthStart);
    if (error) {
      // Pre-migration there is no override to clear — a no-op, not a failure.
      if (isMissingOverrideColumnError(error)) {
        budgetMonthsHaveOverride = false;
        return;
      }
      throw error;
    }
    const { error: delErr } = await client
      .from('budget_months')
      .delete()
      .eq('category', category)
      .eq('month', monthStart)
      .eq('assigned', 0)
      .is('target_override', null);
    if (delErr) throw delErr;
    return;
  }
  const n = Number(raw);
  // Targets are plain positive dollars (0 allowed — "ask nothing").
  if (!Number.isFinite(n) || n < 0) return;
  const { error } = await client
    .from('budget_months')
    .upsert(
      { category, month: monthStart, target_override: n, updated_at: new Date().toISOString() },
      { onConflict: 'household_id,category,month' }
    );
  if (error) throw error;
}

// Auto-fill: copy the previous month's assignments into the viewed month
// ("Fill from July"). The plan itself is pure (planAutoFill in envelopes.js):
// merge semantics — existing non-zero assignments in the viewed month are
// skipped, zero sums are never written, an existing 0 row counts as absent.
// The write is ONE bulk upsert of the plan's rows, sent-columns-only
// (category, month, assigned, updated_at — NEVER target_override), so filling
// onto a 0 row that carries an override leaves the override intact. Reads
// never select target_override here for the same pre-migration reason as
// getAssignmentsThrough. Returns the plan so the UI can confirm/summarize.
export async function autoFillMonth({ year, month }, { client = supabase } = {}) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const prev = shiftMonth(year, month, -1);
  const prevStart = `${prev.year}-${pad2(prev.month)}-01`;
  const [srcRes, existRes] = await Promise.all([
    client.from('budget_months').select('category, assigned').eq('month', prevStart),
    client.from('budget_months').select('category, assigned').eq('month', monthStart),
  ]);
  if (srcRes.error) throw srcRes.error;
  if (existRes.error) throw existRes.error;

  const plan = planAutoFill({
    source: srcRes.data || [],
    existing: existRes.data || [],
    isBudgetable: isBudgetableCategory,
  });
  if (!plan.rows.length) return plan;

  const updatedAt = new Date().toISOString();
  const { error } = await client.from('budget_months').upsert(
    plan.rows.map(r => ({
      category: r.category,
      month: monthStart,
      assigned: r.assigned,
      updated_at: updatedAt,
    })),
    { onConflict: 'household_id,category,month' }
  );
  if (error) throw error;
  return plan;
}

// Rule 3: whether this category's leftover (or overspend) carries forward.
// Each budgets writer sends only the columns it owns — a PostgREST upsert's
// ON CONFLICT DO UPDATE touches only those, so setting a rollover flag never
// clobbers monthly_limit or target_kind, and vice versa (verified against a
// local Postgres stub).
//
// Asymmetric on purpose: rollover=false (non-default) may create a row, but
// rollover=true first deletes a row that carries nothing else and otherwise
// UPDATEs — walkEnvelopes lists every budgets row in every month and no UI
// deletes one, so an idle ⟳ experiment on a never-budgeted category must not
// pin it to the Budget tab forever.
export async function setCategoryRollover(category, rollover) {
  if (rollover) {
    const { error: delErr } = await supabase
      .from('budgets')
      .delete()
      .eq('category', category)
      .is('monthly_limit', null)
      .is('target_date', null);
    if (delErr && delErr.code !== '42703') throw delErr;
    const { error } = await supabase
      .from('budgets')
      .update({ rollover: true })
      .eq('category', category);
    if (error && error.code !== '42703') throw error;
    return;
  }
  const { error } = await supabase
    .from('budgets')
    .upsert({ category, rollover: false }, { onConflict: 'household_id,category' });
  if (error) throw error;
}

// Rule 2: 'monthly' funds the target every month; 'by_date' is a sinking fund
// that should reach the target by `date`.
export async function setTargetKind(category, kind, date = null) {
  const target_kind = kind === 'by_date' ? 'by_date' : 'monthly';
  const { error } = await supabase.from('budgets').upsert(
    { category, target_kind, target_date: target_kind === 'by_date' ? date : null },
    { onConflict: 'household_id,category' }
  );
  if (error) throw error;
}

// Rule 3's actual mechanic: cover an overspent category from one with room.
// Both legs go in ONE upsert so a failure can never leave money duplicated or
// destroyed. A leg that lands on exactly zero is written as a 0 row rather than
// deleted — the walk treats a 0 assignment as "no envelope opened here", so the
// two are equivalent and atomicity is worth more than tidiness.
export async function moveMoney({ from, to, amount }, { year, month }) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const { data, error: readErr } = await supabase
    .from('budget_months')
    .select('category, assigned')
    .eq('month', monthStart)
    .in('category', [from, to]);
  if (readErr) throw readErr;
  const current = {};
  for (const row of data || []) current[row.category] = Number(row.assigned) || 0;

  const legs = planMove({ from, to, amount, assignedByCategory: current });
  if (!legs) return;

  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from('budget_months').upsert(
    legs.map(l => ({ ...l, month: monthStart, updated_at: updatedAt })),
    { onConflict: 'household_id,category,month' }
  );
  if (error) throw error;
}

// Bulk-assign for "Fund targets". items: [{ category, amount }]. Amounts are
// the *new* assigned totals for the month, not deltas. A total of exactly ZERO
// is still written: it can be the funding step that lifts a negative
// assignment back to zero, and a 0 row is defined as equivalent to no row —
// filtering it out would leave the negative in place and the category's
// "needs" chip asking forever.
export async function fundTargets(items, { year, month }) {
  const monthStart = `${year}-${pad2(month)}-01`;
  const updatedAt = new Date().toISOString();
  const rows = items
    .filter(i => Number.isFinite(Number(i.amount)))
    .map(i => ({
      category: i.category,
      month: monthStart,
      assigned: Number(i.amount),
      updated_at: updatedAt,
    }));
  if (!rows.length) return;
  const { error } = await supabase
    .from('budget_months')
    .upsert(rows, { onConflict: 'household_id,category,month' });
  if (error) throw error;
}
