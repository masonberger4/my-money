# CSP derivation — `vercel.json`

The Content-Security-Policy in `vercel.json` is derived from actual code usage
(2026-08-04, audit Session E). It lives here because **`vercel.json` rejects
unknown top-level keys** — a documentation key there fails Vercel schema
validation and the deploy never builds (learned the hard way: PR #45).

`test/securityHeaders.test.js` pins every load-bearing directive, so an edit to
the policy cannot silently drop one. Keep this file in sync when the policy changes.

## Enumerated needs

CSP derived from actual code usage (2026-08-04, Session E item 2). JSON has no
comments, and Vercel REJECTS a documentation key in `vercel.json` (the header
above), so the derivation lives HERE — never move it back into the config,
whatever the underscore-prefixed key is called. The lockstep test
(test/securityHeaders.test.js) pins every load-bearing directive, plus a
top-level-key allowlist that turns a documentation key into a red test instead
of a dead deploy. Enumerated needs:
- script-src 'self' + sha256 hash: index.html's pre-paint theme <script> is the
  ONLY inline script (Vite emits it byte-identical into dist/, verified). The
  hash is recomputed from index.html by the lockstep test — change the script
  and the test tells you the new hash. No 'unsafe-inline', no eval (pdf.js is
  loaded with isEvalSupported:false in src/pdfExtract.js).
- style-src 'self' 'unsafe-inline': the Dashboard is inline-styled JSX and
  index.html carries an inline pre-paint <style>; 'unsafe-inline' in style-src
  also covers style= attributes (style-src-attr falls back to it).
- connect-src 'self' + *.supabase.co (https + wss): supabase-js REST/auth/
  storage (receipt upload/download in src/adapters/receiptIO.js) all hit the
  project's supabase.co host; wss covers realtime if ever enabled (harmless
  now). 'self' covers src/apiClient.js's /api/* calls — the SimpleFIN claim
  and access-URL fetches happen SERVER-side (api/_lib/simplefin.js), never
  from the browser, so no SimpleFIN origin belongs here.
- img-src 'self' blob: data: + https://*.supabase.co: blob: for receipt
  previews/compression (URL.createObjectURL in ReceiptSection.jsx /
  receiptImage.js), data: for any inline icons, supabase host in case a
  signed storage URL is ever rendered directly in an <img src>.
- font-src 'self': fonts are self-hosted woff2 in public/fonts/ (the Google
  Fonts import is gone by decision — never add a font origin back).
- worker-src 'self' blob:: 'self' for public/sw.js registration; blob: as a
  conservative allowance — pdf.js currently runs on the MAIN thread via
  globalThis.pdfjsWorker (src/pdfExtract.js) so no Worker is spawned today,
  but a pdf.js upgrade that quietly spawns a blob worker must not brick
  statement import silently.
- default-src 'self' covers manifest-src (manifest.webmanifest), media, etc.
- object-src 'none', base-uri 'self', form-action 'self', frame-ancestors
  'none' (+ X-Frame-Options DENY for older engines): no embeds, no forms
  posting anywhere, never framed — clickjacking off the table (the refresh
  token lives in localStorage; XSS/clickjacking mitigation is the point).
- Download/share export paths (`downloadCsv` in Dashboard.jsx) use blob: anchor
  downloads / navigator.share — neither is governed by CSP fetch directives,
  so no directive needed.
Companions: nosniff, Referrer-Policy strict-origin-when-cross-origin (no
URL leakage beyond origin), HSTS (Vercel is HTTPS-only), Permissions-Policy
denies powerful features the app never asks for — receipt capture uses a
plain <input type=file>, which needs NO camera permission-policy grant (the
picker is user-mediated). Headers apply to every path incl. /api/* (JSON
responses; CSP is inert but harmless there). Verified compatible with sw.js
shell caching: the service worker fetches same-origin assets only ('self')
and passes cross-origin through.
