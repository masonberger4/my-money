import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Every api/ route's 500 handler must return a generic string + stable code —
// never a raw upstream body or err.message (a whole PostgREST error object,
// schema details, config paths). Log full server-side, sanitize client-side:
// the sanitizeFeedMessage discipline applied to the generic catch. This scan
// extracts each `res.status(500).json(...)` argument and asserts it never
// references the caught error object.

const apiDir = fileURLToPath(new URL('../api', import.meta.url));

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Balanced-paren extraction of the .json( ... ) argument text.
function json500Args(src) {
  const args = [];
  const re = /\.status\(500\)\s*\.json\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    args.push(src.slice(re.lastIndex, i - 1));
  }
  return args;
}

test('no api/ 500 handler echoes the caught error to the client', () => {
  const files = jsFiles(apiDir);
  assert.ok(files.length > 0, 'api/ scan found no files');
  let handlers = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const arg of json500Args(src)) {
      handlers++;
      assert.doesNotMatch(
        arg,
        /\berr\b|\berror\s*[.?[]|\.message\b|\.response\b|\.data\b/,
        `${f}: 500 body references the caught error: ${arg.trim()}`
      );
    }
  }
  // The known handlers (unlink-institution, simplefin-status, simplefin-claim,
  // assistant ×2, sync) — if this drops to 0 the extractor regressed, not the code.
  assert.ok(handlers >= 6, `expected >=6 500 handlers, scanned ${handlers}`);
});

test('the four named routes return stable codes from their catch-alls', () => {
  const want = {
    'unlink-institution.js': 'unlink_failed',
    'simplefin-status.js': 'status_failed',
    'simplefin-claim.js': 'claim_failed',
    'assistant.js': 'assistant_error',
    'sync.js': 'sync_failed',
  };
  for (const [file, code] of Object.entries(want)) {
    const src = readFileSync(join(apiDir, file), 'utf8');
    assert.ok(src.includes(`error: '${code}'`), `${file} missing stable code ${code}`);
  }
});

// sync.js returns per-result errors inside a 200 — outside the 500 scan above —
// and SimpleFinConnect renders results[].error verbatim in the connect modal,
// the same surface as last_error (sanitized a few lines earlier for exactly
// that reason). Deliberately a narrow literal pin on the two sites: widening
// the general scan to every `error:` property would false-positive on
// legitimate internal shapes.
test('sync.js sanitizes the client-visible per-result error strings', () => {
  const src = readFileSync(join(apiDir, 'sync.js'), 'utf8');
  // The fallback goes AFTER the sanitize, not before: sanitizeFeedMessage can
  // strip a real message to '', and a falsy results[].error reads as a CLEAN
  // pull to pullWasClean — silently unlocking the statement-import gate on a
  // failed pull (adversarial-review catch, 2026-08-12).
  assert.ok(
    src.includes("error: sanitizeFeedMessage(message) || 'Unknown error'"),
    'the per-access-row failure must sanitize results[].error, falling back AFTER so .error stays truthy'
  );
  assert.ok(
    src.includes("error: sanitizeFeedMessage(err?.message) || 'Unknown error'"),
    'the pass-level failure must sanitize results[].error, falling back AFTER so .error stays truthy'
  );
  assert.doesNotMatch(
    src,
    /error:\s*(?:message\b|err\?\.message)/,
    'no results[].error site may carry a raw err.message'
  );
});

// --- Client display sites of the sanitized bodies ------------------------------
// The sanitized 500 shape is {error: stableCode, message: humanText}. Every
// client site that renders one must prefer detail.message — showing the code
// ('unlink_failed') is the cosmetic regression the sanitization review caught
// at handleUnlink's alert.
test('handleUnlink alert prefers detail.message over the stable code', () => {
  const dash = readFileSync(
    fileURLToPath(new URL('../src/components/Dashboard.jsx', import.meta.url)),
    'utf8'
  );
  const start = dash.indexOf('async function handleUnlink');
  assert.notEqual(start, -1, 'fixture assumption: handleUnlink exists');
  const body = dash.slice(start, dash.indexOf('const cats=', start));
  assert.ok(
    body.includes('err.detail?.message||err.detail?.error||err.message'),
    'the unlink failure alert must read detail.message first (the Ask tab / describeError pattern)'
  );
});
