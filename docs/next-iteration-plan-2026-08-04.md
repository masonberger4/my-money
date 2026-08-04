# Next-iteration plan — 2026-08-04 (findings + feedback guide)

Written the day the 2026-08-02 session plan spent itself (saved chats + search
refinement shipped; `docs/session-plan-2026-08-02.md` deleted per its own rule)
and the 2026-08-01 backlog closed except the one deliberate deferral. This doc
is the holding pen for what comes next. CLAUDE.md wins on any conflict; nothing
below relitigates a decided item.

## Low-hanging fruit

1. **The Pending data/ops tasks FIRST** — they're worth more than features
   right now, because every model above them (income, Trends, RTA) reads the
   same rows. All five live in CLAUDE.md's Pending section with full detail;
   in priority order:
   - **Rotate the Supabase service_role key** (pasted into a chat 2026-08-03).
     Dashboard → Settings → API Keys → rotate Secret key; update Vercel
     Production AND Preview; redeploy. Pure ops, five minutes, do it first.
   - **$2,200 payroll duplicate** — two distinct `sfin:` ids for the same
     2026-07-24 deposit on Cashback Debit (3481), so the
     `(account_id, plaid_tx_id)` upsert can't dedup. Verify against the
     Discover statement; `excluded=true` on one copy. July income reads
     ~$2,200 high until then (+ ~$34 of Venture X same-day dupes Jun+Jul).
   - **Discover it (7933) twins** — one mistyped `depository/checking` under
     the Capital One org, sibling `credit` under Discover. Both hidden ($0
     impact today); keep the credit one, and eyeball type on EVERY unhide
     (the mistype→household-spending failure the hidden-by-default rule
     exists for).
   - **NEWREZ recategorization** (~$3.8k/mo in "Utilities") — learned rule or
     `user_category`; counted once, just the wrong bucket.
   - **Pre-May statement backfill** — BECU savings, Cashback Debit, the cards,
     via CSV/PDF import; the Data coverage panel (Accounts tab) shows each
     gap. First confirm the Checking 2644→5481 re-key theory (rows abut at
     2026-04-03 with no overlap) before treating 2644 as separate.

2. **Receipt OCR v1** — the upgrade path CLAUDE.md already reserved: a new
   `api/receipt-ocr` route on the existing `ANTHROPIC_API_KEY`, reading the
   stored image (signed URL server-side or Storage download under
   service_role), returning merchant/date/amount/category suggestions,
   **confirm-before-write** in the detail sheet (the confidently-wrong
   refusal applied to OCR). Plumbing exists end to end: `receipts` table,
   `ReceiptSection.jsx`, `getReceiptUrl`, `requireUser()`. No migration.

3. **Cash-flow forecast lite** — previously "later (discussed, not
   committed)", but Session 6 built the hard part: `expected_transactions`
   carries cadence + due dates, `projectFutureCycles`/`rollForwardDate`
   (`src/expectedTx.js`) already project forward. Projected end-of-month
   balance = current depository balances − remaining expected outflows
   (+ expected income if typed). Keep it a pure core + one Overview/Trends
   card; it inherits the DISPLAY-ONLY contract — never touches Available,
   the walk, or any total.

4. **Bundle trimming** — main chunk ~584 kB (pdf.js's ~1.8 MB is already
   lazy via `pdfExtract.js`, as are the modals). Next lever is tab-level
   `React.lazy` inside Dashboard.jsx (Tax/Debt/Trends render heavy pure
   cores). **Harness caveat:** the mock harness aliases
   dataAdapter/sync/db/apiClient by full-match regex — any split-out module
   must keep importing through `dataAdapter.js` or it escapes the mocks
   (same rule recorded for the decomposition, backlog Section 3).

5. **Retire the Data coverage panel** once backfill (item 1) settles — it was
   shipped as TEMPORARY (CLAUDE.md Merged features). Delete the card, keep
   `src/coverage.js` + `getDataCoverage()` only if something else has started
   reading them; otherwise remove all three plus `test/coverage.test.js`.

