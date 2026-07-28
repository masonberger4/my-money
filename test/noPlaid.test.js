// The Plaid removal stays removed — and, more importantly, the code stays
// compatible with the UN-migrated schema.
//
// WHY THIS MATTERS BEYOND TIDINESS
// Every earlier migration was additive, so old code against a new schema was
// always fine and the project's habit is "paste the SQL, then merge". The Plaid
// removal DROPS, which inverts that: the safe order is deploy-then-paste, and it
// is safe only because the deployed code never names a dropped object. If some
// future change reintroduces `plaid_tokens` or `institutions.plaid_credential_key`
// into a query, the request 500s the moment the migration lands — and because
// api/sync.js reads before it syncs, that takes the household's only bank feed
// down while looking like a normal empty dashboard.
//
// So this is a compatibility test wearing a cleanup test's clothes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Objects the remove-plaid migration drops. Naming any of these from shipped
// code is the failure mode above.
const DROPPED = /\bplaid_tokens\b|\bplaid_credential_key\b|\bplaid_item_id\b/;

// Deliberately NOT scanned for:
//   * plaid_tx_id / plaid_account_id — live, adapter-agnostic external-id
//     columns that every feed writes ('sfin:', 'csv:', 'manual:'). The regex
//     above uses word boundaries so these do not match.
//   * needs_reauth — api/sync.js still returns it as a JSON key for SimpleFIN's
//     own auth_failed code. It is not a schema object; the migration removes it
//     from a CHECK constraint, which shipped code never names.
//   * the word "plaid" in prose. Comments explaining why plaid_tx_id keeps its
//     name are the opposite of a problem.

// Strip comments before scanning. The risk this test exists to catch is a
// QUERY naming a dropped object; prose explaining why plaid_tx_id keeps its
// name, or narrating what the Plaid pass used to do, is legitimate and must not
// be blocked. Crude on purpose — it only has to be conservative in the
// direction that matters (never HIDE a real reference), and stripping a `//`
// inside a string literal at worst produces a false positive, which is the safe
// failure.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, incl. JSX {/* ... */}
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // line comments, sparing https://
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|jsx)$/.test(full)) out.push(full);
  }
  return out;
}

const sourceFiles = [...walk(join(root, 'src')), ...walk(join(root, 'api'))];

test('there are source files to scan (guards against a silently empty walk)', () => {
  assert.ok(sourceFiles.length > 10, `only found ${sourceFiles.length} files`);
});

test('no shipped code references a dropped Plaid schema object', () => {
  const offenders = [];
  for (const file of sourceFiles) {
    const text = stripComments(readFileSync(file, 'utf8'));
    text.split('\n').forEach((line, i) => {
      if (DROPPED.test(line)) offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `dropped Plaid objects referenced:\n${offenders.join('\n')}`);
});

// The guard above is only trustworthy if it is known NOT to fire on the columns
// that must survive. Without this, a future "tighten the regex" edit could start
// matching plaid_tx_id, and the fix would look like deleting the very thing the
// migration exists to protect.
test('the guard does NOT flag the surviving adapter-agnostic id columns', () => {
  for (const live of ['plaid_tx_id', 'plaid_account_id']) {
    assert.equal(DROPPED.test(live), false, `${live} must not be treated as removed`);
    assert.equal(DROPPED.test(`  const x = row.${live};`), false);
  }
  // dataAdapter.js is full of legitimate uses — it must scan clean.
  const adapter = stripComments(readFileSync(join(root, 'src', 'dataAdapter.js'), 'utf8'));
  assert.ok(adapter.includes('plaid_tx_id'), 'fixture assumption: dataAdapter uses plaid_tx_id');
  assert.equal(DROPPED.test(adapter), false, 'dataAdapter.js must not trip the guard');
});

test('the plaid npm packages are gone from package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['plaid', 'react-plaid-link']) {
    assert.equal(deps[name], undefined, `${name} is still a dependency`);
  }
});
