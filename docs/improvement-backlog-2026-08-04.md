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

### Session B — phone-first UX (mostly S)

1. **[S, high] Unhide confirm surfaces the guessed type.** Dashboard.jsx
   ~3448–3451: Unhide calls `handleToggleHide` (:2125) in one tap. CLAUDE.md's
   own rule says unhiding IS the act that confirms the guessed type, but the UI
   never shows the guess at that moment. Add a confirm on Unhide only ("Unhide
   as Credit card? Type was guessed from the name — wrong type miscounts
   spending"), or inline the type chips into it. Makes the "eyeball every
   unhide" practice (Pending list, Discover 7933 twins) structural.
2. **[S, medium] Enlarge sub-24px tap targets.** Recurring ignore ✕
   (Dashboard.jsx:4259, ~17px wide, directly beside Expect :4256), Upcoming ✕
   (:2977), search-clear × (:3162). A fat-finger ✕ hides a bill household-wide
   (recoverable only via the collapsed "Ignored (n)" card). Grow hit areas via
   padding/minWidth 32–44; glyphs stay small, no layout change.
3. **[M, medium] Filter-only search.** Dashboard.jsx:2176 gates `searchActive`
   (and the filter-row render :3171) on a 2-char text query, and
   dataAdapter.js:1260 returns empty for `q.length<2` regardless of filters —
   "all transactions over $500 in June" is impossible. Treat non-null
   `buildSearchFilters(...)` as activating too; in `searchTransactions` skip
   the ilike `.or()` when q is empty but filters exist (the amount/date
   conjuncts already build independently, :1268–1270).
4. **[S, medium] Back gesture closes the open sheet, not the app.** Zero
   pushState/popstate in src/; all sheets are state flags. Push one history
   entry when any overlay opens, close it on popstate — a single
   top-of-Dashboard hook. (Refutation caveat: household is iPhone-only, so the
   "Android closes the app" arm never occurs; on iOS the gain is that the
   back-swipe dismisses sheets instead of doing nothing.)
5. **[S, low] Expected-bills discoverability hint.** Dashboard.jsx:2925 renders
   the Upcoming card only when expectations exist; the sole entry point is the
   9px "Expect" button on Recurring. When `expected` is loaded-but-empty
   (non-null ⇒ post-migration, the `getReceiptTxIds` pattern), render one muted
   line: "Track upcoming bills — tap Expect next to a charge on the Recurring
   tab."
6. **[S, low] Escape-to-close + dialog semantics on overlays.** Escape handled
   only in the four inline editors (:405/432/459/488); none of the ~10
   `.overlay` sheets close on it, no `role="dialog"`/`aria-modal` anywhere.
   One shared keydown hook + role/aria-modal on `.modal`. Pragmatic scope: no
   full focus trap for a two-user app.

### Session C — performance (network + cache)

1. **[S, medium] Vendor chunk split.** One 622 kB main chunk (174 kB gz);
   sw.js caches /assets/* by fingerprint, so every deploy (several/day)
   re-downloads all of it. `manualChunks` putting react/react-dom/supabase-js
   in a vendor chunk keeps ~60–70 kB gz cached across deploys. Config-only —
   CONFIRMS and complements next-iteration plan item 4 (tab-level React.lazy is
   the bigger lever but carries the harness-alias caveat); this can ship first.
2. **[S, medium] Prune sw.js ASSET_CACHE.** `public/sw.js` caches every
   /assets/* forever within a CACHE_VERSION (activate only deletes
   differently-NAMED caches, :36–47) — ~0.7–2.5 MB/deploy accumulating until
   iOS evicts the PWA's storage and the whole offline shell at once. Prune in
   `networkFirstShell` after caching a fresh '/' (cap entries, or clear on
   index.html hash change). Bump CACHE_VERSION per the existing rule.
3. **[S, medium] Narrow columns for the Recurring 40-month fetch.**
   `getRecurringCandidates` (dataAdapter.js:1229–1238) pulls the full wide
   TX_COLUMNS + tax columns + join for ~40 months — the app's largest query —
   while detection needs roughly SPEND_TX_COLUMNS + user_description/auto
   fields. Pass a `columns` option (envelope-walk precedent, :934). Bypassing
   the memo is fine — recurring is lazy-cached in Dashboard state.
4. **[M, medium] Make Trends lazy like recurring/debt/tax.** `reloadData`
   (Dashboard.jsx:1538–1550) always fetches `getCashFlow({num_periods:6})` +
   `getBiggestMovers` though both render only on Trends (:4028). Lazy +
   epoch-invalidated (the :1631/1679/1217 pattern) shrinks the per-reload burst
   ~6 months → ~2 of wide rows. Honest trade: current-month callers lose their
   free ride on the 6-month memo entry and fetch 1–2 months directly — still
   strictly fewer rows. Pairs with the Needs-Mason invalidation-scoping item.
5. **[S, low] Preload the three woff2 fonts in index.html.** No
   `<link rel="preload" as="font">`; first visit per device (and post-eviction)
   FOUTs on the login screen. Add three preload links — **with `crossorigin`**
   even same-origin, or the preload double-fetches. (Refutation caveat: fonts
   wait on the built CSS link, not strictly on JS execution — gain real but
   smaller than first claimed.)

### Session D — code health (dedup + consistency, all S except the split)

1. **[S, medium] Extract `makeSerializedUpdater` + route settings I/O through
   db.js.** `updateRecIgnore` (dataAdapter ~841) and `updateSavedChats` (~884)
   are the same promise-chain read-merge-write discipline byte-for-byte; a
   third hand copy that forgets the `.catch(()=>{})` dams the queue after one
   network blip. Also ~8–10 direct `.from('settings')` select/upsert sites
   reimplement db.js's getSetting/setSetting (already a harness-mocked alias) —
   route them through it. Caveats: signatures differ slightly, and two sites
   need a delete path db.js lacks.
2. **[S, low] Call `isMissingTableError` at the three inline
   PGRST205/42P01 sites** (dataAdapter ~400, ~475, ~1528 — declarations hoist).
   Otherwise a future third missing-table code updates the helper and the
   inline sites silently degrade three graceful-degrade paths.
3. **[S, low] Trim theme.js's unused exports** (THEME_STORAGE_KEY, getThemePref,
   setThemePref, resolveTheme, getResolvedTheme, applyTheme,
   subscribeSystemTheme — zero external importers). Either make them
   module-private or test them (`resolveTheme` is pure and trivially
   testable — the better move given the testing culture). Prevents a future
   session "reusing" `setThemePref` and bypassing `useTheme`'s subscription.
4. **[L, medium] Split dataAdapter.js internally along its documented seams**
   (2,319 lines, ~80 exports, seven concerns per its own Key-files row).
   Move envelope I/O (~950–1250), receipt I/O (~1900–2000), tax I/O (~380–500)
   into `src/adapters/*.js` that ONLY dataAdapter.js imports and re-exports —
   the spending.js/ruleHistory.js/monthMemo.js precedent; consumers and the
   harness full-match alias are untouched. NOT covered by the Dashboard.jsx
   deferral, but it's an L with shared module state (feature-detect flags,
   promise chains, memo invalidation) — see the Needs-Mason note on timing.

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
   Session D item 4 below is the spec; treat it as SCHEDULED.

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