6. **SQL/RLS tests** — ~18 `create policy` statements across
   `supabase/migrations/`, zero tests; the testing-suite entry records this
   as the worthwhile follow-up. Use the Local-checks recipe in CLAUDE.md
   (local Postgres 16 stub: `auth` schema + `auth.uid()` reading
   `request.jwt.claims.sub`, three roles, run migrations in order), then
   assert: cross-household SELECT/INSERT denial per table,
   `simplefin_access` invisible to `authenticated`, `household_id` default
   filling on client insert, the receipts storage policy. Keep it a
   gitignored local check or a separate opt-in script — `npm test` must stay
   zero-dep and Postgres-free.

## Harder, high value

1. **Dashboard.jsx decomposition** — deferred by Mason 2026-08-01 and STILL
   deferred; the file is now **4,983 lines** (`wc -l`, 2026-08-04). The
   staged plan is recorded in `docs/improvement-backlog-2026-08-01.md`
   Section 3: sheets/formatters first → shared TxRow → read-only tabs, every
   new module importing through dataAdapter.js (the harness-alias rule).
   First big investment when feature pace slows; not before Mason says so.

2. **Deriving RTA income (the income wall)** — CLAUDE.md's envelope section
   says exactly what unlocks it: every income account reliably fed. That's a
   data-quality gate, i.e. it sits BEHIND low-hanging items 1 (payroll dupe,
   backfill) — and it's **Mason's call, not an automatic upgrade**. Deriving
   income (via `cashIncome`, already pure) then unlocks honest RTA and Age
   of Money (Roadmap: "wants real *measured* income").

3. **Reconciliation** — spec open (Roadmap). Half the build exists:
   `reconcileCsv` (`src/csvImport.js`) already max-matches statement rows
   against the ledger and CsvImport.jsx renders the comparison. The open
   half is what to DO with a mismatch: a missing-row insert path (dangerous —
   the overlap/double-count rules), an excluded-flag suggestion, or
   report-only. Needs a Mason spec before code.

4. **Real per-person Auth accounts** — ends the shared-login gotcha class
   (`scope:'local'` sign-out, localStorage-vs-settings prefs, "the other
   phone"). Invasive: `household_members` already maps user→household, so
   the RLS shape survives, but it means a second Auth user, invite flow,
   per-user prefs, and re-verifying every `current_household_id()` path +
   the receipts storage policy. Only worth it if Mason wants per-person
   attribution or separate prefs; otherwise the shared login keeps winning
   on pragmatism.

5. **Email-alert cron for freshness** — previously OUT (Roadmap: Vercel Cron
   → api/ route polling Gmail, service-role inserts, reconciled against the
   ledger). Revisit ONLY if SimpleFIN's ~daily refresh demonstrably hurts —
   i.e. if the feedback below keeps reporting >1-day staleness that matters.

## How Mason reports back (the feedback guide)

What field reports are actually useful, now that both phones run everything:

- **Two-phone behaviors**: sign-out on one device affecting the other (it
  must NOT — `scope:'local'`); saved chats, the recurring ignore list, and
  expected bills appearing/updating on the second phone (all
  settings-table-backed, read-merge-write serialized); any edit that shows
  on one device and not the other.
- **Touch feel**: the Overview card-tile swipe (horizontal-intent
  threshold), the month jump picker, sheet scrolling — anything that feels
  wrong at 390px is a bug report.
- **Classifier misses**: the VERBATIM descriptor string (from the detail
  sheet), what it was categorized as, what it should be. Verbatim matters —
  `merchantKey` and the keyword table both work off exact tokens.
- **Recurring tab under the 40-month window**: false positives (one-offs
  listed), false negatives (a real weekly/annual sub missing), wrong
  cadence suffixes, price-creep flags on long-settled changes.
- **Any two on-screen numbers disagreeing** — the ONE-model unification's
  whole point is that Categories/Overview/Budget/Trends agree by
  construction, so a disagreement is always a real bug, never rounding.
- **Feed health**: the amber banner appearing, or any account >1 day stale —
  with the bank name (per-bank failures arrive inside an HTTP 200).

## Next backlog

This doc is an interim holding pen, not a verified backlog. The mechanism
that supersedes it: a fresh **six-dimension audit** (UX, code health,
performance, security, testing/reliability, data insights — the
2026-08-01 shape), fed by this list plus Mason's field reports above, each
finding re-verified against the code before it becomes a work item. When
that audit lands, this file collapses to a one-line pointer or is deleted,
per the improvement-backlog precedent.
