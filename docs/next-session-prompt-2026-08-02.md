
# Prompt for next session — my-money Section 3 batch (card tile, Ask persistence, teach-queue, UX polish)

Copy everything below the line into a fresh session on masonberger4/my-money.

Status start of session: main tip is c06b2fa (PR #28, 2026-08-02). Batch 1, Sections 1–2, and three Section 3 items (recurring badges, envelope pace, assistant fencing) have all SHIPPED — see CLAUDE.md's Merged features. This batch is the decided-and-unbuilt Section 3 remainder that clusters as one session: the cycling card-balance tile, Ask-tab persistence + save-chat, the Uncategorized teach-queue, and two of the three UX-polish items (startup skeleton, month jump picker). Search refinement and the remaining Section 3 items (Trends biggest-movers, recurring weekly/annual cadences + ignore list) are deliberately NOT in this batch — see "Ask Mason vs proceed" at the end. Every file/line pointer below was re-verified against c06b2fa on 2026-08-02 — do not re-audit; implement. Delete entries from `docs/improvement-backlog-2026-08-01.md` as they ship, in the same PR.

---

Work through the four items below. They came from the 2026-08-01 six-dimension audit backlog (`docs/improvement-backlog-2026-08-01.md`), carry Mason's recorded decisions inline, and were checked against CLAUDE.md's decided-don't-relitigate list.

## Ground rules (from CLAUDE.md — read it first, it wins on any conflict)

- **Standard flow for every PR**: `git fetch origin` + absorb `origin/main` → green `npm test` + placeholder-env build (`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`) → push feature branch → PR → merge (auto mode). Fetch + absorb again right BEFORE the merge — other sessions land the same day.
- **Never rebase a pushed branch** — `git merge origin/main` in, re-run tests + build, re-screenshot if the moved code touches UI, then push. Check whether main added dataAdapter exports the harness mocks must stub.
- **Screenshot every UI change at 390×844** via the mock harness (gitignored; recreate per CLAUDE.md's Local checks: Vite app rendering Dashboard.jsx with full-match `resolve.alias` regexes swapping dataAdapter/sync/db/apiClient for mocks; playwright-core, `executablePath:'/opt/pw-browsers/chromium'`). Screenshot BOTH themes for anything that adds surface.
- One PR per item (or the two polish items as one tight pair). A merged branch is finished — restart from current main.
- **No migrations are needed for anything below.** Do not touch sign conventions, the two spending models, theme-token rules (tokens live ONLY in `src/ui.css`; never an inline custom property), or anything in the Gotchas.
- Dashboard.jsx decomposition stays DEFERRED (Mason 2026-08-01) — keep the single file; add to it.

## Item 1 — Cycling card-balance tile (Overview)

**Mason's decision, verbatim (2026-08-01):** "instead of summing, make the tile cycle through cards — clickable on desktop, swipeable on iPhone — to change which card's balance is shown. Notes: it already runs through `displayBalance` and `accounts[0]` is deliberately credit-first; cycle over unhidden credit accounts; remember the selection as a DEVICE pref (localStorage, the `mm:theme` precedent — a settings-table pref would flip the other phone); keep the account name label in sync; swipe needs a touch handler that doesn't fight the page scroll (horizontal-intent threshold)."

Where things are:
- The tile: Dashboard.jsx line 1921 — `{label:"Card balance",val:loading?null:fmt(balance),sub:overview?.accounts?.[0]?.name||"Linked account"}` inside the 3-tile summary grid (lines 1915–1930, a `.map` over an inline array; the cycling tile will need to break out of that uniformity or special-case its index). The balance is computed at line 1659: `displayBalance(overview?.accounts?.[0]?.balance?.current, overview?.accounts?.[0]?.type)`.
- The data: `getOverview()` in `src/dataAdapter.js` lines 151–177 — selects `name, mask, type, current_balance` with `.eq('hidden', false)`, orders credit accounts first, returns `{balance:{current}, name, mask, type}` per account. **There is no `id` in that shape.** Either add `id` to the select and returned shape (additive — existing consumers keep working, which is what "keep return shapes stable" permits) or key the remembered selection on `name`+`mask`. Adding `id` is cleaner; if you do, update the harness mock's getOverview.
- localStorage precedent: `src/theme.js` — key `mm:theme`, EVERY access wrapped in try/catch (Safari private mode throws on access, lines 40–52 and the header comment). Use a sibling key (e.g. `mm:cardTile`), same try/catch discipline. Device/visual prefs go in localStorage; account-level prefs go in `settings` — this is a device pref, per Mason.

Constraints to respect:
- Cycle over **unhidden `type === 'credit'` accounts only** (getOverview already filters hidden). If there are 0 credit accounts, keep today's behavior (first ordered account / em-dash); if 1, no affordance needed.
- Every displayed balance still goes through `displayBalance` — and note the comment at lines 1918–1920: the tile shows whole dollars (`fmt`) because a negative balance with cents wraps at 390px. Keep `fmt`.
- A stored selection that no longer resolves (account hidden/removed since) must fall back to the credit-first default, never render a blank tile.
- Swipe: touch handler with a horizontal-intent threshold (compare |dx| vs |dy| before claiming the gesture) so it never fights vertical page scroll; click/tap advances on desktop. Some visible affordance (e.g. dot indicators or a subtle ‹›) so it doesn't look static — your judgment, screenshot it.
- `displayBalance` display sites are counted by grep, not by a number in CLAUDE.md — you're changing a site, not adding one, so `api/_lib/spendingContext.js` is unaffected.

## Item 2 — Ask-tab persistence + save-chat

**Mason's decision, verbatim (2026-08-01):** "sessionStorage persistence (device-local ephemera; try/catch every access, Safari private mode throws) PLUS a save feature — an explicit 'save this chat' action for conversations worth keeping (a costly Opus answer shouldn't evaporate). Saved chats are deliberate keepsakes, so unlike the ephemeral scrollback they can go durable; simplest v1 is export via the iOS share sheet (the scheduleECsv precedent) — if instead they should live IN the app, that's `settings`-table storage and worth one more sizing question to Mason."

Build the decided v1: sessionStorage scrollback + share-sheet export. Do NOT build in-app saved-chat storage without asking (see the last section).

Where things are:
- Chat state: Dashboard.jsx lines 930–933 (`chatMsgs`/`chatInput`/`chatBusy`/`chatError`), `sendChat` at 957–974, render at ~2878–2934. Messages are plain `{role, content}` objects — trivially JSON-serializable.
- Persistence: hydrate `chatMsgs` from sessionStorage on mount, write on change. **Try/catch every access** (the `src/theme.js` pattern). sessionStorage, not localStorage — scrollback is ephemera, and per-tab scoping is the point. Never persist `chatBusy`/`chatError`.
- Server caps a restored history rides on the next send: `api/assistant.js` — `MAX_TURNS = 30`, `MAX_MSG_CHARS = 8000`, `MAX_TOTAL_CHARS = 60000` (lines 23–30). The server already `.slice(-MAX_TURNS)`s, but a very long restored chat can trip `MAX_TOTAL_CHARS` and 400 — either trim what you persist/restore to fit comfortably under the caps, or surface the server's message (it's user-readable). Don't change the caps.
- Export: `downloadCsv` (Dashboard.jsx lines 148–168) is the share-sheet-first precedent — but it's hardcoded `text/csv`. Generalize it (filename + text + mime) or add a sibling for `text/plain`/markdown; keep the AbortError swallow and the desktop anchor fallback exactly as-is. A "Save chat" affordance in the Ask tab, enabled only when `chatMsgs.length > 0`; a plain-text/markdown transcript with roles and a date header is fine.
- **Update the footer copy at line 2933** — it currently says "Conversations aren't saved." That sentence becomes false; say what's true now (kept on this device until the tab/app closes; Save exports a copy).
- Also add a "New chat" / clear action if you find one is needed once scrollback persists — a stale conversation that can never be dismissed is a regression, not a feature.

