# Improvement backlog — 2026-08-04 six-dimension audit (verified)

**Status: ACTIVE worklist.** Successor to `docs/improvement-backlog-2026-08-01.md`
(now audit-record-only). Produced by a six-dimension audit (UX, code health,
performance, security, testing/reliability, data insights) at commit `97c730e`,
2026-08-04; every entry below survived an adversarial refutation pass
(39 findings → 33 verified survivors) with each claim re-checked against the
code. Do not re-audit; implement.

**Relationship to `docs/next-iteration-plan-2026-08-04.md`:** that doc's items
remain valid and are NOT duplicated here — where a finding confirms one of its
items, the entry cross-references it. Its "Pending data/ops tasks FIRST"
ordering still wins: the key rotation, payroll dupe, Discover twins, NEWREZ,
and backfill outrank everything below.

**Ground rules:** CLAUDE.md wins on any conflict — read it first. Standard flow
per batch (workflow rule 3–4): pull → green `npm test` + placeholder-env build
(+ 390px screenshots for UI work) → push → PR → merge. No migrations needed for
anything below. **Delete entries as they ship** (collapse to CLAUDE.md
Merged-features lines), same rule as the 2026-08-01 backlog.

---

## Section 1 — Ready to implement

Grouped into coherent sessions; suggested order A → E (A and B are the highest
value-per-line; C/D/E are independent of each other).

### Session A — silent-failure guards — **SHIPPED 2026-08-04 (this branch)**

All five items landed, with tests for every guard:
- Items 1, 2, 5 in `5aa69e2` — `isRangeExhaustedError` on the three unguarded
  paged loops (shared `pagedSelect`-style guards in `src/dataAdapter.js`),
  client `isMissingColumnError` now name-checks its column (matching the
  `api/sync.js` twin), and the four api/ 500 handlers return a generic
  string + stable code instead of raw error bodies
  (`test/pagedGuards.test.js`, `test/apiErrorSanitize.test.js`).
- Items 3, 4 in `1b9f195` — rollback + alert on the optimistic
  account/debt/tax/entity/mileage writes (the `updateManualBalance` pattern),
  and the `{confirm:'disconnect'}` server-side gate on the simplefin-status
  DELETE (`api/_lib/unlink.js` decisions; `test/unlink.test.js` additions).

### Session B — phone-first UX — **SHIPPED 2026-08-04 (this branch)**

All six items landed:
- Items 1, 5, 6 in `2d438f6` — Unhide confirm surfaces the guessed type
  (pure `unhideConfirmMessage` in `src/unhideConfirm.js`,
  `test/unhideConfirm.test.js`), the expected-bills discoverability hint
  (loaded-but-empty gate, the `getReceiptTxIds` pattern), and Escape-to-close
  (`useEscClose`) + `role="dialog"`/`aria-modal` on every `.overlay` sheet
  (no focus trap, per the pragmatic scope).
- Items 2, 3, 4 in `599ac50` — 32–44px hit areas on the ignore/Upcoming/
  search-clear ✕ glyphs (padding only, no layout change), filter-only search
  (`searchIsActive` in `src/searchFilters.js` + empty-q filter path in
  `searchTransactions`, `test/searchFilters.test.js` additions), and the
  back-gesture sheet dismissal (one shared history entry per overlay stack).
- Review fixes (this commit) — the Dashboard-level Escape handler moved to
  the CAPTURE phase so Escape deterministically closes the TOPMOST layer when
  the tx sheet stacks over CategorySheet/PropertySheet (listener order was
  render-order-dependent); and the back-gesture history sync extracted to the
  pure `src/sheetHistory.js` state machine (`test/sheetHistory.test.js`),
  whose `pendingBack` flag fixes both low findings: a sheet opened while the
  programmatic `back()`'s popstate is in flight no longer pushes a racing
  entry / flash-closes, and a reload-with-sheet-open's stranded
  `{mmSheet:true}` entry is consumed at mount so the first back gesture isn't
  a dead press.

