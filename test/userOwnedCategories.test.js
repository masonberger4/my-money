// Static guards for the user-owned category system (Mason's decision,
// 2026-08-04: the app ships NO built-in categories). Each one pins a review
// finding whose failure mode is silent — the app builds, the tests pass, and
// the damage only shows up in production or in the live database.
//
// In the test/lockstep.test.js + test/noPlaid.test.js mold: source-text
// assertions, because these are cross-file/cross-artifact rules (a SQL file, a
// UI string) that no unit test can reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { guessCategory } from '../src/txClassify.js';
import { UNCATEGORIZED, TRANSFER_CATEGORY } from '../src/categoryMap.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const MIGRATION = 'supabase/migrations/20260805000001_user_owned_categories.sql';

// --- The wipe must take category_rules with it -------------------------------
// With the keyword table deleted, learned rules are the ONLY categorizer left.
// A rule surviving the wipe re-mints its deleted taste label onto the next
// synced row, and that label re-enters the one category list (userCategoryList
// admits any non-mechanism name observed on a row) — resurrecting a category
// the user never created, on the branch whose whole premise is that it can't
// happen.
test('the category wipe archives AND clears category_rules', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /create table if not exists legacy_category_rules/,
    'rules must be archived before deletion — the wipe has to be reversible');
  assert.match(sql, /insert into legacy_category_rules select \* from category_rules/);
  assert.match(sql, /delete from category_rules;/,
    'a surviving learned rule writes a deleted taste label back onto new rows');
});

// --- Step 1's idempotency gate must be the marker, not column-nullness -------
// mapped_category is nullable, so `legacy_mapped_category is null` cannot tell
// "nothing to preserve" from "never processed": a re-run would then write the
// POST-wipe 'Uncategorized' into the archive as if it were the original value,
// and the verification would flag a healthy run as data loss.
test('the wipe gates preservation on legacy_categories_saved, not on a null legacy column', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /add column if not exists legacy_categories_saved boolean not null default false/);
  assert.match(sql, /where not legacy_categories_saved;/,
    'step 1 must skip already-processed rows via the marker');
  assert.doesNotMatch(sql, /where legacy_mapped_category is null\s+or legacy_user_category is null/,
    'the nullness gate is the bug: a legitimately-NULL category re-runs forever');
  assert.match(sql, /count\(\*\) from transactions where not legacy_categories_saved/,
    'the verification must assert the marker, not the nullness of a preserved NULL');
});

// --- The destructive half needs a boolean assertion, not a raw count ---------
// "archived 0 rows" and "this household had no envelopes" are the same result
// row otherwise, and by then the DELETE has run. CLAUDE.md: a failure whose
// only tell is the ABSENCE of something has no alarm anywhere.
test('the budget/rule archive is asserted against pre-delete counts', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /create table if not exists legacy_wipe_counts/);
  for (const [step, col] of [['budgets', 'budgets_archived_ok'],
                             ['budget_months', 'budget_months_archived_ok'],
                             ['category_rules', 'rules_archived_ok']]) {
    assert.match(sql, new RegExp(`select '${step}', count\\(\\*\\) from ${step}`),
      `${step} must record its pre-delete count`);
    assert.match(sql, new RegExp(col),
      `${step} needs a boolean archived-ok column, not just a raw count`);
  }
});

// --- Deploy order: the paste window is write-side, not cosmetic --------------
// The OLD build still derives mapped_category at WRITE time, and a sync fires
// on an ordinary dashboard load — so rows written between the paste and the
// deploy carry taste labels the wipe already passed over.
test('the migration tells the operator to paste AFTER the deploy', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /PASTE THIS \*\*AFTER\*\* THE DEPLOY/);
  assert.doesNotMatch(sql, /window is cosmetic/,
    'the paste-to-deploy window writes fresh taste labels; it does not self-heal');
});

// --- No UI may promise categorization the classifier can no longer do --------
test('the quick-add form does not promise auto-detection', () => {
  const dash = read('src/components/Dashboard.jsx');
  assert.doesNotMatch(dash, /auto-detected if left blank/,
    'the keyword classifier is gone — a blank pick lands in Uncategorized');
});

// The promise it replaced has to stay true: an untaught merchant IS
// Uncategorized, while the transfer guards still classify.
test('guessCategory: untaught merchants are Uncategorized, guards still fire', () => {
  assert.equal(guessCategory('FARMERS MARKET'), UNCATEGORIZED);
  assert.equal(guessCategory('SAFEWAY #1234', { rules: { SAFEWAY: 'Food' } }), 'Food');
  assert.equal(guessCategory('TRANSFER TO SAVINGS'), TRANSFER_CATEGORY);
});

// --- The Budget tab's create affordance must be reachable -------------------
// envRows is topped up to the one category list, so the set the old "budget
// another category" picker offered is empty by construction — its button never
// rendered, which made the picker sheet (and the ＋ New category button inside
// it) dead code and left a new household with no way to make a category on the
// Budget tab.
test('the Budget tab has no unreachable category picker', () => {
  const dash = read('src/components/Dashboard.jsx');
  assert.doesNotMatch(dash, /pickingCat/,
    'the picker offered a structurally-empty set; it is dead code');
  assert.doesNotMatch(dash, /unbudgetedCats/);
  assert.match(dash, /New category\s*<\/button>/,
    'the Budget tab must keep a create-category button that actually renders');
});