## Item 3 — Uncategorized teach-queue

**Backlog entry, verbatim:** "top-5 Uncategorized groups by `merchantKey` feeding the existing `learnMerchant` flow. Inherits the over-specific-key limit (pinned REGRESSION) — fine, groups are just narrow. Whatever list the queue renders must be covered by learnMerchant's refetch (saveTx Gotcha)."

Where things are:
- `UNCATEGORIZED` is imported at Dashboard.jsx line 9; `merchantKey` at line 5. The viewed month's rows are already indexed by effective category in `txsByCategory` (lines 1692–1699) — group `txsByCategory.get(UNCATEGORIZED)` by `merchantKey(txDescriptor(t))` (`txDescriptor` at line 1384 is the string the classifier actually sees — `merchant_name || description`; use it, not raw description, or the taught rule won't fire on the next pull). Top 5 by count (or by summed outflow — your call, say which in the PR).
- The learn flow: `offerToLearn` (1391–1400) currently reads `selTx`, and the confirm UI (`learnPrompt`, lines 3515–3536) renders inside the transaction detail sheet. Two viable shapes: (a) tapping a queue row opens the category picker/detail flow for a representative row so the existing sheet UI is reused, or (b) a queue-local confirm that reuses the same state machine (`applyCategoryRuleToHistory` dry-run → `learnPrompt` → `learnMerchant`). Either way **reuse `learnMerchant` (1420–1442) itself** — it already does `setCategoryRule` → `applyCategoryRuleToHistory` → `reloadData` → `refetchOpenLists` (1406–1418), which is the refetch discipline the backlog demands. Preserve the count-vs-null distinction in the dry-run (`count === null` means the preview FAILED and must not render as "nothing to update" — the comment at 1386–1390 is the pinned lesson).
- Placement: the natural home is the Categories tab, on/under the Uncategorized row (which already gets special treatment at line 2055 — no budget affordance), or inside its `CategorySheet` drill-in. Your judgment; screenshot it.
- Never offer `Uncategorized` itself as a teachable target (it's the fallback, not a pick — same rule as the pickers at lines 3464–3467). Rules never override the transfer/card-payment guards — that's already enforced in the write path; don't add a bypass.
- If the queue caches anything lazily, remember the `setState(null)` Gotcha — use an epoch counter, not a null sentinel. Simplest is to derive from `txs` in render (it's the current month, already on hand) and cache nothing.

## Item 4 — UX polish pair: startup skeleton + month jump picker

**Backlog entry:** "UX polish batch: startup skeleton; month jump picker; client-side search refinement." (Search refinement is EXCLUDED from this batch — see below.)

**Startup skeleton:** `src/App.jsx` returns `null` at line 107 (`session === undefined`) and line 109 (`count === null`), and the EmptyState Suspense fallback is `null` (line 114) — every cold start is a blank page until auth + the institution count resolve. Replace the nulls with a minimal token-styled skeleton (centered card or shimmer blocks on `var(--bg)`). Constraints: `src/ui.css` is global so pre-Dashboard screens get the tokens (that's why the classes were moved there — dark-mode incident); use tokens, no literals, no inline custom properties; index.html's pre-paint background already matches `--bg` (lockstep test pins it) so a token-faithful skeleton won't flash. Dashboard's own `Sk` (Dashboard.jsx line 214) is the visual precedent but lives inside Dashboard — a tiny local skeleton in App.jsx is fine, don't export/import across the lazy boundary and drag chunks into the main bundle (the EmptyState lazy-load comment at App.jsx lines 4–6 explains the trap). Keep the existing null-vs-Login-vs-EmptyState decision order (lines 106–119) exactly — the count-error handling comment at 69–73 is a Gotcha.

**Month jump picker:** navigation today is one month at a time — `prevMonth`/`nextMonth`/`goCurrentMonth` (Dashboard.jsx 1121–1123), rendered as ‹ / label / › in the header (1850–1859). Add a way to jump straight to a month/year (tap the `monthLabel` h1 to open a small picker sheet — precedent: the Recurring tab already jumps months directly via `setYear(...); setMonth(...); setTab("overview")` at lines 2957/2970). Constraints: only the Budget tab may view future months — every other tab snaps back (`isFuture` handling, lines 1939–1941, and `canNext` gating `nextMonth`); the picker must enforce the same rule (clamp to current month unless `tab === "budget"`). Don't use `<input type="month">` blindly — remember the `<input type="date">` mid-typing garbage Gotcha; a tap-a-month grid sheet avoids the whole class. Reuse the existing sheet/overlay patterns; screenshot at 390px.

## Ask Mason vs proceed

**Proceed without asking** (decided, recorded): items 1–3 as specced above; the startup skeleton and month jump picker (pure UX polish, no data model contact — but they're preference-shaped in their details, so screenshots in the PR are the accountability).

**Ask Mason before building:**
1. **In-app saved chats** — the backlog explicitly reserves this: share-sheet export ships now; if saved chats should instead live IN the app, that's `settings`-table storage and "worth one more sizing question to Mason". Ask; don't build speculatively.
2. **Search refinement** — the backlog line is three words ("client-side search refinement") with no recorded spec, and search already composes with the account and category chips (Dashboard.jsx 1648–1652). Propose a concrete scope to Mason (e.g. amount-range / date-range narrowing of `searchRes`, or a debounce on the `searchQ` effect at 1312–1322) and wait — an unspecced UX item built on guesswork is exactly what the backlog process exists to avoid.
3. Anything that would touch `getOverview`'s existing fields (adding `id` is fine and additive; renaming/reshaping is not).

**Not in this batch** (still in the backlog, don't start them): Trends biggest-movers; recurring weekly/annual cadences + ignore list (the ignore list is a household pref → `settings` table, NOT localStorage — recorded so nobody inverts it later); Dashboard.jsx decomposition (DEFERRED by Mason).

## Cross-cutting gotchas this batch must respect (full text in CLAUDE.md)

- **saveTx/patchAllTxLists** (Dashboard.jsx 1458–1480): any list holding transaction rows must be patched via `patchAllTxLists`/covered by `learnMerchant`'s `reloadData` + `refetchOpenLists` — a list that neither reaches keeps pre-edit rows on screen while the DB write lands. The teach-queue derives from `txs` (which `reloadData` refetches), so it self-heals — keep it that way.
- **localStorage vs settings**: device/visual prefs (card-tile selection) → localStorage; household prefs → `settings`. Every localStorage/sessionStorage access try/caught — Safari private mode throws on ACCESS, not just write.
- **Theme tokens only in `src/ui.css`**; never an inline custom property (the dark-mode incident). New surfaces render in both themes — screenshot both.
- **`setState(null)` is not a cache invalidation** — epoch counters if anything lazy is added.
- **`<input type="date">` emits complete garbage while a year is typed** — commit on blur or avoid free-typed date inputs entirely (month picker).
- Run `npm test` before every push; the lockstep suite will catch index.html/ui.css drift if the skeleton touches either.

---
