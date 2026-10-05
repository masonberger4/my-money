// Pure search-refinement core, zero imports: parsing/normalizing the
// Transactions-tab search filters (amount range + date range) and building the
// PostgREST clause for absolute-value amount matching. Pushed SERVER-side so
// the 200-cap + load-more paginate the FILTERED set, not a client slice of an
// unfiltered 200. Also home to dateCommit, the blur-commit guard every date
// EDIT input shares. Covered by test/searchFilters.test.js.

// Amounts match by ABSOLUTE VALUE — the app stores positive = money out,
// negative = money in (CLAUDE.md sign convention), but a user typing 80 means
// "an $80 transaction" whichever direction it moved. Signs and $/commas are
// stripped; garbage reads as "no filter", never as 0.
export function parseAmount(str) {
  const s = String(str ?? '').replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

// Only a COMPLETE, sane date passes — <input type="date"> emits values like
// "0202-06-15" while a year is being typed (the CLAUDE.md date-input gotcha),
// so anything outside the floor/ceiling is treated as "no filter yet" rather
// than a real bound that silently empties the results. The full-shape regex
// is also what rejects a 5- or 6-digit year ("20261-09-15"): Chrome's year
// segment keeps accepting digits, and a 4-character prefix compare passed it.
export const DATE_YEAR_FLOOR = 1990;
export function sanitizeDateInput(str, floor = DATE_YEAR_FLOOR) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const y = Number(str.slice(0, 4));
  if (y < floor || y > 2100) return null;
  return str;
}

// Record EDITS (a transaction's date, placed-in-service, a debt's due date, a
// logged drive) keep the 1900 floor their old hand-rolled guards had: an old
// building's placed-in-service date can predate the search floor.
export const EDIT_YEAR_FLOOR = 1900;

// What a date input's BLUR should do with what the field now holds, against
// the stored value (null/'' = none): an EMPTY field clears ('clear', or
// 'noop' when nothing is stored), an invalid value — a partial year, a 5-digit
// year — REVERTS the field without writing, a valid different date saves.
// Never write garbage and never turn garbage into a clear (that deleted the
// stored date). A field that can't be empty (a transaction's date) maps
// 'clear' to a revert itself.
export function dateCommit(raw, stored, floor = EDIT_YEAR_FLOOR) {
  const cur = stored || null;
  if (!raw) return cur ? { action: 'clear', value: null } : { action: 'noop', value: null };
  const v = sanitizeDateInput(raw, floor);
  if (!v) return { action: 'revert', value: cur };
  if (v === cur) return { action: 'noop', value: v };
  return { action: 'save', value: v };
}

// Raw input strings -> normalized filter object, or null when nothing is
// active (the "are any filters on?" test the UI and the adapter both use).
// Inverted ranges are swapped, not emptied — a swapped range is obviously
// what was meant; an empty result reads as data loss.
export function buildSearchFilters({ amtMin, amtMax, dateFrom, dateTo } = {}) {
  let min = parseAmount(amtMin);
  let max = parseAmount(amtMax);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  let from = sanitizeDateInput(dateFrom);
  let to = sanitizeDateInput(dateTo);
  if (from && to && from > to) [from, to] = [to, from];
  if (min == null && max == null && !from && !to) return null;
  return { amountMin: min, amountMax: max, dateFrom: from, dateTo: to };
}

// Is a search "on"? Either a real text query (>=2 chars, the pre-existing
// activation floor) OR any normalized filter — "all transactions over $500 in
// June" needs no words. Shared by the Dashboard's searchActive flag and the
// adapter's early-out so the two can't disagree about what counts as a search.
export function searchIsActive(query, filters) {
  return String(query ?? '').trim().length >= 2 || filters != null;
}

// The PostgREST .or() clause for |amount| in [min, max]. Both bounds:
// (min<=a<=max) OR (-max<=a<=-min). Min only: a>=min OR a<=-min. Max only:
// a in [-max, max] — one and() keeps it a valid or-list of a single branch.
// Numbers only reach here from parseAmount, so interpolation is injection-safe
// (PostgREST or-syntax cares about commas/parens, which a finite Number's
// string form can't contain).
export function amountOrClause(min, max) {
  if (min == null && max == null) return null;
  if (min != null && max != null)
    return `and(amount.gte.${min},amount.lte.${max}),and(amount.gte.${-max},amount.lte.${-min})`;
  if (min != null) return `amount.gte.${min},amount.lte.${-min}`;
  return `and(amount.gte.${-max},amount.lte.${max})`;
}