### Session C — performance (network + cache) — **SHIPPED 2026-08-04 (this branch)**

All five items landed, no migrations:
- Items 1, 2, 5 in `6a5b7c0` — vendor chunk split (`manualChunks` in
  vite.config.js: react/react-dom/scheduler → `vendor-react`, @supabase →
  `vendor-supabase`), sw.js ASSET_CACHE prune (`pruneAssetCache`, cap 40
  entries, run after a fresh shell cache; CACHE_VERSION bumped), and the
  three woff2 `<link rel="preload" as="font" crossorigin>` lines in
  index.html.
  **Measured before/after:** one 622 kB main chunk (174 kB gz) → index
  269 kB (75.3 kB gz) + vendor-react 142 kB (45.4 kB gz) + vendor-supabase
  215 kB (55.5 kB gz) — ~101 kB gz of vendor code now survives every deploy
  in the sw cache instead of re-downloading.
- Items 3, 4 in `84c60ad` — `getRecurringCandidates` fetches narrow
  recurring-only columns via the `columns` option (envelope-walk precedent),
  and Trends went lazy like recurring/debt/tax (epoch-invalidated
  `invalidateTrends`; movers stay month-tagged; per-reload burst no longer
  fetches the 6-month window off-tab).
- Review fixes (this commit) — `invalidateTrends` now bumps
  `trendsSeq.current` itself: with another tab active, the effect re-run
  early-returns on the tab guard, so an in-flight Trends load would
  otherwise pass the seq check and cache a pre-invalidation snapshot.
  And `pruneAssetCache` prunes only `/assets/*` keys — the stable-URL
  precache entries (fonts/icons/manifest) also live in ASSET_CACHE and
  cache hits never refresh insertion order, so a whole-cache prune evicted
  the fonts after ~4 deploys and broke the offline shell's font guarantee
  (CACHE_VERSION v5 → v6).

### Session D — code health (dedup + consistency) — **SHIPPED 2026-08-04 (this branch)**

All four items landed, no migrations, no behavior change (façade preserved):
- Items 1, 2, 3 in `ec46f27` — `makeSerializedUpdater`
  (`src/serializedUpdater.js`, pure, zero imports; both
  `updateRecIgnore`/`updateSavedChats` now bind it —
  `test/serializedUpdater.test.js` pins the four invariants incl. the
  swallowed-rejection queue guarantee), the direct `.from('settings')` sites
  routed through db.js (`getSettings`/`deleteSetting` added for the batch-read
  and delete-path callers), the inline PGRST205/42P01 checks replaced by the
  shared `isMissingTableError`, and theme.js's seven unused exports made
  module-private (the trim option; `useTheme`/`initTheme`/`subscribeTheme`/
  `readToken`/`THEME_PREFS` stay the public surface).
