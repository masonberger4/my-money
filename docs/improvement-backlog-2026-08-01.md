# Prompt for Fable 5 — my-money improvement pass

Copy everything below the line into a fresh session on masonberger4/my-money.

---

Work through a prioritized improvement backlog for this repo. The backlog below came from a six-dimension multi-agent audit (UX, code health, performance, security, testing/reliability, data insights) already checked against CLAUDE.md's decided-don't-relitigate list — do not re-audit; implement.

## Ground rules (from CLAUDE.md — read it first, it wins on any conflict)
- Standard flow for every batch: fetch + absorb `origin/main` → green `npm test` + placeholder-env build (`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`) → push feature branch → PR → merge (auto mode). Screenshot UI work at 390px via the mock harness.
- One branch per coherent batch, cut from current main; merge before starting the next batch. Never rebase pushed branches — merge origin/main in.
- No migrations are needed for anything below. Do not touch the sign conventions, the two spending models, theme-token rules, or anything in the Gotchas.
- NOTE: the Debt tracker (roadmap "Next") is ALREADY BEING BUILT in another session on branch `claude/ultracode-app-improvements-ek8nt0` — do not build it, and do not edit the Debt tab if it has merged.
- Batch 1 is the top-3; do them first, in order. Then proceed down section 1, then section 2, checking in with Mason before anything preference-shaped.

## Batch 1 — do first
1. **sw.js ok-guard**: `networkFirstShell` (`public/sw.js:64-74`) does `cache.put('/', fresh.clone())` without checking `fresh.ok`, so a Vercel 500/404 becomes the permanent offline shell until CACHE_VERSION bumps. Guard on `fresh.ok`, bump CACHE_VERSION, pin with a `test/lockstep.test.js` assertion.
2. **Top-level error boundary + feed-health banner** (one PR): generalize `ModalErrorBoundary` out of `CsvImport.jsx` into `src/components/ErrorBoundary.jsx`, wrap Dashboard's root in App.jsx with a themed "something broke — reload" card. And surface feed health outside the SimpleFIN modal: amber banner near Dashboard's existing error banner when `last_pulled_at` is >3 days stale or `last_error` is set, linking to the modal (status endpoint already returns everything).
3. **Optimistic-patch hardening**: centralize the tx-list patch into one `patchAllTxLists` helper closing over all list setters with the derived-field recompute (category/merchant_name via toTxShape rules) inside it; and roll back a failed `saveTx` patch (today `Dashboard.jsx:~1245` only console.errors + reloads the current month, so `searchRes`/`acctTxs` keep asserting a save that failed). Alert like `learnMerchant` does. This unblocks any later Dashboard decomposition.

## Section 1 — remaining quick wins (small, batch sensibly)
- Check the ignored `last_error` write result in `api/sync.js:~607` (supabase-js doesn't throw); optionally make the throttle a conditional update (`.lt('last_attempt_at', cutoff)`) so two phones can't double-hit the Bridge.
- Sanitize feed-controlled text on the claim path: `api/simplefin-claim.js:88,95` returns raw remote-body bytes; `sanitizeFeedMessage` already exists — apply it.
- Assistant request caps in `api/assistant.js`: cap per-message/total bytes and add a simple per-household throttle (shared JWT + no sign-out makes a leaked token a free Opus bill).
- Self-host DM Sans/DM Mono as woff2 `@font-face` (keep ui.css line-1 slot rule); Google Fonts import is render-blocking and never cached offline.
- `React.lazy` the CsvImport and SimpleFinConnect modals (statically imported in Dashboard.jsx but rarely rendered; pdfExtract sets the dynamic-import precedent).
- Recurring: flag price creep (lastAmount > median by >5% — median already computed at `src/recurring.js:81-84`) and derive due-soon/overdue from the existing `nextDate`. Pure module + tests.
- Test `pullWasClean` + `runSync` single-flight in `src/sync.js` (~50 pure lines; its over-strictness caused a production import blockade once).

## Section 2 — high-impact projects (one PR each)
- **DNS-level SSRF fix** in `assertPublicHost` (`api/_lib/simplefin.js:123-158`): name-based blocking only; resolve via `dns.lookup({all:true})`, reject private ranges (add 100.64.0.0/10, `[::]`, NAT64), ideally pin the dialed IP. The one real security hole found.
- **"Remove bank" data-loss guard**: `api/unlink-institution.js:46-51` cascade-deletes accounts/transactions but Restore only re-enables the org (re-pull reaches ~88 days), so CSV/PDF backfill vanishes irrecoverably on a mis-tap. Detect `source in ('csv','pdf')` rows and refuse/confirm, or soft-hide instead of delete.
- **Fetch each month once per reload**: `reloadData` triggers ~8 month-equivalents of `getTransactionsBetween` where ~6 suffice; add a per-reload memo keyed `start|end` (the existing `spendCache` pattern in `dataAdapter.js:512`) + a skip-`markInternalTransfers` flag for purchase-model callers (the envelope walk already opts out).
- **Manual transaction quick-add**: cash spending is unrecordable today; the `manual:` id namespace, manual accounts, and the detail-sheet edit UI all exist.
- **Test `pullOneAccessUrl`** against a fake Supabase client (the `ruleHistory.js` fake-PostgREST pattern) — ~430 untested lines where the advisory deadlock lived; also retire the sticky-off module-scope degrade flags in `api/sync.js:33-34` (columns live since 2026-07).
- **Assistant context: recurring + envelope sections** in `api/_lib/spendingContext.js` — both pure modules importable server-side; must stay byte-deterministic (pin with a test) so prompt caching survives.

## Section 3 — later / ask Mason first
Dashboard.jsx staged decomposition (sheets/formatters → shared TxRow → read-only tabs, only after Batch 1's patch helper); recurring weekly/annual cadences + ignore list; Trends "biggest movers" (inside `isSpend()` lineage); Uncategorized teach-queue (top-5 by merchantKey into the existing learnMerchant flow); UX polish batch (startup skeleton, month jump picker, client-side search refinement, fix the arbitrary `overview?.accounts?.[0]` Card-balance card — sum unhidden credit via `displayBalance`, a fifth display site, keep it consistent with the other four; Ask-tab sessionStorage persistence; envelope pace warning; prompt-injection fencing in the assistant system prompt).
