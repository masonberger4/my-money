// THE ONE CATEGORY LIST (Mason's bug, 2026-08-04: "the three tabs disagree
// about what categories exist").
//
// The app ships no categories — the user creates every one (`dash:cats`) and
// teaches which merchants belong to it (see src/categoryMap.js). So there is
// exactly one answer to "what categories exist": the registry, plus any name
// still carried by real data (a category on a row, a budget, a target, an
// envelope) that isn't in the registry yet — a legacy label from before the
// wipe, or one whose registry entry was retired while rows still point at it.
// Dropping those would make money vanish from every picker while still sitting
// in the ledger.
//
// Pure, zero imports beyond the mechanism predicate, so the Categories tab, the
// Budget tab, the Transactions chips and every picker can all call it and
// cannot drift.
import {
  isBudgetableCategory,
  TRANSFER_CATEGORY,
  RETURN_CATEGORY,
  UNCATEGORIZED,
} from './categoryMap.js';

// Named here only so the duplicate-name guard can compare case-insensitively;
// the SET is still defined by isBudgetableCategory, never by this array.
export const MECHANISM_CATEGORIES = [TRANSFER_CATEGORY, RETURN_CATEGORY, UNCATEGORIZED];

// The three mechanism categories ('Transfers and card payments', 'Return',
// 'Uncategorized') are internals: the spending model reads them, the user never
// creates, renames or retires them, and they are never offered in a picker.
// `isBudgetableCategory` is exactly that set's complement, which is why this
// filters on it rather than keeping a second copy of the names.
export function isUserCategory(name) {
  return typeof name === 'string' && name.trim() !== '' && isBudgetableCategory(name.trim());
}

// registry: the names in `dash:cats`, in creation order.
// inUse:    every category name observed on real data this render (spending
//           groups, budgets, by-date targets, envelope rows, rows in view).
// getName:  the display alias (`dash:names`) — sorting is by what is READ, so a
//           renamed category sits where its label says, not where its raw key
//           would. Order is stable across months/tabs, which is what lets a
//           horizontally scrolling chip row be usable.
export function userCategoryList({ registry = [], inUse = [], getName } = {}) {
  const label = typeof getName === 'function' ? getName : (c) => c;
  const seen = new Set();
  const out = [];
  for (const raw of [...registry, ...inUse]) {
    const n = typeof raw === 'string' ? raw.trim() : '';
    if (!n || seen.has(n) || !isUserCategory(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => String(label(a)).localeCompare(String(label(b)), undefined, { sensitivity: 'base' }));
}

// Which of the one list has no row yet on a surface that renders rows. Used by
// BOTH the Categories tab and the Budget tab so the two lists are the same set
// of names by construction rather than by two similar-looking expressions.
export function missingCategories(list, presentNames) {
  const present = presentNames instanceof Set ? presentNames : new Set(presentNames || []);
  return list.filter((n) => !present.has(n));
}

// `names` in the one list's order: each name at its position in `list`
// (display-name order), and any name the list does not carry — the mechanism
// rows (Uncategorized, transfers), which never enter it — after all of them in
// their incoming order. Stable; never drops or duplicates a name. The Plan tab
// orders its envelopes with this, so a row stays put when it gets its first
// dollar or its first spending (the walk's own order, budgeted-first by raw
// label, made it jump to the top and put the next tap on another envelope).
export function rankByList(names = [], list = []) {
  const rank = new Map();
  (list || []).forEach((n, i) => { if (!rank.has(n)) rank.set(n, i); });
  const tail = (list || []).length;
  return (names || [])
    .map((n, i) => ({ n, i, k: rank.has(n) ? rank.get(n) : tail + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.n);
}

// The "+ Add category" AND rename guard. Case-insensitive against the user's
// own names AND against the mechanism internals — a user-made "Return" would
// collide with the mechanism one, which stored rows may still carry.
//
// opts (all optional; the two-argument form is unchanged):
//   aliases — `dash:names` ({raw: display}). A live category's DISPLAY name is
//             taken too: a new "Dining" beside Food-renamed-"Dining" renders
//             two identical rows with spending, budgets and envelopes split
//             across two raw keys. Only aliases of LIVE names (existing ∪
//             inUse) count — a retired category's leftover alias shows nowhere.
//   inUse   — names real data still carries (userCategoryList's inUse). A CASE
//             VARIANT of one collides; the EXACT name does not, because adding
//             it re-registers that same raw key (the retire-and-re-add path).
//   self    — the raw name being RENAMED: its own raw name and alias don't
//             count against it.
export function isDuplicateCategoryName(name, existing = [], { aliases = {}, inUse = [], self = null } = {}) {
  const raw = String(name || '').trim();
  const n = raw.toLowerCase();
  if (!n) return false;
  const norm = (v) => String(v ?? '').trim();
  const me = self == null ? null : norm(self);
  if (MECHANISM_CATEGORIES.some((m) => m.toLowerCase() === n)) return true;
  const names = (existing || []).map(norm).filter((e) => e && e !== me);
  if (names.some((e) => e.toLowerCase() === n)) return true;
  const used = (inUse || []).map(norm).filter((u) => u && u !== me);
  if (used.some((u) => u !== raw && u.toLowerCase() === n)) return true;
  const live = new Set([...names, ...used]);
  for (const [k, v] of Object.entries(aliases && typeof aliases === 'object' ? aliases : {})) {
    const key = norm(k);
    if (key === me || !live.has(key)) continue;
    if (norm(v) && norm(v).toLowerCase() === n) return true;
  }
  return false;
}
