// Pure search-refinement core, zero imports: parsing/normalizing the
// Transactions-tab search filters (amount range + date range) and building the
// PostgREST clause for absolute-value amount matching. Pushed SERVER-side so
// the 200-cap + load-more paginate the FILTERED set, not a client slice of an
// unfiltered 200. Covered by test/searchFilters.test.js.

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
// than a real bound that silently empties the results.
export const DATE_YEAR_FLOOR = 1990;
export function sanitizeDateInput(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const y = Number(str.slice(0, 4));
  if (y < DATE_YEAR_FLOOR || y > 2100) return null;
  return str;
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
