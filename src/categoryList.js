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

// The "+ Add category" guard. Case-insensitive against the user's own names AND
// against the mechanism internals — a user-made "Return" would collide with the
// synthesised one on every credit-card refund.
export function isDuplicateCategoryName(name, existing = []) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (MECHANISM_CATEGORIES.some((m) => m.toLowerCase() === n)) return true;
  return existing.some((e) => String(e || '').trim().toLowerCase() === n);
}
