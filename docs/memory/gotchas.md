## Gotchas

- **SimpleFIN puts advisories about YOUR OWN REQUEST in the same
  `errors`/`errlist` array as broken-bank reports, and the ordinary first pull
  triggers one.** Two live examples: "Requested date range exceeds limit of 90
  days and was capped." (asked >90; data WAS truncated at the old end) and
  "…exceeds recommended range of 45 days. In the future, this may be capped."
  (asked 46–90; purely advisory, nothing lost). `api/sync.js` counted every entry
  as a bank error, which **deadlocked the feed in production**: `last_pulled_at`
  only advances on an error-free pull, so it stayed NULL, so the next pull asked
  for the full `FIRST_PULL_DAYS` window, which re-emitted the notice — forever,
  while each of those pulls wrote hundreds of transactions perfectly well. It
  also blocked ALL CSV/PDF import into EVERY SimpleFIN account, because
  `pullWasClean` treats any `warnings` as unclean. Four rules now:
  (a) `classifyFeedMessage` is an **allowlist** — an unfamiliar message stays an
  error, per-bank structure (`conn_id`/`account_id`) forces error unless the
  `code` is allowlisted, and a "needs attention / reconnect / credential" veto
  beats the range match; (b) requests are **clamped** (`MAX_LOOKBACK_DAYS`, ~88)
  so the hard-cap notice can't arise, at `fetchAccountSet` so the new-account
  backfill is covered too; (c) advisories never reach the result `warnings[]`
  (which `pullWasClean` inspects), travelling in a separate `advisories` key —
  nor `last_error` (rendered in `--danger`) on any ordinary pull; the one path
  that can still put one there is the zero-usable-accounts throw, which is
  pre-existing and self-clears as soon as a bank is linked; (d) **the watermark
  is never used to express
  a coverage shortfall** — stalling it recovers nothing, since the next pull
  computes the same start and is served the same truncated window, so a shortfall
  is *reported* (`coverage_shortfall`) and the watermark still moves. Note the
  shape of this failure: a watermark that never advances has **no alarm
  anywhere** — the only tell was `last_pulled_at` NULL while transactions kept
  arriving. `test/simplefin.test.js` pins the classification, including that a
  novel message stays an error. Related: `pullWasClean` also IGNORES
  `coverage_shortfall` — a shortfall must never block the statement import
  that is its remedy.
- **Nothing in this repo loads `api/*.js` except `test/apiLoads.test.js`.**
  `vite build` bundles only what `src/main.jsx` reaches, and no `src/` file
  imports `api/` — the client talks to those routes over HTTP. So a dangling
  import in a route passes both `npm run build` and (without that test) `npm
  test`, and ships green; it surfaces as a 500 on the first real request. If
  that request is `/api/sync`, the bank feed is dead while the dashboard just
  looks stale. Demonstrated during phase 4: the build reported success with a
  broken `sync.js`.
