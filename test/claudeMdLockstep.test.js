// CLAUDE.md ↔ repo lockstep, in the test/lockstep.test.js / noPlaid.test.js
// mold: it turns a documented silent breakage into a red test.
//
// The failure it guards (the phantom-reference Gotcha): CLAUDE.md is the only
// guaranteed-loaded memory, and a confident reference to an identifier that no
// longer exists — or NEVER existed (a key row named `visibleAtHide`) —
// terminates exactly the search that would falsify it. Refactors grep call
// sites, never prose, so a phantom is undetectable from the doc side and has
// no alarm anywhere. Three checks convert that absence into a red test:
//
//  (1) every first-column path in the Key-files table exists;
//  (2) every `test/<name>.test.js` token anywhere in the file exists (a test
//      cited in a ship-record section but later deleted should be re-pointed);
//  (3) every identifier-shaped backticked token in the DURABLE sections
//      (Maintenance contract / Architecture / Key files / Conventions /
//      Gotchas) appears somewhere in src/, api/, test/, supabase/, public/,
//      index.html, package.json, or vercel.json — contents OR relative path
//      (some tokens, e.g. `recurringColumns`, exist only as filenames).
//      Ship-record sections (Merged features / Pending / Roadmap) are exempt:
//      past-tense names belong there.
//
// Per the noPlaid lesson, the extraction machinery proves ITSELF: meta-asserts
// guard against a silently empty walk/scan, and an injection self-check runs
// the same pipeline on a mutated copy of the md string (in memory only) and
// asserts the guard fires on a known-bad input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Test-only override so the guard itself can be verified: point the test at a
// mutated COPY of CLAUDE.md in /tmp (inject a fake path row / a phantom
// identifier) and confirm it goes red. Never set in CI or `npm test` — with
// the var unset the real CLAUDE.md is read, and the repo file is never edited.
const mdPath = process.env.CLAUDE_MD_PATH || join(root, 'CLAUDE.md');
const md = readFileSync(mdPath, 'utf8');

// --- allowlist ---------------------------------------------------------------
// Tokens in the scanned sections that are phantoms BY DESIGN — each entry
// carries a one-line justification and pins how many backticked mentions the
// scanned sections hold TODAY. The pin is what keeps the entry from becoming a
// blanket shield: a NEW mention of an allowlisted name (say, a fresh key row
// naming `visibleAtHide` as if it existed) changes the count and goes red; a
// deliberate extra citation bumps the number here, in the same PR.
const ALLOWLIST = {
  // The maintenance contract's + phantom Gotcha's HISTORICAL EXAMPLE of a
  // key-row export that never existed; the whole point is it must stay absent.
  visibleAtHide: { mentions: 2, why: 'the recorded phantom example (contract + Gotcha)' },
  // Deleted at the 2026-08-03 unification; named by the phantom Gotcha as the
  // identifiers whose stale comments misled a session (PRs #63/#69).
  isCheckingAccount: { mentions: 1, why: 'deleted pre-unification helper, cited as history' },
  isHouseholdDepository: { mentions: 1, why: 'deleted pre-unification helper, cited as history' },
  // GitHub MCP tool named in the stale-check-runs Gotcha — an external tool,
  // not a repo identifier.
  get_job_logs: { mentions: 1, why: 'external GitHub MCP tool name, not repo code' },
  // The PR #45 lesson: a vercel.json key that broke the deploy and was
  // removed; the Gotcha records why it must never exist again.
  _csp_derivation: { mentions: 1, why: 'removed-by-design vercel.json key (PR #45 gotcha)' },
  // Hypothetical anti-pattern flag in the setState(null) Gotcha ("gating the
  // effect on an isLoading flag makes it worse") — deliberately not in code.
  isLoading: { mentions: 1, why: 'anti-pattern identifier in prose, never implemented' },
};

// --- corpus: contents of text files + relative paths of ALL files ------------

const OWN_FILE = 'test/claudeMdLockstep.test.js';
const TEXT_EXT = /\.(js|jsx|mjs|css|html|json|sql|toml|md|svg|webmanifest|txt)$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const corpusFiles = [
  ...['src', 'api', 'test', 'supabase', 'public'].flatMap(d => walk(join(root, d))),
  ...['package.json', 'vercel.json', 'index.html'].map(f => join(root, f)),
  // THIS file is excluded: its own source names the allowlist tokens and the
  // self-check's injected phantoms, which must not count as "exists in code".
].filter(f => relative(root, f) !== OWN_FILE);

const corpus =
  corpusFiles
    .filter(f => TEXT_EXT.test(f)) // skip woff2/png bytes; their PATHS still count below
    .map(f => readFileSync(f, 'utf8'))
    .join('\n') +
  '\n' +
  corpusFiles.map(f => relative(root, f)).join('\n');

// --- extraction pipeline (shared by the real checks AND the self-check) ------

