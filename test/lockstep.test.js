// Static lockstep guards, in the test/noPlaid.test.js mold: each turns a
// documented silent breakage into a red test.
//
//  (a) index.html's theme-color metas and pre-paint background are hardcoded
//      copies of ui.css's --bg values, parsed before any stylesheet loads —
//      CLAUDE.md says they must change in lockstep with --bg.
//  (b) public/sw.js must never cache /api/*, and any change to it needs a
//      CACHE_VERSION bump — so both must at least exist.
//  (c) pdf.js must be the LEGACY build: the modern bundle throws
//      "getOrInsertComputed is not a function" on real devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

// --- (a) theme-color / pre-paint background vs ui.css --bg -------------------

function cssHex(css, token) {
  const m = css.match(new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{3,8})\\b`));
  assert.ok(m, `ui.css must define ${token} as a hex literal`);
  return m[1].toUpperCase();
}

test('index.html theme-color metas equal ui.css --bg values (light and dark)', () => {
  const css = read('src/ui.css');
  const html = read('index.html');
  const light = cssHex(css, '--light-bg');
  const dark = cssHex(css, '--dark-bg');

  const meta = scheme => {
    const m = html.match(
      new RegExp(
        `<meta name="theme-color" content="(#[0-9A-Fa-f]{3,8})" media="\\(prefers-color-scheme: ${scheme}\\)"`
      )
    );
    assert.ok(m, `missing theme-color meta for ${scheme}`);
    return m[1].toUpperCase();
  };
  assert.equal(meta('light'), light, 'light theme-color drifted from --light-bg');
  assert.equal(meta('dark'), dark, 'dark theme-color drifted from --dark-bg');
});

test('index.html pre-paint backgrounds use ONLY the two --bg values, covering base + forced themes', () => {
  const css = read('src/ui.css');
  const html = read('index.html');
  const light = cssHex(css, '--light-bg');
  const dark = cssHex(css, '--dark-bg');

  const backgrounds = [...html.matchAll(/background:\s*(#[0-9A-Fa-f]{3,8})\b/g)].map(m =>
    m[1].toUpperCase()
  );
  assert.ok(backgrounds.length >= 4, 'base light/dark + forced light/dark');
  for (const hex of backgrounds) {
    assert.ok(hex === light || hex === dark, `pre-paint background ${hex} is neither --light-bg nor --dark-bg`);
  }
  assert.ok(backgrounds.includes(light) && backgrounds.includes(dark));
});

// --- (b) service worker ------------------------------------------------------

test('sw.js keeps the /api/ passthrough guard and a CACHE_VERSION line', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/, 'financial responses must never be cached');
  assert.match(sw, /^const CACHE_VERSION = /m);
});

// --- (c) pdf.js legacy build -------------------------------------------------

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|jsx)$/.test(full)) out.push(full);
  }
  return out;
}

test('every pdfjs-dist import in src/ uses the LEGACY build', () => {
  const offenders = [];
  let found = 0;
  for (const file of walk(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/['"](pdfjs-dist[^'"]*)['"]/g)) {
      found++;
      if (!m[1].includes('/legacy/build/')) {
        offenders.push(`${relative(root, file)}: ${m[1]}`);
      }
    }
  }
  assert.ok(found >= 2, `expected pdf.js imports to exist (found ${found}) — if pdf.js moved, move this test`);
  assert.deepEqual(offenders, [], `non-legacy pdf.js imports:\n${offenders.join('\n')}`);
});
