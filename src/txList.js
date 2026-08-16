// The Spending list's day-grouping core (PR C of the YNAB redesign,
// 2026-08-15). Pure, zero imports.
//
// Dates are read off the stored STRING ('YYYY-MM-DD'), never through
// `new Date()` — parsed as a Date that's UTC midnight, which renders as the
// previous day in every western timezone (the recorded off-by-one that would
// file the 1st under the previous day's header). Same rule as
// spending.js's dayOfMonth and the CSV importer.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Order-PRESERVING fold of shaped rows into [{date, rows}] day sections. The
// caller's sort (date desc, amount tiebreak — or search's date desc, id desc)
// is kept verbatim; a date seen again later (never happens on sorted input)
// still lands in its first section, so garbage input degrades to stable
// grouping rather than duplicate headers.
export function groupByDay(rows) {
  const sections = [];
  const byDate = new Map();
  for (const t of rows || []) {
    const date = String((t && (t.transaction_date || t.date)) || '');
    let section = byDate.get(date);
    if (!section) {
      section = { date, rows: [] };
      byDate.set(date, section);
      sections.push(section);
    }
    section.rows.push(t);
  }
  return sections;
}

// 'August 14, 2026' from a 'YYYY-MM-DD' string. Anything that doesn't parse
// as a complete ISO date comes back AS-IS — a garbage date renders as itself
// under its own header rather than throwing mid-render or claiming a wrong
// day (the honest degrade).
export function longDate(iso) {
  const s = String(iso || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || !day) return s;
  return `${month} ${day}, ${m[1]}`;
}
