// Lockstep pins for vercel.json's security headers (Session E item 2, in the
// test/lockstep.test.js mold): a too-strict CSP breaks the deployed app
// SILENTLY (Vercel serves the headers; nothing local exercises them), and a
// future vercel.json edit could just as silently drop the whole block. Each
// test turns one of those into a red test.
//
// The load-bearing sync: the CSP's script-src hash must equal the sha256 of
// index.html's pre-paint theme <script> — Vite emits plain inline scripts
// into dist/ byte-identically, so the source file IS the deployed bytes.
// Changing the theme script without re-hashing would block it in production
// (no theme applied pre-paint) with zero local symptom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const config = JSON.parse(read('vercel.json'));

function cspValue() {
  assert.ok(Array.isArray(config.headers), 'vercel.json must have a headers block');
  const all = config.headers.find(h => h.source === '/(.*)');
  assert.ok(all, 'headers must include a catch-all /(.*) source');
  const csp = all.headers.find(h => h.key === 'Content-Security-Policy');
  assert.ok(csp, 'Content-Security-Policy header must exist');
  return { csp: csp.value, headers: all.headers };
}

function directive(csp, name) {
  const d = csp
    .split(';')
    .map(s => s.trim())
    .find(s => s === name || s.startsWith(name + ' '));
  assert.ok(d, `CSP must carry a ${name} directive`);
  return d;
}

test('CSP exists and pins the app-shaped directives', () => {
  const { csp } = cspValue();
  assert.equal(directive(csp, 'default-src'), "default-src 'self'");
  // Supabase is the only external origin the client talks to (REST/auth/
  // storage); /api/* is 'self'. SimpleFIN is server-side only.
  const connect = directive(csp, 'connect-src');
  assert.ok(connect.includes("'self'"), 'connect-src must allow self (/api/*)');
  assert.ok(connect.includes('https://*.supabase.co'), 'connect-src must allow supabase');
  // Receipt previews are blob: object URLs.
  const img = directive(csp, 'img-src');
  for (const src of ["'self'", 'blob:', 'data:']) {
    assert.ok(img.includes(src), `img-src must include ${src}`);
  }
  // Fonts are self-hosted — 'self' and NOTHING else (the no-cross-origin-font
  // decision, enforced).
  assert.equal(directive(csp, 'font-src'), "font-src 'self'");
  // sw.js registration + headroom for a pdf.js blob worker.
  const worker = directive(csp, 'worker-src');
  assert.ok(worker.includes("'self'") && worker.includes('blob:'), 'worker-src needs self + blob:');
  // Inline-styled SPA + index.html pre-paint <style>.
  const style = directive(csp, 'style-src');
  assert.ok(style.includes("'unsafe-inline'"), 'style-src must allow inline styles');
  // Clickjacking / injection hardening.
  assert.equal(directive(csp, 'frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(directive(csp, 'object-src'), "object-src 'none'");
  assert.equal(directive(csp, 'base-uri'), "base-uri 'self'");
  assert.equal(directive(csp, 'form-action'), "form-action 'self'");
});

test('script-src is hash-locked to index.html pre-paint theme script — no unsafe-inline, no eval', () => {
  const { csp } = cspValue();
  const script = directive(csp, 'script-src');
  assert.ok(!script.includes('unsafe-inline'), 'script-src must never allow unsafe-inline');
  assert.ok(!csp.includes('unsafe-eval'), 'CSP must never allow unsafe-eval');

  // Exactly ONE plain (non-module, non-src) inline script may exist in
  // index.html — the pre-paint theme script — and its hash must be in CSP.
  const html = read('index.html');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(inline.length, 1, 'index.html must have exactly one plain inline script (the theme script)');
  const hash = 'sha256-' + createHash('sha256').update(inline[0]).digest('base64');
  assert.ok(
    script.includes(`'${hash}'`),
    `script-src must carry the theme script's hash '${hash}' — the script changed; update vercel.json`
  );
});

test('companion headers present', () => {
  const { headers } = cspValue();
  const get = k => headers.find(h => h.key === k)?.value;
  assert.equal(get('X-Content-Type-Options'), 'nosniff');
  assert.equal(get('X-Frame-Options'), 'DENY');
  assert.equal(get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.match(get('Strict-Transport-Security') ?? '', /max-age=\d+/);
  assert.ok(get('Permissions-Policy'), 'Permissions-Policy must exist');
});

test('vercel.json carries ONLY known top-level keys', () => {
  // Vercel REJECTS unknown top-level keys: schema validation fails the
  // deployment BEFORE it builds, while the site silently keeps serving the
  // previous deploy — and nothing local validates the schema (PR #45's
  // underscore-prefixed derivation key shipped exactly that way).
  // Documentation about the config goes in docs/, never inside it; a new
  // legitimate key is added to this allowlist in the same PR that adds it
  // to vercel.json.
  assert.deepEqual(Object.keys(config).sort(), [
    'buildCommand',
    'headers',
    'outputDirectory',
    'rewrites',
  ]);
});

test('adding headers did not disturb the SPA rewrite or build config', () => {
  assert.equal(config.outputDirectory, 'dist');
  assert.deepEqual(config.rewrites, [
    { source: '/((?!api/).*)', destination: '/index.html' },
  ]);
});