- Item 4 in `5abb885` — dataAdapter.js split internally along its documented
  seams into `src/adapters/{envelopeIO,receiptIO,settingsIO,taxIO,shared}.js`.
  INTERNAL modules only `dataAdapter.js` imports; the façade re-exports
  everything, so consumers, return shapes, and the harness's full-match
  `dataAdapter.js` alias are untouched (the mock-harness boundary rule now
  recorded in CLAUDE.md's Key-files row). Per Mason's Section-2 decision this
  ran as its own quiet session, no feature work alongside.
- Review fix (this commit) — the same-PR CLAUDE.md update the maintenance
  rule requires: the Key-files table now records the `src/adapters/*` split,
  the façade-only import rule, and `src/serializedUpdater.js`.

### Session E — testing + security infrastructure (M items)

1. **[M, medium] Test the settings read-merge-write chains.** The three
   comment-only invariants of `updateRecIgnore`/`updateSavedChats` (failed read
   aborts before write; same-device serialization; swallowed rejections don't
   dam the queue) have zero tests — `test/savedChats.test.js` is pure-layer
   only. ~5 tests with the `test/envelopeIO.test.js` recording-fake pattern
   (fake settings table, controllable latency/failure).
2. **[M, medium] Security headers in vercel.json.** No headers block, no CSP
   meta; refresh token in localStorage with zero XSS/clickjacking mitigation.
   Feasible because the app is fully self-contained: CSP (`default-src 'self'`;
   `connect-src` the Supabase host; `img-src 'self' blob: data:` + the storage
   host; `style-src 'unsafe-inline'` for the inline-styled Dashboard; a hash or
   'unsafe-inline' for index.html's pre-paint theme script), frame-ancestors
   'none', nosniff, Referrer-Policy. Verify sw.js shell caching and blob:
   receipt previews under it before merging.
3. **[M, medium] SQL/RLS harness — CONFIRMS next-iteration plan item 6**, which
   owns the base spec (local Postgres 16 stub, cross-household denial,
   simplefin_access invisibility, default fill, storage policy). This audit
   adds two assertions: `current_household_id()` stays public+executable (the
   silent addReceipt break CLAUDE.md flags), and a catch-all
   pg_tables-vs-pg_policies diff so a future table can't ship policy-less.
   Stays an opt-in local check — `npm test` stays Postgres-free.

## Section 2 — Needs Mason — **ALL THREE DECIDED (Mason, 2026-08-04)**

1. **Month-navigation cache invalidation — DECIDED YES and SHIPPED this
   session** (`837f003`): plain month navigation reuses the cached rows;
   invalidation happens only on write/sync/import + the explicit Refresh
   button, and `runSync` completion is hooked to invalidate too.
   `test/invalidationMatrix.test.js` pins the matrix; `test/sync.test.js`
   covers the runSync completion hook. Review fix (same session): the
   foreground-return `refreshTick` bump also invalidates, so a
   re-foregrounded PWA refetches another device's writes instead of
   replaying the warm memo.
2. **Durable assistant throttle — DECIDED: NO.** The per-instance 10/min
   throttle stays as-is; no settings-row/KV limiter (the 2026-08-01
   "pragmatic > enterprise" trade stands). The dollar bound is an **ops
   task, not code: Mason sets a spend cap on the Anthropic key** — recorded
   in CLAUDE.md's Pending section.
3. **dataAdapter.js split (Session D item 4) — DECIDED: gets its own future
   session**, quiet (no feature work alongside), not deferred indefinitely.
   That session ran 2026-08-04 — Session D item 4 above, SHIPPED.

## Section 3 — Refuted / downgraded this round (don't re-propose)

Six of 39 findings were refuted outright in the adversarial pass; the notable
ones, plus surviving-but-downgraded claims, so they don't come back:

- "Android back closes the app" — refuted as stated: the household is
  iPhone-only, so that arm never occurs on real devices. Survives only as the
  modest iOS back-swipe-dismisses-sheets polish (Session B item 4).
- "Fonts blocked behind the 622 kB JS parse" — overstated: Vite emits the CSS
  as its own `<link>`, so fonts wait on CSS fetch/parse. Preload still helps;
  sized low (Session C item 5).
- "RLS entirely untested" as a novel finding — mostly a duplicate of
  next-iteration plan item 6; kept only for its two added assertions
  (Session E item 3). Policy COVERAGE itself was hand-verified complete across
  all 16 migrations — no missing policy exists today.
- "The 2-char search gate is a decided rule" — refuted: it's pre-existing
  search activation, not a recorded decision, so filter-only search
  (Session B item 3) is not relitigation.
- Anything touching the sign conventions, the unified linked-boundary model,
  hidden-by-default, theme tokens, or the envelope walk was screened against
  CLAUDE.md's decided lists; findings that amounted to relitigating those were
  dropped in the pass and are not listed here.