- **Applied migration files are append-only history.** Several under
  `supabase/migrations/` carry Plaid prose in comments. Correct stale
  explanations in the memory docs (docs/memory/) and the READMEs — never in a migration that has
  already been pasted, or `migrations/` stops describing what the live database
  actually ran. Reading rule: comments in applied migrations are historical
  testimony, not current truth — and symmetrically, a wrong thing discovered
  IN an applied migration gets its correction recorded here (the tax
  Conventions' "two review lows" pattern), so the knowledge isn't lost just
  because the artifact is immutable.
- **A cross-reference to an identifier you cannot grep a DEFINITION for is a
  PHANTOM.** A confident, specific reference terminates exactly the search
  that would falsify it — four code comments naming `isCheckingAccount` /
  `isHouseholdDepository` (deleted at the 2026-08-03 unification) made a
  session tell Mason the opposite of the truth (PRs #63/#69), and a key row
  here named `visibleAtHide`, an export that NEVER existed. Refactors grep
  call sites, never prose, so phantoms are undetectable from the doc side.
  Treat a name found only in comments/docs as proof the surrounding prose
  predates a refactor and keep searching; verify the mechanism in code before
  repeating any doc claim to Mason. Deleting or renaming an export means
  grepping comments/docs (CLAUDE.md and docs/memory/ included) for its name in the same commit.
  `test/claudeMdLockstep.test.js` guards the memory docs' key-row anchors.
- **A source-scan guard that greps for an identifier must be CASE-INSENSITIVE
  — the SETTER survives the getter's spelling.** `test/userOwnedCategories.
  test.js` asserted `doesNotMatch(dash, /pickingCat/)` when the Budget tab's
  dead picker was deleted; the deletion left `setPickingCat(false)` behind in
  `closeAllSheets`, and the capital S walked straight past the guard. The suite
  stayed green on top of a ReferenceError that fired on EVERY back gesture —
  and because the throw lands mid-function, the statements AFTER it
  (`setAddingCat(false)`, `setRulesOpen(false)`) never ran, so a back gesture
  with the add-category or taught-rules sheet open left it on screen. Found
  2026-08-28, ~2 weeks after it shipped, only because a new sheet needed
  `closeAllSheets` to work. Two rules: write these guards `/name/i`, and
  remember that NOTHING local renders Dashboard.jsx — `npm test` and `vite
  build` both pass a ReferenceError in a callback, so the smoke WALK is the
  only thing that can catch one, and only on a path it actually clicks (the
  same alarm gap as the TDZ comment over `anySheetOpen`).
- **A `404` is not proof a deploy went out.** Probing a deleted route returns
  404 straight from Vercel's router without loading any other function, so a
  deploy whose `sync.js` fails at module load passes that check. Probe
  `POST /api/sync` and require **401** (`requireUser` rejecting an
  unauthenticated call proves the module loaded and ran); a module-load failure
  is a 500.
- **A finished GitHub Actions job can serve a stale `in_progress` from the
  check-runs API** — one read once minted a false "reproducible CI hang"
  report to Mason. Same lesson as the 404 bullet: never claim an external
  system's STATE from one probe of a caching layer. Before reporting a CI
  hang/failure, corroborate with a second, independent read: re-fetch minutes
  later, or read the run's per-job LOGS (`gh api` / `get_job_logs` — a
  "running" job whose log tail is unchanged across two polls vs. logs ending
  in a completion line = stale API). A check run reporting `in_progress` WITH
  a populated `completed_at`, or contradicted by its own logs, is stale cache
  — refetch, don't conclude.
- **A wrong/stale Supabase service key is DISGUISED as an expired login.**
  `requireUser` (`api/_lib/supabase.js`) calls `auth.getUser(token)` on the
  SERVICE client, so a bad secret key makes every authenticated `api/` call
  return 401 "Invalid or expired session". After any key rotation or env
  change, "please sign in again" is a SUSPECT, not a shrug. Cheapest positive
  proof: ask the assistant anything (an answer proves `requireUser` passed).
  Strongest: Refresh → Accounts → "Manage Bank Connections" (the bottom pill;
  "Add Account" opens the same modal) → the modal's "Last pull"
  watermark (advances only on a clean pull, works with no new transactions).
  NOT proof: absence of the amber feed banner — it needs a recorded error or
  a >3-day-stale watermark, so a fresh failure is silent for days.
- **The Supabase SQL Editor does NOT surface `raise notice`** — it reports
  `Success. No rows returned` and the notice goes nowhere. So a DO block that
  downgrades a failure to a NOTICE is invisible in exactly the tool this
  project pastes migrations into: the receipts migration's 42501 guard looked
  identical to a clean run. **A guard whose only output is a NOTICE is not a
  guard here.** Pair any such block with a SELECT that asserts the object
  exists (`pg_policies`, `to_regclass`, `storage.buckets`) and run it as a
  separate statement — the assertion is the part you can actually see. Same
  family as the SimpleFIN deadlock: a failure whose only tell is the ABSENCE
  of something has no alarm anywhere. And a verifier must derive from the
  SOURCE OF TRUTH, never from the artifact it checks — `setup_all.sql`'s
  self-check stops where the snapshot does, so it passed green while five
  migrations were missing (a check derived from the artifact is a tautology
  with a green checkmark; `bootstrap_household.sql` is the real check).
- Supabase SQL Editor runs as service_role: `auth.uid()` is NULL, so
  `household_id` defaults DON'T resolve — admin inserts there must set it
  explicitly. (Client inserts are fine — `auth.uid()` resolves.) Same trap in
  `api/` routes: `simplefin_access` deliberately has **no** `household_id`
  default so a service-role insert that forgets it fails loudly.
- Node's `fetch` (undici) throws on any URL containing credentials — "Request
  cannot be constructed from a URL that includes credentials". SimpleFIN access
  URLs are exactly that, so `splitAccessUrl` moves them into an `Authorization`
  header. Don't "simplify" it back to fetching the URL directly.
- The SimpleFIN setup token is user-supplied and the server POSTs to whatever it
  decodes to, so both outbound calls go through `fetchNoOpenRedirect`
  (`redirect: 'manual'`, re-checking scheme + host at every hop). Plain `fetch`
  follows redirects by default, which walks straight past the private-address
  check — a public claim URL can 302 to the cloud metadata endpoint. As of
  2026-08-01 the host check is **DNS-level, not name-level**: `assertPublicHost`
  (async) resolves the hostname and rejects if ANY answer is private/reserved, so
  a public name with a private A record no longer passes; `fetchNoOpenRedirect`
  re-resolves per hop incl. hop 0. It stays a BLOCKLIST because a self-hosted
  SimpleFIN server is legitimate, and a resolve-then-fetch TOCTOU rebinding window
  is knowingly accepted (connect-time IP pinning is impractical in serverless) —
  the threat model is a phished setup token, not a remote attacker.
- A missing-COLUMN error names its table too ("column simplefin_access.
  last_attempt_at does not exist"), so the graceful-degrade checks for a missing
  table and a missing column must be **separate** tests (`isMissingTableError` /
  `isMissingColumnError` in `api/sync.js`). Conflating them reads a column
  problem as "the feature isn't installed" and silently switches the whole feed
  off. Relatedly: never add a column to the body of an already-published
  `create table if not exists` — that's a no-op on a database that already ran
  it. Restate it as `alter table … add column if not exists`.
- PostgREST bulk upsert needs an **identical key set** on every row in the
  array, which is why the SimpleFIN account write splits into a bulk insert for
  new accounts and per-row updates for existing ones — restating type/subtype/
  hidden in a uniform payload is precisely what must not be overwritten.
- Vercel `VITE_*` vars are baked at BUILD time — changing them needs a redeploy
  (check Production AND Preview). Missing client config renders the
  ConfigErrorScreen (App.jsx), not white. **Supabase key naming** (renamed
  upstream 2025): client = the Publishable key (`sb_publishable_…`) in
  `VITE_SUPABASE_PUBLISHABLE_KEY`; server = the Secret key (`sb_secret_…`) in
  `SUPABASE_SECRET_KEY`. The legacy names (`VITE_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, holding legacy anon/service_role JWTs or
  new-style keys) still work as code-level fallbacks — never put a
  `sb_secret_…` value in any `VITE_*` var; it would be baked into the public
  bundle.
- The empty-institution count-query error must NOT fall back to the "connect
  your first account" screen (see App.jsx count handling).
- **A too-strict CSP edit in `vercel.json` breaks production SILENTLY.** Those
  headers are served by Vercel and by nothing else — `npm run build`, `npm
  test` and the mock harness never see them, so a dropped directive or a
  stale `script-src` hash ships green and only fails on the deployed site
  (the pre-paint theme script blocked = a theme flash; a missing
  `connect-src` host = every Supabase call blocked). **`test/securityHeaders.
  test.js` is the guard**: it recomputes the sha256 of index.html's inline
  theme script and pins every load-bearing directive, so editing either side
  turns into a red test. Change the theme script and the test hands you the
  new hash. The per-directive derivation lives in `docs/csp-derivation.md` —
  read it before adding or removing an origin, and never widen a directive to
  make a symptom go away.
- **Line endings are load-bearing; `.gitattributes` forces LF.** The CSP guard
  above sha256s the RAW BYTES of index.html's inline theme script, so CRLF
  changes the digest. A clone under Git's default `core.autocrlf=true` — i.e.
  every stock Windows clone — therefore fails `test/securityHeaders.test.js`
  with a hash mismatch that reads like a broken CSP and sends the diagnosis to
  entirely the wrong file. `* text=auto eol=lf` in `.gitattributes` is what
  prevents it (every tracked file was already LF when that landed, so it
  changed no content). **Never "fix" a hash mismatch by re-deriving the hash
  from a CRLF working tree** — that bakes a wrong hash into the production
  policy, and the test is right to hash raw bytes because that is what Vite
  ships. A clone made before that file existed keeps its CRLF tree: re-clone,
  or `git add --renormalize .`.
- **The other Windows-only failure shape: `path.relative` returns BACKSLASH
  paths there.** Comparing one against a forward-slash literal silently never
  matches — `test/claudeMdLockstep.test.js`'s own-file exclusion did exactly
  that, so on a Windows clone the test's own source (which by design names
  every allowlisted phantom) entered the scan corpus and both allowlist checks
  went red while CI stayed green (found 2026-08-13, the first fresh-clone
  `npm test` on real Windows). Repo-scan tests normalize before comparing or
  publishing a relative path (that file's relPosix helper). Same alarm gap as
  the LF bullet above: CI is Linux-only, so Windows-only breakage has no tell
  short of a human running the suite there — treat any fresh-Windows-clone
  test failure as potentially this class before suspecting the app.
- **`vercel.json` REJECTS unknown top-level keys** — schema validation fails
  the deployment *before it builds*, so the site keeps serving the previous
  deploy while every new push dies with "should NOT have additional property".
  JSON has no comments, so the temptation is to park documentation in a
  `_`-prefixed key: Vercel does NOT ignore it (learned when a `_csp_derivation`
  key shipped in PR #45 and broke the deploy). Documentation about the config
  goes in `docs/`, never inside it. Note the failure shape — `npm run build`
  and `npm test` both pass, because nothing local validates that schema.
  Mechanism added 2026-08-12: `test/securityHeaders.test.js` pins a
  top-level-key allowlist, so an unknown key is a red test locally instead of
  a dead deploy pipeline — add a new legitimate key to the allowlist in the
  same PR.
- iOS PWA: apple-touch-icon must be PNG; service worker (`public/sw.js`) never
  caches `/api/*`; bump its CACHE_VERSION when changing it. The ASSET_CACHE
  prune (cap 40) must target `/assets/*` keys ONLY — the stable-URL precache
  entries (fonts) also live in ASSET_CACHE and cache HITS never refresh
  insertion order, so a whole-cache LRU prune evicts the fonts. index.html's
  woff2 `<link rel=preload>` tags require `crossorigin` EVEN same-origin —
  font fetches are CORS-mode, and without it the preload is wasted and the
  font double-fetched.
- **pdf.js must be the LEGACY build** (`pdfjs-dist/legacy/build/…`). The modern
  bundle calls `Map.prototype.getOrInsertComputed`, which current Chromium and
  iOS Safari don't have — it throws "getOrInsertComputed is not a function" on a
  real device (caught only because the harness drives a real browser). Load it
  with a dynamic `import()` so it stays out of the main bundle.
- **Safari has no `ReadableStream` async iteration** — and pdf.js's
  `getTextContent()` does `for await (const v of readableStream)`, so on EVERY
  iPhone (not just old ones) reading a PDF died with JavaScriptCore's
  "undefined is not a function (near '…i of t…')". `src/pdfPolyfills.js` fills
  it in. The tell: `getDocument` succeeds and `getTextContent` throws. Don't
  mistake this for an old-iOS problem — it isn't version-dependent. Emulate it
  locally by `delete ReadableStream.prototype[Symbol.asyncIterator]`.
- Anything that runs during **render** should still be try/caught — the shared
  `src/components/ErrorBoundary.jsx` (App.jsx wraps Dashboard and EmptyState;
  CsvImport reuses it with a modal-sized fallback, replacing its private
  `ModalErrorBoundary`) is a backstop showing a themed "something broke — reload"
  card, not a substitute for the discipline.
- **`saveTx`'s optimistic patch is the only refresh some lists ever get, and it
  must recompute every DERIVED field of the tx shape.** `reloadData` refetches
  the CURRENT MONTH only, so `transactions` self-heals but `searchRes`
  (cross-month; its effect keys on `searchQ` alone) and `acctTxs` (keyed on
  `selAcct`) do not — miss one and the edit reads as "it didn't save" even
  though the DB write landed. Same for the fields: `toTxShape` DERIVES
  `category` (from `user_category`) and `merchant_name` (from
  `user_description`), so patching only the raw column leaves the old value on
  screen. Both bugs were live — a category change made from the search results
  never appeared, and a rename never appeared anywhere `reloadData` didn't
  reach. `auto_description` exists so the rename (and "reset name") can be
  recomputed without a round trip, exactly like `auto_category`. `counted` is
  the one field that CAN'T be recomputed — it needs the account type, which the
  shape doesn't carry — which is fine only because its sole reader
  (`CategorySheet`) renders from `transactions`.
  Since PR #15 the mechanism is centralized: `patchAllTxLists(id, fields)`
  (Dashboard.jsx) patches all the lists via the pure `patchTxShape`
  (`src/spending.js`, tested) and returns a rollback that the failure path
  applies before alerting — look for the helper, not scattered patch sites;
  QuickAddSheet's insert routes through it too. The invariant above is
  unchanged.
- A bank words the same transaction differently in its CSV and its PDF, so the
  dedup hash differs: importing both formats into ONE manual account
  double-inserts. `transactions.source` records `'csv'|'pdf'` and the importer
  warns on a mix — one format per account.
- A mortgage/loan statement's rows are loan accounting (suspense-account
  postings, reversals), not household spending, and the real payment is already
  in cash flow via the checking feed. Those belong to the future Debt tracker —
  don't import them onto a depository account.
- **A `setState(null)` sentinel is NOT a reliable cache invalidation.** The lazy
  tab caches (`recurring`, `taxData`) are "null means refetch", so every
  invalidation site calls `setX(null)` — but when the value is ALREADY null,
  i.e. a load is in flight, React bails on the identical value, the effect never
  re-runs, and the in-flight request paints a pre-edit snapshot with nothing left
  to supersede it. Gating the effect on an `isLoading` flag makes it worse: it
  suppresses exactly the superseding load a sequence guard needs, so the guard
  becomes dead code and the *stale* response is the one that wins. The Tax tab
  uses an **epoch counter** instead (`invalidateTax` bumps `taxEpoch`, which is
  an effect dep, so a new sequence is always minted and the old response is
  dropped). Invalidate AFTER the write commits, too — a pre-write invalidation
  can start a read that races the UPDATE. Guarded-effect variant:
  `invalidateTrends` must bump `trendsSeq.current` ITSELF — the effect's own
  bump sits behind the tab guard, so an invalidation while another tab is
  active would otherwise let an in-flight load cache a pre-invalidation
  snapshot. And the MONTH-TAGGING lesson (origin: Trends movers): async
  per-month view state must carry its month (`{y,m,list}`) so a transient
  failure after a month switch cannot render the old month's data under the
  new month's labels — the auto-fill preview guard applies the same rule.
- **A ref set ONLY in an effect's cleanup is latched `true` forever under
  StrictMode.** React 18 dev (`<React.StrictMode>`, `src/main.jsx`) runs a
  mount effect **setup → cleanup → setup on the SAME fiber**, and `useRef`
  values survive that simulated unmount — so the cleanup-only form
  `useEffect(() => () => { ref.current = true }, [])` leaves the flag true for
  the component's whole life under `npm run dev`. `CsvImport`'s
  `batchAbortRef` was exactly that shape: every MULTI-FILE batch import created
  its account (`runBatch`), broke before file 0 on the abort check, and
  returned early with no summary, no error and `batchRunning` still true — an
  empty account, zero rows, no message, and a modal frozen on "Importing… 1 of
  N" whose ✕/Escape/backdrop are all disabled mid-run, so the only exit is a
  reload. **Production builds don't double-invoke, so this had NO alarm
  anywhere**: the prod seven-PDF backfill (PR #75) worked while local dev
  silently wrote nothing, and it survived until a fresh-install test
  (2026-08-13) produced an empty account that had to be traced by hand.
  Reset the flag in the effect's SETUP before returning the cleanup; the
  cleanup-only form is pinned red by a source scan in
  `test/csvImport.test.js`. Same family as the SimpleFIN watermark deadlock —
  a failure whose only tell is the ABSENCE of something — with the extra
  twist that dev-only breakage is invisible to CI, which builds but never
  drives the dev server (the Windows-path and CRLF gotchas are the other two
  in this class).
- **`<input type="date">` emits COMPLETE values while a year is typed** —
  "0002-06-15", "0020-06-15", "0202-06-15", "2026-06-15". Committing on `change`
  therefore writes garbage years (and, with an optimistic patch, the later blur
  sees no change and never corrects them). Commit date inputs on **blur**, with
  a sanity floor on the year.
- One Claude session per line of work, branched from current main — two sessions
  off different bases once regressed production (the "iphone-app" incident).
- If pushes stop deploying and GitHub API calls 503, check githubstatus.com
  before debugging webhooks/Vercel — GitHub-side outages happen.
