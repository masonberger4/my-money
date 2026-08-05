// ONE LEVEL OF CATEGORY NESTING (Mason, 2026-08-05): "Transportation" is a
// parent; "Gas", "Parking", "Maintenance" are its subcategories — "we want
// totals for both."
//
// ── WHAT IS AND ISN'T STORED ────────────────────────────────────────────────
// A transaction still stores exactly ONE label, and it is the LEAF: a gas
// purchase is tagged 'Gas', never 'Transportation/Gas' and never both. The
// parent relationship lives ONLY in the `dash:cats` registry, as an optional
// `parent` field holding the PARENT'S NAME.
//
// That is what makes this feature cheap, and the cheapness is the point:
//   • no migration and no schema change — the registry is a settings JSON blob;
//   • every learned rule (`category_rules`), budget row, `budget_months` row,
//     tax mapping (`tax:maps`) and envelope keeps working untouched, because
//     all of them are keyed on the same leaf label as before;
//   • nesting is presentation + arithmetic. Deleting the whole `parent` field
//     from the registry returns the app to its pre-nesting behaviour and loses
//     no money and no user data.
// Corollary, and the reason chips stay leaf-level: rows carry leaf labels, so
// a chip row derived from the rows in view can only ever be leaves.
//
// ── THE RULES THIS MODULE ENFORCES ──────────────────────────────────────────
//  1. ONE level only. A subcategory can never itself have children, so a name
//     that is already someone's parent cannot be given a parent, and a name
//     that already has a parent cannot be made one.
//  2. A MECHANISM category ('Transfers and card payments', 'Return',
//     'Uncategorized') is never a parent and never a child. They are internals
//     the spending model reads; the user cannot create, rename or retire them,
//     so they cannot be arranged either.
//  3. Names stay globally unique (isDuplicateCategoryName already enforces it)
//     because the leaf label is what transactions store — two "Gas" under
//     different parents would be one category to the ledger.
//  4. A dangling or illegal parent is DROPPED, never obeyed: the category
//     renders top-level. Same instinct as the one-list rule — a registry edited
//     on another device must degrade to "no nesting", never to a vanished
//     category.
//
// Pure, one import (the mechanism predicate) so every tab can call it.
import { isUserCategory } from './categoryList.js';

// child name -> parent name, for every link that is legal under the rules
// above. Two passes: collect the raw claims, then keep only those whose parent
// exists, is itself parentless, and isn't the child.
//
// `registry` is `dash:cats` as stored: [{id,name,color,parent?}]. `known` is
// optionally the full one-list (userCategoryList) — a parent that has been
// retired from the registry but is still carried by real data stays a legal
// parent, for the same reason the one list keeps it: dropping it would move a
// child out from under a heading whose money is still in the ledger.
export function parentIndex(registry = [], known = []) {
  const names = new Set();
  for (const n of [...(registry || []).map((c) => (c?.name || '').trim()), ...known]) {
    if (isUserCategory(n)) names.add(String(n).trim());
  }
  const claims = new Map();
  for (const c of registry || []) {
    const child = (c?.name || '').trim();
    const parent = (c?.parent || '').trim();
    if (!child || !parent) continue;
    if (!isUserCategory(child) || !isUserCategory(parent)) continue; // rule 2
    if (child === parent) continue;
    if (!names.has(parent)) continue; // rule 4: dangling parent -> top-level
    if (claims.has(child)) continue; // first claim wins; names are unique
    claims.set(child, parent);
  }
  // Rule 1, applied last so it can see every claim: a parent that is itself
  // someone's child is not a legal parent, and the grandchild flattens to
  // top-level rather than silently re-parenting to the grandparent (which would
  // move money under a heading the user never chose).
  const index = new Map();
  for (const [child, parent] of claims) {
    if (claims.has(parent)) continue;
    index.set(child, parent);
  }
  return index;
}

export function parentOf(index, name) {
  return (index instanceof Map ? index.get(name) : null) || null;
}

export function hasChildren(index, name) {
  if (!(index instanceof Map)) return false;
  for (const p of index.values()) if (p === name) return true;
  return false;
}

