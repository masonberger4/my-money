// Keeps the CI smoke harness honest.
//
// test/smoke renders the REAL Dashboard against mocked I/O, aliasing exactly
// the four modules CLAUDE.md says Dashboard may import through. The failure
// mode without this test: someone adds a dataAdapter export, Dashboard imports
// it, and the harness dies at runtime with "does not provide an export named
// …" — surfacing as a mysterious CI smoke failure with no clue why, or worse,
// getting the harness quietly deleted for being flaky.
//
// This asserts the mock covers every name Dashboard actually imports, so the
// message says which export to stub. Zero dependencies, like the rest of the
// suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

// The import list Dashboard pulls from each aliased module.
function importedNames(source, moduleSuffix) {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["'][^"']*${moduleSuffix}["']`, 'g');
  const names = [];
  for (const m of source.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      // `foo as bar` — the MOCK must export `foo`, the original name.
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // `export { a, b as c }` — the exported (right-hand) name is what counts.
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const name = (parts[1] || parts[0] || '').trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// Every src file that imports through an aliased module, not just Dashboard:
// Vite scans the whole graph, so a missing stub for CsvImport or
// SimpleFinConnect breaks the harness just as hard.
function allSources(dir) {
  const out = [];
  for (const ent of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
    if (ent.isDirectory()) out.push(...allSources(`${dir}${ent.name}/`));
    else if (/\.jsx?$/.test(ent.name)) out.push(read(`${dir}${ent.name}`));
  }
  return out;
}
const sources = allSources('../src/').join('\n');

for (const [suffix, mockPath] of [
  ['dataAdapter.js', './smoke/mocks/dataAdapter.js'],
  ['db.js', './smoke/mocks/db.js'],
  ['sync.js', './smoke/mocks/sync.js'],
  ['apiClient.js', './smoke/mocks/apiClient.js'],
]) {
  test(`smoke harness mock covers every ${suffix} export src/ imports`, () => {
    const wanted = [...new Set(importedNames(sources, suffix))];
    const have = exportedNames(read(mockPath));
    const missing = wanted.filter(n => !have.has(n));
    assert.deepEqual(
      missing,
      [],
      `test/smoke/mocks/${suffix} is missing ${missing.length} export(s) src/ imports: ` +
        `${missing.join(', ')}. Add a stub there or the CI render check dies with an ` +
        `unhelpful "does not provide an export named" error.`
    );
  });
}

// The harness must be PORTABLE. Its first CI run failed because the mocks were
// copied out of a sandbox with absolute paths baked in ('/home/user/…'), which
// resolve on exactly one machine. Vite reports that as a pre-transform error
// and the render check fails with a stack trace nobody wants to read twice.
test('the smoke harness contains no machine-absolute imports', () => {
  const files = ['./smoke/mocks/dataAdapter.js', './smoke/mocks/db.js', './smoke/mocks/sync.js',
    './smoke/mocks/apiClient.js', './smoke/main.jsx', './smoke/vite.config.js', './smoke/render.mjs'];
  const offenders = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/from\s*['"](\/[^'"]+)['"]/g)) offenders.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(offenders, [], `absolute import path(s) — use a relative path:\n  ${offenders.join('\n  ')}`);
});
