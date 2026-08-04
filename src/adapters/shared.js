// Internal helpers shared by src/dataAdapter.js and the src/adapters/*.js
// modules it re-exports. INTERNAL ONLY: nothing outside the adapter layer may
// import this file — Dashboard and the harness reach everything through the
// dataAdapter.js façade (the mock-harness boundary rule).

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function monthBounds(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  return { start, end };
}

export function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });
}

export function shiftMonth(year, month, delta) {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// A missing TABLE (PGRST205 from PostgREST's schema cache, 42P01 from
// Postgres). Deliberately separate from the missing-COLUMN test below — the
// api/sync.js gotcha: conflating them reads a column problem as "the feature
// isn't installed" and silently switches a whole feature off.
export function isMissingTableError(error) {
  return error && (error.code === 'PGRST205' || error.code === '42P01');
}

// A missing COLUMN, and it must be THIS column: the name has to appear in the
// error text (PostgREST/Postgres always name it) before the code counts.
// Matching on PGRST204/42703 alone would let a DIFFERENT missing column flip a
// feature's degrade flag — reading, say, an entity_id problem as "debt tracker
// not installed" for the whole session, the exact missing-table/missing-column
// conflation the CLAUDE.md gotcha forbids. Mirrors the test-pinned twin in
// api/sync.js. Exported from the façade for tests only.
export function isMissingColumnError(error, col) {
  if (!error) return false;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  if (!blob.includes(String(col).toLowerCase())) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  return blob.includes('column');
}
