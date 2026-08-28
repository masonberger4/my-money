# Self-Hosting Setup Guide

Run your own instance of my-money: a household spending dashboard (React + Vite SPA on Vercel, Supabase Postgres backend, SimpleFIN bank feed). Expect ~30–45 minutes end to end.

## Prerequisites

Accounts you need:

| Account | Cost | Required? |
|---|---|---|
| [Supabase](https://supabase.com) | Free tier works | Yes — database, auth, receipt storage |
| [Vercel](https://vercel.com) | Free tier works | Yes — hosting + serverless `api/` functions |
| [SimpleFIN Bridge](https://bridge.simplefin.org/) | ~$15/yr | Yes, for automatic bank sync (CSV/PDF import works without it) |
| [Anthropic API key](https://console.anthropic.com) | Pay-as-you-go | Optional — powers the "Ask" tab only; without it that tab shows "not configured" and everything else works |

Local tooling: git and **Node 21 or newer (22 recommended)**. The test script relies on `node --test` expanding its own glob (`test/**/*.test.js`), a feature added in Node 21 — on older Node, `npm test` errors out instead of running. There is no pinned `engines` field.

**On Windows**, everything below works in either `cmd.exe` or PowerShell; where the two differ, both forms are given. Two setup notes:

- The repo's `.gitattributes` forces LF checkouts, which `test/securityHeaders.test.js` depends on (it hashes `index.html`'s raw bytes against the CSP pin in `vercel.json`). You don't need to change `core.autocrlf` — but if you cloned before that file existed, re-clone.
- Clone somewhere short and **outside OneDrive** (e.g. `%USERPROFILE%\code\`). Desktop and Documents are usually redirected into OneDrive, which will sync all of `node_modules` to the cloud.

## 1. Fork/clone and install

```bash
git clone https://github.com/<you>/my-money.git
cd my-money
npm install
npm test          # node --test over test/ — should pass green
```

If `npm test` reports failures like `Cannot find package '@anthropic-ai/sdk'`, the install didn't complete — the api-loads tests import the real runtime dependencies. Re-run `npm install` before suspecting the app.

## 2. Create the Supabase project and database

> **NEVER point `supabase link` / `supabase db push` at a database that already has data.** The migration set includes `20260805000001_user_owned_categories.sql`, which **wipes every category, budget and learned rule**. On an empty database that is a no-op; replayed against a live one it destroys your categorization. The CLI path below is for **fresh installs only**. Existing databases keep the SQL Editor paste workflow (section 9).

Steps 1–2 are shared by both paths. Then use **Path A** (Supabase CLI — the verified default) or **Path B** (SQL Editor paste — the fallback).

1. Create a new Supabase project (pick a strong database password; region near you — you'll need that password again for `supabase link`).

2. **Create the auth user FIRST.** Dashboard → Authentication → Users → Add user. One shared login for the household: an email + password, with **Auto Confirm ON**. There is no signup flow in the app — this manual step is the only way a user gets created, and the household-bootstrap step in both paths depends on it existing.

   While you're there, **disable public signups** (Authentication → Sign In/Up → Email → turn off signups). Nothing in the app uses them, the publishable key in the deployed bundle would otherwise let anyone mint auth users via the API, and the bootstrap binds the household to the *first* auth user by creation time — a stray signup could claim that slot on a re-run.

### Path A — Supabase CLI (verified end-to-end 2026-08-13 — the default)

> **Rehearsed end-to-end (2026-08-13).** On a fresh-provisioned HOSTED project (Postgres 17, real auth/storage schemas), CLI v2.114.0 via `npx`: `login` → `link` (no version-mismatch warning) → `db push` applied all 18 migrations cleanly (18 was the count THAT DAY — a fresh install replays whatever `supabase/migrations/` holds now, so count the directory rather than this sentence), `bootstrap_household.sql`'s verification booleans all read true, and the receipts storage policy was created by the migration itself (the hand-creation fallback below wasn't needed on that run — still check it; grants can differ between projects). An earlier local rehearsal (2026-08-12, `db push --db-url`, v2.113.0) proved the same replay on a local PG16 cluster. Fall back to Path B if anything here errors.

This is the default because `supabase/migrations/` is the source of truth — replaying it is the honest fresh install, and it needs no hand-pasted tail.

The CLI is **not** a project dependency: `npx supabase` fetches it on demand (or install it yourself per Supabase's docs). Nothing pins its version, so a future release may behave differently from these notes.

3. Log in and link the project (from the repo root, so the CLI finds `supabase/config.toml`):

   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>   # prompts for the DB password
   ```

   The project ref is the subdomain of your project URL (`https://<ref>.supabase.co`). Re-read the warning at the top of this section before running the next command.

   `supabase/config.toml` is checked in and deliberately tiny. If `link` complains that the Postgres major version doesn't match, edit `[db] major_version` to the number it reports — nothing in this flow depends on that value beyond silencing the warning. The CLI stores the linked ref under `supabase/.temp/` (gitignored), not in `config.toml`.

4. Push the schema:

   ```bash
   npx supabase db push
   ```

   This runs every file in `supabase/migrations/` in filename order. The "paste after deploy" ordering notes inside some migrations apply only to a **live** database with old code still deployed — irrelevant on a fresh install.

5. **Bootstrap the household.** Open the SQL Editor, paste the entire contents of `supabase/bootstrap_household.sql`, and run it. It links the first auth user (by `created_at`) to a new `households` row ("My Household") as owner, and is idempotent — a second run changes nothing.

   The script ends with a verification SELECT of booleans. **Read them.** They must all be `true`. The Supabase SQL Editor does **not** display `raise notice`, so a skipped bootstrap looks exactly like a successful one — the booleans are the only visible evidence. If they're false, create the auth user (step 2) and re-run the script.

6. **Verify the receipts storage policy** — see "Storage policy check" below. Required on this path too.

### Path B — SQL Editor paste (fallback)

3. **Run the fresh-install script.** Open the SQL Editor, paste the entire contents of `supabase/setup_all.sql`, and run it.

   > **WARNING — destructive.** `setup_all.sql` DROPS and recreates every my-money table. It is for **fresh installs only**. Once you have real data, never run it again — apply individual files from `supabase/migrations/` instead. `migrations/` is the source of truth; `setup_all.sql` is a convenience snapshot. (It does not delete auth users, but it does drop `simplefin_access`, so on a re-run you would have to re-claim a SimpleFIN setup token.)

   The script auto-creates your household: a DO block picks the **first** auth user (by `created_at`), inserts a `households` row ("My Household") and a `household_members` row linking the user as owner. If no auth user exists it only raises a NOTICE — which the Supabase SQL Editor **does not display** — and skips silently. That's why the user comes first. The script's final statement is the visible check:

   ```sql
   select (select count(*) > 0 from household_members) as household_linked;
   ```

   It must return `true`. If it doesn't, create the auth user and re-run the script — and then **re-apply all the migrations from the next step**, because re-running `setup_all.sql` drops the tables and columns those migrations create.

4. **Apply the newer migrations.** `setup_all.sql` is currently stale: it replays migrations only through `20260731000001_receipts.sql`, and its end-of-script self-check also stops there — so it passes green while missing every later migration. Paste and run these files from `supabase/migrations/`, **in filename order**, after `setup_all.sql`:

   1. `20260801000001_debt_tracker.sql`
   2. `20260804000001_budget_month_target_override.sql`
   3. `20260804000002_expected_transactions.sql`
   4. `20260805000001_user_owned_categories.sql`
   5. `20260805000002_category_rule_amounts.sql`
   6. `20260815000001_transaction_user_type.sql`

   All of them run clean on the fresh baseline. Two are **not safe to re-run**, so paste each exactly once:

   - `20260804000002_expected_transactions.sql` uses bare `create table` / `create policy` / `create index` — a second run errors with "already exists". If you hit that, the statement already applied; move on to the next file rather than starting over.
   - `20260805000001_user_owned_categories.sql` copies rows into its `legacy_*` archive tables with no conflict target, so a second run **silently duplicates** those archive rows instead of erroring. Harmless on an empty fresh install (it copies nothing), but don't make a habit of it.

   The others (`20260801000001`, `20260804000001`, `20260805000002`, `20260815000001`) are fully guarded with `if not exists` / `drop … if exists` and are safe to re-run. (The "paste after deploy" ordering notes inside some of them apply only to migrations run against a **live** database with the old code still deployed — irrelevant on a fresh install.)

5. **Verify the install.** Paste `supabase/bootstrap_household.sql` into the SQL Editor and run it. `setup_all.sql` already linked the household, so its bootstrap block correctly does nothing — you're running it for the verification SELECT at the bottom, which is the only check that covers the migrations you just pasted by hand. **Every boolean must read `true`.** (`setup_all.sql`'s own self-check stops at the receipts migration, so it passes green whether or not you completed step 4.) The file is idempotent and non-destructive.

6. **Verify the receipts storage policy** — see "Storage policy check" below.

### Storage policy check (both paths)

The receipts migration creates the private `receipts` bucket and attempts to create the `receipts_objects_all` policy on `storage.objects`. On hosted Supabase that table is owned by `supabase_storage_admin`, so the `create policy` can fail with a permissions error that the script downgrades to an invisible NOTICE. Never trust "Success. No rows returned" — verify:

```sql
select * from pg_policies where policyname = 'receipts_objects_all';
```

If no row comes back, create the policy by hand in Dashboard → Storage → Policies, on the `receipts` bucket: policy **for ALL operations**, target role **`authenticated`**, and the same expression in **both** the USING and WITH CHECK boxes:

```sql
bucket_id = 'receipts' and (storage.foldername(name))[1] = current_household_id()::text
```

Then re-run the `pg_policies` check above. Note the expression depends on `current_household_id()` staying a public, executable function — the init migration (and `setup_all.sql`) sets that up; don't revoke it in a later tidy. Until the policy exists, receipt uploads fail with an RLS violation (an availability gap, not a data leak — the bucket is private either way). Once the app is running, round-trip one real receipt upload to confirm.

For a longer walkthrough of this section, see `supabase/README.md` — but where the two documents differ (it still lists the legacy Supabase key names), **this guide's tables are authoritative**; the code accepts both naming generations, as described next.

## 3. Environment variables

All variables are documented inline in `.env.example`. There are two groups:

**Client (baked into the JS bundle at build time — changing them requires a rebuild/redeploy):**

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL, e.g. `https://xyz.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The **Publishable** key (`sb_publishable_…`) from Supabase → Settings → API |

Legacy fallback: `VITE_SUPABASE_ANON_KEY` (the old anon key) is still read if the publishable var is unset. If both are missing the app renders a config-error screen, not a blank page.

**Server-only (used by the `api/` serverless functions — never exposed to the browser):**

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Same project URL as above |
| `SUPABASE_SECRET_KEY` | The **Secret** key (`sb_secret_…`). Legacy fallback: `SUPABASE_SERVICE_ROLE_KEY` |
| `ANTHROPIC_API_KEY` | Optional — Ask tab only; absent ⇒ graceful "not configured" |

> **Never put the secret key in any `VITE_*` variable.** Anything `VITE_*` is baked into the public bundle.

**Optional SimpleFIN tuning knobs** (all defaulted; non-numeric or ≤0 values fall back to the default):

| Variable | Default | Meaning |
|---|---|---|
| `SIMPLEFIN_MIN_PULL_MINUTES` | 60 | Server-side throttle between pulls (the Bridge refreshes ~daily) |
| `SIMPLEFIN_FIRST_PULL_DAYS` | 730 | How far back the first pull *asks* for (the shortfall vs. the served window is reported, not hidden) |
| `SIMPLEFIN_OVERLAP_DAYS` | 30 | Re-request overlap behind the incremental watermark |
| `SIMPLEFIN_MAX_LOOKBACK_DAYS` | 88 | Request clamp; must stay ≤ 90 (SimpleFIN's serving cap) |
| `SIMPLEFIN_INCLUDE_PENDING` | off | Set `1` to fetch pending transactions (off by default — a pending id that changes on posting would strand a permanent duplicate) |

## 4. Local development

```bash
cp .env.example .env.local     # fill in your values; dev-server.js loads this via dotenv
npm run dev
```

On **Windows `cmd.exe`** use `copy .env.example .env.local` (PowerShell aliases `cp`, so it works there as-is). Either way the copy must happen in a shell — File Explorer refuses to create a name that is all extension. Then edit it; in Notepad's Save As, quote the name as `".env.local"` or it becomes `.env.local.txt`.

`npm run dev` runs two processes concurrently:

- `vite` — the SPA dev server; it proxies `/api` to port 3001
- `node dev-server.js` — a small Express app that emulates Vercel serverless functions locally: it scans `api/*.js`, imports each default-export handler, and mounts it at `/api/<filename>` on port 3001 (`npm run dev:api` runs just this half)

Local dev talks to the **same Supabase project** as production — there is no separate local database. That also means a SimpleFIN setup token claimed while developing locally lands in the shared `simplefin_access` table; you do **not** need to claim another one after deploying.

Other scripts: `npm run build` (Vite build to `dist/`), `npm run preview`, `npm test`. A useful config-independent build check (used by the project's own workflow):

```bash
VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build
```

That inline `VAR=value` prefix is POSIX-only and is a syntax error in **both** Windows shells. Equivalents:

```bat
:: cmd.exe — quote the whole assignment so no trailing space enters the value
set "VITE_SUPABASE_URL=https://placeholder.supabase.co"
set "VITE_SUPABASE_ANON_KEY=placeholder"
npm run build
```

```powershell
# PowerShell — semicolons, not && (5.1 has no && operator)
$env:VITE_SUPABASE_URL='https://placeholder.supabase.co'; $env:VITE_SUPABASE_ANON_KEY='placeholder'; npm run build
```

(Never `setx` — it writes the registry and doesn't affect the window you typed it in.) If you already have a `.env.local`, plain `npm run build` works too: Vite reads it during production builds. The prefix exists only to make the check independent of local config.

## 5. Deploy to Vercel

1. Import your fork as a new Vercel project. `vercel.json` already sets the build command (`npm run build`), output directory (`dist`), the SPA rewrite (everything except `/api/*` → `index.html`), and the security headers (CSP, HSTS, frame denial, etc. — rationale in `docs/csp-derivation.md`; note these headers are served only by Vercel, so nothing local exercises them, and `test/securityHeaders.test.js` is the guard against breaking them).
   - Leave the project's **Node.js version at 20.x or newer** (Project Settings → General) — the `api/` functions use ESM and global `fetch`.
   - **If your Supabase URL is not `*.supabase.co`** (custom domain or self-hosted Supabase): the CSP in `vercel.json` pins `connect-src`/`img-src` to `https://*.supabase.co` and `wss://*.supabase.co`, so every API call would be silently blocked **in production only**. Add your host to those directives (and update the pins in `test/securityHeaders.test.js`) before deploying. Read `docs/csp-derivation.md` first.
2. Set **every** env var from section 3 in Project Settings → Environment Variables — for **Production AND Preview**. Remember `VITE_*` vars are baked at build time: changing one requires a redeploy.
3. Push to `main` (Vercel's production branch) or click Deploy.
4. Sanity-check the API actually loaded: an unauthenticated `POST` to `https://<your-app>/api/sync` should return **401** (proves the function module loaded and rejected you). A 500 means a module-load failure; a 404 on a route proves nothing.

   ```bash
   curl -i -X POST https://<your-app>/api/sync
   ```

   On Windows write `curl.exe`, not `curl` — in PowerShell 5.1 `curl` is an alias for `Invoke-WebRequest`, which rejects `-X` and then *throws* on the 401 you're trying to confirm, so success looks like failure. `curl.exe` ships with Windows 10 1803+.
5. Sign in with the household email/password you created in step 2.

Note if you use Preview deploys: they share your **production** Supabase database — preview edits are real data.

## 6. Connect your banks (SimpleFIN)

There is no SDK popup. The flow, from the app's Accounts tab via the "Add Account" pill at the bottom of the page (or the empty-state CTA's "+ Add bank"):

1. Sign up at https://bridge.simplefin.org/ (~$15/yr) and link your banks there.
2. Bridge prints a **setup token** — copy it, paste it into the app's connect modal. Tokens are single-use; a spent one needs a fresh token from Bridge.
3. The server (`api/simplefin-claim.js`) decodes the token, claims it, and stores the durable access URL server-side in the `simplefin_access` table (the browser never sees it — it embeds your bank credentials). The modal then triggers a first sync.
4. **New accounts arrive hidden.** Their type (checking/credit/loan) is *guessed* from the account name — eyeball and correct each one's type on the Accounts tab before unhiding it. A card mistyped as checking corrupts refund handling, spending totals, and net worth.

Sync is throttled to one pull per hour server-side; SimpleFIN itself refreshes roughly daily. The same modal offers status, disconnect, and Restore for removed banks.

## 7. Fallback: CSV / PDF statement import

For any account SimpleFIN can't reach (or to backfill history older than its ~88-day first-pull window), use the import modal on the Accounts tab. It accepts bank CSVs and PDF statements (a visual "teach it once" template editor handles any statement layout), deduplicates on re-import, and automatically refuses to insert rows that overlap the live feed's coverage. Stick to **one format per account** (CSV or PDF — a bank words the same transaction differently in each, defeating dedup).

## 8. Install as an iPhone PWA

Open your deployed URL in Safari → Share → **Add to Home Screen**. The app ships a service worker and manifest, works installed, and follows the system light/dark theme (with an in-app Auto/Light/Dark toggle).

## 9. Ongoing maintenance

- **Schema changes**: on an **existing database with real data, keep pasting** new files from `supabase/migrations/` into the SQL Editor, in filename order — do **not** `supabase link` / `db push` at it, which would replay the whole history including the category-wipe migration. The CLI is the fresh-install path only. Additive migrations go in before deploying code that uses them; migrations that DROP go in *after* the new code is live. Verify each with a SELECT you can read — never trust "Success. No rows returned".
- **Tests**: run `npm test` before pushing; `main` auto-deploys.
- Everything starts **Uncategorized** by design — you create every category and teach merchant rules from the Categories tab's teach queue; nothing is guessed.