// The "Part of…" picker's options for `self`: top-level (a child can't be a
// parent — rule 1), non-mechanism, and not `self`. `self` may be null (creating
// a brand-new category — it has no children yet).
//
// If `self` ALREADY has children it can take no parent at all, so this is
// empty: filing it under something would make three levels. The UI reads the
// empty list as "no picker", which is why that case lives here rather than as a
// second condition each caller has to remember.
export function eligibleParents(list = [], index, self = null) {
  if (self != null && hasChildren(index, self)) return [];
  return list.filter(
    (n) => isUserCategory(n) && n !== self && !parentOf(index, n)
  );
}

// Can `child` be filed under `parent`? Returns a reason string when not, so the
// UI can say why rather than just disabling something.
export function canSetParent(index, child, parent) {
  if (!isUserCategory(child)) return { ok: false, reason: 'That category is managed by the app.' };
  if (parent == null || parent === '') return { ok: true, reason: null }; // removing
  if (!isUserCategory(parent)) return { ok: false, reason: 'That category is managed by the app.' };
  if (child === parent) return { ok: false, reason: "A category can't be part of itself." };
  if (parentOf(index, parent)) return { ok: false, reason: `${parent} is already part of another category — only one level of nesting.` };
  if (hasChildren(index, child)) return { ok: false, reason: `${child} has subcategories of its own — only one level of nesting.` };
  return { ok: true, reason: null };
}

// Registry transform. Returns a NEW array; `parent` null/'' removes the link.
// Removing a parent touches nothing but this field — no transaction, budget,
// rule or envelope moves, because none of them ever referenced it.
export function setRegistryParent(registry = [], name, parent) {
  const target = String(name || '').trim();
  const p = parent == null ? '' : String(parent).trim();
  return (registry || []).map((c) => {
    if ((c?.name || '').trim() !== target) return c;
    const next = { ...c };
    if (p) next.parent = p;
    else delete next.parent;
    return next;
  });
}

// Display order: the CALLER'S order is preserved for top-level rows, and each
// parent's children sit directly beneath it. Order-preserving rather than
// sorted on purpose — the Categories tab hands its rows biggest-spend-first and
// the Budget tab hands them walk order, and "categories with no parent render
// exactly as they do today" is the promise nesting must not break. Children are
// ordered among themselves by DISPLAY name (they are a new list, so there is no
// prior order to preserve, and a renamed child sits where its label says).
//
// Any name in `list` whose parent isn't in `list` renders top-level — the list
// is the one list, so this is the same degrade as rule 4.
export function groupCategories(list = [], index, getName) {
  const label = typeof getName === 'function' ? getName : (c) => c;
  const present = new Set(list);
  const byParent = new Map();
  const tops = [];
  for (const n of list) {
    const p = parentOf(index, n);
    if (p && present.has(p)) {
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(n);
    } else {
      tops.push(n);
    }
  }
  const cmp = (a, b) => String(label(a)).localeCompare(String(label(b)), undefined, { sensitivity: 'base' });
  return tops.map((name) => ({
    name,
    children: (byParent.get(name) || []).sort(cmp),
  }));
}

// Every label whose money belongs under a group heading: the parent's OWN rows
// plus its children's. The parent is included deliberately — a user who tagged
// transactions to "Transportation" before adding "Gas" still has those rows,
// and a rollup that dropped them would make money disappear off the tab.
export function groupMembers(node) {
  return [node.name, ...(node.children || [])];
}

// Sum named numeric fields across a group's members. `rowOf(name)` returns that
// category's row or undefined (a member with no row this month contributes 0).
// Used by both the Categories tab (amount, transaction_count) and the Budget
// tab (assigned, rolledOver, spent, available) so the two rollups cannot use
// two different folds.
export function rollupFields(members = [], rowOf, fields = []) {
  const out = {};
  for (const f of fields) out[f] = 0;
  for (const name of members) {
    const row = typeof rowOf === 'function' ? rowOf(name) : null;
    if (!row) continue;
    for (const f of fields) {
      const v = Number(row[f]);
      if (Number.isFinite(v)) out[f] += v;
    }
  }
  return out;
}