// First cell of a Key-files row: exactly one backticked path. The header row,
// the |---|---| separator, and backticks inside the Role cell cannot match.
const keyFilePaths = text =>
  text.split('\n').map(l => l.match(/^\| `([^`]+)` \|/)).filter(Boolean).map(m => m[1]);

const testFileTokens = text =>
  [...new Set([...text.matchAll(/test\/[A-Za-z0-9]+\.test\.js/g)].map(m => m[0]))];

const SCANNED = ['Maintenance contract', 'Architecture', 'Key files', 'Conventions', 'Gotchas'];

function scannedSectionText(text) {
  const sections = text.split(/^## /m).slice(1); // each chunk starts with its heading line;
  // ### subsections stay inside their ## parent, so e.g. the envelope/tax
  // Conventions are scanned while Roadmap's "### Off-Plaid" block is not.
  for (const name of SCANNED) {
    const n = sections.filter(s => s.startsWith(name)).length;
    assert.equal(n, 1, `heading prefix "${name}" matched ${n} sections — a rename silently un-scans it`);
  }
  return sections.filter(s => SCANNED.some(n => s.startsWith(n))).join('\n');
}

// Identifier-shaped: whole token, [A-Za-z_$] start, length >= 3. Excludes CSS
// tokens (--bg), settings keys (dash:cats), paths, dotted/called names — the
// classes whose lockstep is other tests' job or that aren't identifiers.
const ID_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;

const identifierTokens = text =>
  [...new Set([...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]).filter(t => ID_RE.test(t)))];

// Case-sensitive substring against the corpus: deliberately lenient — it can
// only produce false passes, never false failures.
const phantomsIn = (scannedText, allowlist) =>
  identifierTokens(scannedText).filter(t => !(t in allowlist) && !corpus.includes(t));

const backtickedCount = (text, token) => text.split('`' + token + '`').length - 1;

// --- meta: the machinery still extracts (the silently-empty-walk guard) ------

test('corpus walk found the repo', () => {
  assert.ok(corpusFiles.length >= 100, `walk found only ${corpusFiles.length} files`);
  assert.ok(corpus.length > 100_000, `corpus is implausibly small (${corpus.length} chars)`);
  // Spot pins: a path-only token and a content token that must be present.
  assert.ok(corpus.includes('test/recurringColumns.test.js'), 'path corpus missing');
  assert.ok(corpus.includes('markInternalTransfers'), 'content corpus missing');
});

// --- (1) Key-files table paths exist -----------------------------------------

test('every Key-files table path exists', () => {
  const paths = keyFilePaths(md);
  assert.ok(paths.length >= 40, `only ${paths.length} table rows extracted — did the table format change?`);
  const missing = paths.filter(p => !existsSync(join(root, p)));
  assert.deepEqual(missing, [], `Key-files rows naming missing paths:\n${missing.join('\n')}`);
});

// --- (2) every cited test file exists ----------------------------------------

test('every test/<name>.test.js token in CLAUDE.md exists', () => {
  const tokens = testFileTokens(md);
  assert.ok(tokens.length >= 30, `only ${tokens.length} test tokens extracted`);
  const missing = tokens.filter(t => !existsSync(join(root, t)));
  assert.deepEqual(missing, [], `CLAUDE.md cites missing test files:\n${missing.join('\n')}`);
});

// --- (3) phantom identifiers in the durable sections -------------------------

test('no phantom identifiers in the durable sections', () => {
  const scanned = scannedSectionText(md);
  const ids = identifierTokens(scanned);
  assert.ok(ids.length >= 250, `only ${ids.length} identifier tokens scanned — extraction broke?`);
  const phantoms = phantomsIn(scanned, ALLOWLIST);
  assert.deepEqual(
    phantoms,
    [],
    'backticked identifiers in Maintenance contract/Architecture/Key files/' +
      'Conventions/Gotchas that exist nowhere in src|api|test|supabase|public|' +
      'index.html|package.json|vercel.json (fix the doc, or allowlist WITH a ' +
      `justification):\n${phantoms.join('\n')}`
  );
});

// --- allowlist hygiene -------------------------------------------------------

test('every allowlist entry is still a phantom (else it is stale — delete it)', () => {
  const stale = Object.keys(ALLOWLIST).filter(t => corpus.includes(t));
  assert.deepEqual(stale, [], `allowlisted tokens now exist in code — remove the entries:\n${stale.join('\n')}`);
});

test('allowlist mention counts match the scanned sections exactly', () => {
  const scanned = scannedSectionText(md);
  for (const [token, { mentions }] of Object.entries(ALLOWLIST)) {
    const n = backtickedCount(scanned, token);
    assert.ok(n >= 1, `allowlist entry \`${token}\` no longer appears in any scanned section — dead weight, delete it`);
    assert.equal(
      n,
      mentions,
      `\`${token}\` has ${n} backticked mentions in the scanned sections but the allowlist pins ${mentions} — ` +
        'a NEW mention of a by-design phantom is presumed a real phantom; if the citation is deliberate, bump the pin in the same PR'
    );
  }
});

// --- self-check: the guard fires on known-bad input --------------------------

test('injection self-check: a fake key row turns both checks red', () => {
  const fakeRow =
    '| `src/notARealFile.js` | Uses `phantomExportOne` and `isPhantomHelper`. |';
  const sep = '| File | Role |\n|---|---|\n';
  assert.ok(md.includes(sep), 'Key-files table header not found — update the self-check anchor');
  const mutated = md.replace(sep, sep + fakeRow + '\n');
  assert.notEqual(mutated, md);

  // (1) the fake path is extracted and does not exist
  const paths = keyFilePaths(mutated);
  assert.ok(paths.includes('src/notARealFile.js'), 'path extraction missed the injected row');
  assert.ok(!existsSync(join(root, 'src/notARealFile.js')));

  // (3) both injected identifiers are flagged as phantoms
  const phantoms = phantomsIn(scannedSectionText(mutated), ALLOWLIST);
  assert.ok(phantoms.includes('phantomExportOne'), 'phantom scan missed an injected token');
  assert.ok(phantoms.includes('isPhantomHelper'), 'phantom scan missed an injected token');

  // The count pin fires when an allowlisted phantom gains a NEW mention.
  const withExtra = mutated.replace(fakeRow, fakeRow.replace('`phantomExportOne`', '`visibleAtHide`'));
  const n = backtickedCount(scannedSectionText(withExtra), 'visibleAtHide');
  assert.equal(n, ALLOWLIST.visibleAtHide.mentions + 1, 'count pin failed to see the injected extra mention');
});
