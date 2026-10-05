// The display formatters and wall-clock date helpers, pure + zero imports.
// Lifted out of Dashboard.jsx (the "formatters first" step of the deferred
// decomposition — pure helpers only, no JSX moved) so the sign and rounding
// rules every money site depends on are tested in ONE place, and CsvImport's
// former byte-for-byte copy of fmtX (`money`) reads the same function instead
// of being kept in sync by a comment.

// A period's start ('YYYY-MM-DD') as { y, m } read from the STRING. `new
// Date('2026-08-01').getMonth()` is UTC midnight rendered locally, so in any
// western timezone it is July: the Trends bars highlighted the wrong month and
// every tap jumped one month early. Same reasoning as spending.js's dayOfMonth
// and shortDate below — never parse a date-only string through Date().
export function periodYM(start) {
  const s = String(start || '');
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) };
}

// TODAY on the WALL CLOCK, never toISOString(): that is UTC, so from ~5pm
// Pacific onward it is already tomorrow — a quick-added cash entry landed on
// tomorrow's date (next MONTH on the 31st), fell outside the viewed month, and
// read as "it didn't save". CsvImport keeps its own UTC `todayIso`
// deliberately, for feed-boundary math; this is the human-facing one.
export function localTodayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "8th", "21st" — the movers card says WHICH day the comparison month was cut
// at, so a sliced comparison is never mistaken for a whole-month one.
export function ordinalSuffix(n) {
  const d = Number(n);
  if (d % 100 >= 11 && d % 100 <= 13) return "th";
  return { 1: "st", 2: "nd", 3: "rd" }[d % 10] || "th";
}

export function monthLabel(y, m) { return new Date(y,m-1,1).toLocaleString("default",{month:"long",year:"numeric"}); }
export function shortDate(iso) { const [y,m,d]=iso.split("-").map(Number); return new Date(y,m-1,d).toLocaleDateString("default",{month:"short",day:"numeric"}); }
// A Date INSTANT rendered in the reader's own timezone. Deliberately not
// shortDate(d.toISOString().slice(0,10)): that takes the UTC calendar day and
// re-reads it as a local one, so a balance typed at 5:30pm PDT (stored
// 00:30Z the next day) rendered as "as of" TOMORROW — a date that has not
// happened yet where the reader is standing. shortDate stays as it is: its
// callers pass stored 'YYYY-MM-DD' dates, which have no time and no zone.
export function localShortDate(d) { return d.toLocaleDateString("default",{month:"short",day:"numeric"}); }

// Negatives render as −$1,234.56 (U+2212), not $-1,234.56. Debts always
// display negative, and money-in transactions already did, so this is the
// common case rather than an edge one.
//
// The sign comes from the DISPLAYED digits, not the raw float: a fully
// refunded category nets to a residue like −3.55e-15 (10.10 + 20.20 − 30.30),
// and a sign read off that value printed "−$0". A value that rounds to zero
// at the shown precision is unsigned. Deliberately no Math.round pre-round:
// it rounds −2.5 to −2 where toLocaleString rounds half away from zero, so it
// would change digits the app has always shown.
const hasDigit = s => /[1-9]/.test(s);
export function fmt(n) {
  const v = Number(n);
  const s = "$"+Math.abs(v).toLocaleString("en-US",{maximumFractionDigits:0});
  return v < 0 && hasDigit(s) ? "−"+s : s;
}
export function fmtX(n) {
  const v = Number(n);
  const s = "$"+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  return v < 0 && hasDigit(s) ? "−"+s : s;
}
// "$1,234" for whole dollars, "$1,234.56" when there are cents to show.
export function fmtAuto(n) { return Math.round(Number(n)*100)%100===0?fmt(n):fmtX(n); }
// Same displayed-digits rule for the "+": never "+$0".
export function signed(n) { const body=fmtAuto(n); return `${Number(n)>0&&hasDigit(body)?"+":""}${body}`; }

// "Jun 2027" from a 'YYYY-MM-DD' target date.
export function monthYear(dateStr) {
  const [y,m]=String(dateStr||"").slice(0,7).split("-").map(Number);
  if(!y||!m) return "";
  return new Date(y,m-1,1).toLocaleString("default",{month:"short",year:"numeric"});
}

// Keeps a money input to digits with at most one leading "-" and one ".", so
// a fat-fingered "1-2" or "1.2.3" can never reach the adapter. Negatives are
// allowed only where pulling money back out is meaningful (an assignment) —
// never for a target, an income figure or the size of a move.
export function numericish(s,{negative=true}={}) {
  const neg=negative&&s.trim().startsWith("-");
  const [whole,...rest]=s.replace(/[^0-9.]/g,"").split(".");
  return (neg?"-":"")+(rest.length?`${whole}.${rest.join("")}`:whole);
}
