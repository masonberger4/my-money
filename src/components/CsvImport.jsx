import { Component, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { analyzeCsv, toInsertRow, parseCsv, reconcileCsv, csvDateRange, buildRows, importPlan } from "../csvImport.js";
import { applyTemplate, autoDetectTemplate, defaultTemplate, rowTotals, TEMPLATE_VERSION } from "../pdfImport.js";
import { createManualAccount, importCsvTransactions, getExistingTxIds, getAccountTransactionsInRange, isManualAccount, isSimpleFinAccount, getCategoryRules, getFeedCoverageStart } from "../dataAdapter.js";
import { getSetting, setSetting } from "../db.js";
import { runSync } from "../sync.js";
import { chipStyle, markColor, readableInk } from "../paletteContrast.js";
import { readToken, subscribeTheme } from "../theme.js";
import PdfTemplateEditor from "./PdfTemplateEditor.jsx";

// Statement import — a file-picker action on the Accounts tab, accepting a bank
// CSV or a PDF statement. A PDF is turned into the same cell grid a CSV
// produces (see pdfImport.js) by a per-account TEMPLATE the user confirms once
// in the visual editor, so everything below this point is shared by both.
//
// TWO SECTIONS, chosen by WHERE THE FILE'S ROWS FALL — not by the target.
//
// Until Plaid was removed the target answered the question: manual accounts got
// an insert, Plaid accounts got a read-only audit. Every account is now either
// manual or SimpleFIN-fed, and a fed account is a legitimate target for both
// "fill in history the feed never had" and "check this statement against the
// feed". So the file decides (see importPlan in csvImport.js):
//
//  • rows BEFORE the feed's coverage  -> imported (a backfill)
//  • rows ON OR AFTER it              -> compared, never inserted
//  • a file that straddles            -> both, on their respective slices
//
// The one control is a "Compare only" override, which can only ever move
// TOWARDS not-inserting. A manual account has no feed, so it has no boundary and
// always imports; an account we can't classify can only be compared.
//
// WHY THE BOUNDARY IS ABSOLUTE: `csv:`/`pdf:` and `sfin:` dedup ids are separate
// namespaces that cannot see each other. A row imported over a date the feed
// already covers is a duplicate nothing downstream can detect — it just silently
// doubles that transaction in every total, forever.

// Pad an ISO date by ±days so the feed fetch covers the statement's period plus
// the date-drift window on both ends. Explicit UTC math — never new Date(string).
function padIso(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Today as an ISO date, in UTC — matching how transactions.date is stored and
// how padIso arithmetic works. Deliberately not toLocaleDateString: a phone in
// UTC−7 would otherwise call it "yesterday" all evening and shift the derived
// feed boundary by a day.
function todayIso() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function money(n) {
  const v = Number(n);
  const s = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? "−" + s : s; // negative = money in
}

const ROLE_LABELS = { date: "Date", description: "Description", debit: "Debit", credit: "Credit", amount: "Amount (signed)" };

// Read a theme surface at RUNTIME from src/ui.css — never hardcode a token
// value here — and re-read it whenever the theme is applied, so these colours
// follow a FORCED theme (the header toggle) exactly as they follow the OS one.
// "" is the deliberate fallback: paletteContrast reads an unparseable surface as
// "no surface to reason about" and hands the colour back untouched, i.e. exactly
// today's rendering, rather than throwing during render.
function useSurface(token) {
  const [value, setValue] = useState(() => readToken(token, ""));
  useEffect(() => {
    const read = () => setValue(readToken(token, ""));
    read();
    return subscribeTheme(read);
  }, [token]);
  return value;
}

// The good/money-in green and the comparison-bucket hues are DATA — a status
// palette, not theme tokens: the four buckets have to stay tellable apart from
// each other, and #1D9E75/#D85A30 are the app-wide good/bad pair whose STORED
// values must not change. What changed is how they are RENDERED — every one is
// now contrast-corrected at render against the surface it actually sits on, so
// the same hex stays legible on the near-white card and the near-black one.
// Measured: this fixes LIGHT mode too, not just dark — the audit chips drew the
// raw hue as text on its own 13% tint and came in at 2.92–3.29:1 on the white
// card (all four buckets), and the money-in amount was 3.39:1. Now >= 4.5:1 in
// both themes, with the light-mode tint itself unchanged to the byte.
const MONEY_IN = "#1D9E75";     // also the "matched" bucket
const SYNC_GAP = "#D85A30";
const AMOUNT_DIFF = "#B7791F";
const MATCH_DIFF = "#378ADD";

// Backstop for anything unguarded that throws during render inside the modal —
// the app has no global error boundary, so without this a render throw blanks
// the whole PWA. Scoped to the modal body only, so it can't swallow errors
// elsewhere in the app.
class ModalErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err, info) { console.error("import modal render failed", err, info); }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: 8, padding: "10px 12px" }}>
          Something went wrong rendering this step — close and retry.
        </div>
      );
    }
    return this.props.children;
  }
}

// Rendered through a PORTAL to document.body, and that is load-bearing rather
// than tidy. `position: fixed` is resolved against the nearest ancestor with a
// transform/filter/perspective — not the viewport — and `.card` carries
// `animation: fadeIn … both`, whose final keyframe Chromium computes as the
// IDENTITY MATRIX, not `none`. So any modal rendered from inside a card gets
// its "full-screen" overlay clipped to that card: measured at 340px wide inside
// EmptyState, with the backdrop and the outside-tap-to-close going with it.
// Portalling makes the overlay immune to wherever the caller happens to sit.
export default function CsvImport({ accounts = [], onClose, onImported }) {
  const [fileName, setFileName] = useState(null);
  const [fileText, setFileText] = useState(null);
  const [manualCols, setManualCols] = useState(null); // {headerIndex,date,description,debit,credit,amount}
  const [amountSign, setAmountSign] = useState("in_positive");
  const [target, setTarget] = useState("new"); // "new" | accountId
  const [newName, setNewName] = useState("");
  const [newSubtype, setNewSubtype] = useState("checking");
  const [existingIds, setExistingIds] = useState(new Set());
  const [existingSources, setExistingSources] = useState(new Set());
  // Learned merchant rules, so an import agrees with what the household has
  // already taught the classifier instead of re-deriving from keywords alone.
  const [rules, setRules] = useState(null);
  // Where the SimpleFIN feed's own coverage starts for the target account.
  // Rows on/after it must not be imported — see getFeedCoverageStart.
  const [coverageStart, setCoverageStart] = useState(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  // A lookup that FAILED, as distinct from a feed that has delivered nothing.
  const [coverageError, setCoverageError] = useState(false);
  // Bumped to re-run the coverage lookup after a sync from inside this modal.
  const [coverageNonce, setCoverageNonce] = useState(0);
  // The user's explicit "don't import, just compare" override.
  const [compareOnly, setCompareOnly] = useState(false);
  const [syncState, setSyncState] = useState("idle"); // idle | running | done | failed
  const [loadingIds, setLoadingIds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pdfAdvisory, setPdfAdvisory] = useState(null); // non-fatal guidance, not the terminal error slot
  const [result, setResult] = useState(null);
  const [recon, setRecon] = useState(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [fileKind, setFileKind] = useState("csv"); // "csv" | "pdf"
  const [pdfPages, setPdfPages] = useState(null);
  const [pdfTemplate, setPdfTemplate] = useState(null);
  const [pdfAutoTemplate, setPdfAutoTemplate] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [templateSource, setTemplateSource] = useState(null); // 'saved' | 'auto'
  const [showEditor, setShowEditor] = useState(false);
  const fileRef = useRef(null);
  // The modal panel is --card, so that is the surface the preview amounts and
  // the audit chips are actually read against.
  const cardSurface = useSurface("--card");

  const manual = accounts.filter(isManualAccount);
  const simplefin = accounts.filter(isSimpleFinAccount);
  // Neither manual nor SimpleFIN. Normally empty now that Plaid is gone, but
  // reachable from a hand-edited row or a half-applied migration. Its dedup
  // namespace is unknown, so it can only ever be COMPARED against, never
  // imported into.
  const other = accounts.filter(a => !isManualAccount(a) && !isSimpleFinAccount(a));
  // Every account fed by something other than this importer — i.e. anything a
  // statement could ALREADY be covered by. Deliberately "not manual" rather
  // than "is SimpleFIN", so a feed we don't recognise still triggers the
  // duplicate-account warning below; erring toward warning is the safe side.
  const fedAccounts = accounts.filter(a => !isManualAccount(a));

  // Target classification, stated POSITIVELY. The old code derived
  // `targetIsManual = !targetIsPlaid`, which quietly became true for every
  // SimpleFIN account the moment the last Plaid item was unlinked — a
  // derivation that survives only as long as the thing it negates exists.
  // `targetIsUnknown` is the fail-closed branch that used to be provided
  // accidentally by `plaid` catching everything unrecognised.
  const targetAcct = target !== "new" ? accounts.find(a => a.id === target) : null;
  const targetIsExisting = !!targetAcct;
  const targetIsSimpleFin = !!targetAcct && isSimpleFinAccount(targetAcct);
  const targetIsManual = !!targetAcct && isManualAccount(targetAcct);
  const targetIsUnknown = targetIsExisting && !targetIsManual && !targetIsSimpleFin;

  // Switching target resets the override. Carrying an INSERTING state across
  // accounts is the mis-tap that permanently doubles money; carrying a
  // non-inserting one is harmless, but one rule is easier to reason about than
  // two. Deliberately NOT reset on file change — auditing several statements in
  // a row against the same account is a real flow.
  useEffect(() => {
    setCompareOnly(false);
    setSyncState("idle");
  }, [target]);

  // Mirrors OVERLAP_DAYS in api/_lib/simplefin.js: every pull after the first
  // starts at last_pulled_at minus this, so that tail can still arrive.
  const FEED_LOOKBACK_DAYS = 30;

  // Which of the five states the feed boundary is in. Only 'ok' permits an
  // import into a fed account.
  const boundaryState =
    !targetIsSimpleFin ? "n/a"
    : coverageLoading ? "loading"
    : coverageError ? "error"
    : coverageStart ? "ok"
    : syncState === "running" ? "loading"
    : syncState === "done" ? "ok"      // pulled just now and the feed really is empty here
    : "unsynced";

  // The date on/after which rows belong to the feed.
  //
  // The `today − 30` case is the one that needed the most care. When a fresh
  // pull returns nothing for an account, it is tempting to conclude the feed has
  // no claim on any date and unlock the whole file. That is wrong in a way that
  // costs money: FIRST_PULL_DAYS defaults to 730, so a not-yet-synced account is
  // about to receive up to two years of history, and even a synced-but-empty one
  // keeps a live 30-day tail because subsequent pulls re-read that window. So an
  // empty feed yields a boundary of today − 30 rather than no boundary at all,
  // and a never-synced account gets no boundary and no import until it is
  // synced — the button says so.
  const overlapFrom =
    !targetIsSimpleFin ? null
    : coverageStart ? coverageStart
    : boundaryState === "ok" ? padIso(todayIso(), -FEED_LOOKBACK_DAYS)
    : null;

  // Apply the PDF template → the same cell grid a CSV yields. Guarded like the
  // CSV parse below: this runs during render, and the app has no error
  // boundary, so an unexpected throw here would blank the whole PWA instead of
  // showing a message.
  // Derived, not stored: returning the error from the memo means it clears
  // itself as soon as the inputs change. Setting state from inside a memo would
  // leave a one-off failure stuck on screen for the rest of the session.
  const { applied: pdfApplied, error: pdfApplyError } = useMemo(() => {
    if (!(fileKind === "pdf" && pdfPages && pdfTemplate)) return { applied: null, error: null };
    try {
      return { applied: applyTemplate(pdfPages, pdfTemplate), error: null };
    } catch (e) {
      console.error("applyTemplate failed", e);
      return { applied: null, error: `Couldn't read this statement with these columns: ${e.message || e}` };
    }
  }, [fileKind, pdfPages, pdfTemplate]);

  // The auto-detect advisory has done its job once the hand-set columns parse
  // rows — leaving it up next to a working preview reads as a problem.
  useEffect(() => {
    if (pdfAdvisory && pdfApplied?.grid?.length) setPdfAdvisory(null);
  }, [pdfAdvisory, pdfApplied]);

  // Parse + build rows. Small files → cheap to recompute on every change.
  // Both sources converge on buildRows, so the preview, dedup, categories,
  // insert and comparison audit are identical for CSV and PDF.
  const analysis = useMemo(() => {
    try {
      if (fileKind === "pdf") {
        if (!pdfApplied) return null;
        const { rows, skipped } = buildRows(pdfApplied.grid, { ...pdfApplied.buildOpts, existingIds, rules, overlapFrom });
        return { rows, skipped, needsManualMapping: false, parsedRowCount: pdfApplied.grid.length };
      }
      if (!fileText) return null;
      return analyzeCsv(fileText, { existingIds, manualColumns: manualCols, amountSign, rules, overlapFrom });
    } catch (e) {
      return { error: e.message, rows: [], skipped: [], needsManualMapping: false };
    }
  }, [fileKind, pdfApplied, fileText, existingIds, manualCols, amountSign, rules, overlapFrom]);

  // These MUST stay above the reconciliation effect below.
  //
  // A useEffect's dependency array is evaluated during render, at the call site.
  // Referencing a `const` declared further down the component body throws a
  // ReferenceError from CsvImport's own body — and ModalErrorBoundary is
  // rendered BY that body, so it cannot catch it. The result is not a broken
  // modal, it is a blank PWA. These derivations used to live ~150 lines below
  // the effect, which was survivable only because nothing down there was in its
  // deps yet.
  const plan = useMemo(
    () => importPlan(
      analysis && !analysis.needsManualMapping && !analysis.error ? analysis.rows : [],
      { overlapFrom }
    ),
    [analysis, overlapFrom]
  );
  const { verdict, newRows, overlapRows, dupCount, overlapCount } = plan;
  const rows = analysis?.rows || [];
  const skipped = analysis?.skipped || [];
  const preview = rows.slice(0, 200);

  // An unknown target can only be compared. `compareOnly` is the user's
  // override. `verdict === 'audit'` is the file's own answer: every row is
  // already inside the feed's coverage, so there is nothing to insert.
  const auditOnly = targetIsUnknown || compareOnly || verdict === "audit";
  const previewShown = !auditOnly;
  const auditShown = targetIsExisting && (auditOnly || overlapCount > 0);
  // In the straddle case audit ONLY the in-coverage slice. Feeding the whole
  // file would dump every pre-coverage row into the "missing from the feed"
  // bucket, where the feed has nothing by definition — turning a clean backfill
  // into a screen full of false gaps.
  const auditRows = auditOnly ? rows : overlapRows;

  // Where the live feed's coverage begins, for the overlap guard.
  //
  // A FAILED lookup must not look like "the feed has nothing here". Both used to
  // set coverageStart to null, and null means no boundary — so a dropped
  // connection silently opened the guard on a fully-synced account and offered
  // to import the whole file over the top of it. coverageError keeps them apart.
  useEffect(() => {
    if (!targetIsSimpleFin) { setCoverageStart(null); setCoverageError(false); return; }
    let cancelled = false;
    setCoverageError(false);
    setCoverageLoading(true);
    getFeedCoverageStart(target)
      .then(d => { if (!cancelled) setCoverageStart(d); })
      .catch(err => {
        console.error("coverage lookup failed", err);
        if (!cancelled) { setCoverageStart(null); setCoverageError(true); }
      })
      .finally(() => { if (!cancelled) setCoverageLoading(false); });
    return () => { cancelled = true; };
  }, [target, targetIsSimpleFin, coverageNonce]);

  // Learned merchant rules, loaded once — the analysis re-runs when they land.
  useEffect(() => {
    let cancelled = false;
    getCategoryRules()
      .then(r => { if (!cancelled) setRules(r); })
      .catch(err => { console.error("category rules unavailable", err); if (!cancelled) setRules({}); });
    return () => { cancelled = true; };
  }, []);

  // Load the target account's existing ids so dupes grey out. Loaded for EVERY
  // existing target now: comparison mode used to skip this because it inserts
  // nothing, but the same account can now be a backfill target in the same
  // session, and `isDuplicate` is what makes re-importing a statement
  // idempotent. Only a brand-new account has nothing to fetch.
  useEffect(() => {
    if (target === "new") { setExistingIds(new Set()); setExistingSources(new Set()); return; }
    let cancelled = false;
    setLoadingIds(true);
    getExistingTxIds(target)
      .then(({ ids, sources }) => { if (!cancelled) { setExistingIds(ids); setExistingSources(sources); } })
      .catch(() => { if (!cancelled) { setExistingIds(new Set()); setExistingSources(new Set()); } })
      .finally(() => { if (!cancelled) setLoadingIds(false); });
    return () => { cancelled = true; };
  }, [target]);

  // A bank words the same transaction differently in its CSV and its PDF, so
  // the dedup hash differs and feeding one account both formats double-inserts.
  // Warn when the account already holds rows from the other format.
  const incomingSource = fileKind === "pdf" ? "pdf" : "csv";
  // Every row on a MANUAL account arrived through an import, so any source
  // that isn't the incoming format is a conflict — including the legacy 'plaid'
  // column default on rows predating the source column, because we cannot tell
  // which format those came from and guessing wrong double-counts permanently.
  //
  // A FED account legitimately holds its own feed rows next to imported
  // history, so those are not a format conflict; only csv-vs-pdf is.
  const IMPORT_FORMATS = new Set(["csv", "pdf"]);
  const importedSources = [...existingSources].filter(s => (targetIsManual ? true : IMPORT_FORMATS.has(s)));
  const mixedSource = targetIsExisting && importedSources.some(s => s !== incomingSource);
  const legacySource = targetIsManual && mixedSource && !importedSources.some(s => IMPORT_FORMATS.has(s));

  // The audit: reconcile the statement against what the account already holds
  // over the statement's date range (± the drift window). Inserts nothing.
  const csvRows = analysis && !analysis.needsManualMapping && !analysis.error ? analysis.rows : null;
  useEffect(() => {
    if (!targetIsExisting || !auditShown || !csvRows) { setRecon(null); return; }
    const { min, max } = csvDateRange(auditRows);
    if (!min || !max) { setRecon({ counts: { matched: 0, csvOnly: 0, plaidOnly: 0, amountMismatches: 0 }, matched: [], amountMismatches: [], csvOnly: [], plaidOnly: [] }); return; }
    let cancelled = false;
    setReconLoading(true);
    // Debounced. Dragging a column edge in the PDF template editor re-derives
    // the rows on every pointermove, and without this each one would fire
    // another query at the database.
    const handle = setTimeout(() => {
      getAccountTransactionsInRange(target, padIso(min, -7), padIso(max, 7))
        .then(existing => { if (!cancelled) setRecon(reconcileCsv(auditRows, existing)); })
        .catch(e => { if (!cancelled) { console.error("reconcile failed", e); setError(e.message || "Couldn't load this account's transactions to compare."); setRecon(null); } })
        .finally(() => { if (!cancelled) setReconLoading(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [target, targetIsExisting, auditShown, auditOnly, csvRows]);

  // A statement is well under a megabyte. Reading a huge file would be held
  // several times over in memory (the ArrayBuffer, pdf.js's copy, and its
  // internal transfer), and on a phone that kills the whole app rather than
  // surfacing an error — so refuse it up front with a clear message.
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      setFileName(f.name);
      setFileText(null);
      setPdfPages(null);
      setPdfAdvisory(null);
      setError(
        `That file is ${(f.size / 1024 / 1024).toFixed(0)}MB, which is too large to read safely on a phone. ` +
        `Bank statements are normally well under 5MB — check you picked the right file.`
      );
      return;
    }
    setError(null);
    setPdfAdvisory(null);
    setResult(null);
    setManualCols(null);
    setFileName(f.name);
    setPdfPages(null);
    setPdfTemplate(null);
    setPdfAutoTemplate(null);
    setTemplateSource(null);
    setShowEditor(false);

    const isPdf = /\.pdf$/i.test(f.name) || f.type === "application/pdf";
    if (!isPdf) {
      setFileKind("csv");
      try {
        setFileText(await f.text());
      } catch {
        setError("Couldn't read that file.");
      }
      return;
    }

    setFileKind("pdf");
    setFileText(null);
    setPdfBusy(true);
    // Named so a failure says WHICH step broke — the difference between
    // "your browser can't run the PDF reader" and "we couldn't read the
    // layout" matters, and a bare message from a phone is impossible to act on.
    let stage = "loading the PDF reader";
    try {
      // pdf.js is ~1MB and only loaded here, the first time a PDF is opened.
      const { extractPdfPages } = await import("../pdfExtract.js");
      stage = "reading the file";
      const buf = await f.arrayBuffer();
      stage = "extracting text from the PDF";
      const { pages, hasTextLayer, pageCount, truncated } = await extractPdfPages(buf);
      if (truncated) {
        // Never import part of a statement without saying so.
        setError(
          `This PDF has ${pageCount} pages and only the first ${pages.length} were read. ` +
          `Anything after that would be missing — split the file if you need the rest.`
        );
      }
      if (!hasTextLayer) {
        setError(
          "This PDF has no text layer — it looks like a scan or photo of a statement. " +
          "Reading it would need OCR, which isn't supported. Download the CSV export instead if your bank offers one."
        );
        return;
      }
      setPdfPages(pages);
      stage = "detecting the statement layout";
      const auto = autoDetectTemplate(pages);
      setPdfAutoTemplate(auto);
      if (!auto) {
        // Advisory, not the terminal error slot — the user can still fix the
        // columns by hand, and this must clear once they do.
        setPdfAdvisory("Couldn't find a transaction table in this PDF automatically — set the columns by hand below.");
        setPdfTemplate(defaultTemplate());
        setShowEditor(true);
      } else {
        setPdfTemplate(auto);
        setTemplateSource("auto");
      }
    } catch (err) {
      console.error(`pdf import failed while ${stage}`, err);
      const detail = [err?.name, err?.message || String(err)].filter(Boolean).join(": ");
      setError(`Couldn't read that PDF — it failed while ${stage}. ${detail}`);
    } finally {
      setPdfBusy(false);
    }
  }

  // A template the user already taught for THIS account wins over auto-detect.
  // Switching to an account without one must fall back to auto-detect rather
  // than silently keeping the previous account's layout.
  useEffect(() => {
    if (fileKind !== "pdf" || !pdfPages) return;
    let cancelled = false;
    const useAuto = () => {
      if (cancelled || !pdfAutoTemplate) return;
      setPdfTemplate(pdfAutoTemplate);
      setTemplateSource("auto");
    };
    if (target === "new") { useAuto(); return; }
    getSetting(`pdftpl:${target}`)
      .then(raw => {
        if (cancelled) return;
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && saved.version === TEMPLATE_VERSION) {
          setPdfTemplate(saved);
          setTemplateSource("saved");
        } else {
          useAuto();
        }
      })
      .catch(() => useAuto());
    return () => { cancelled = true; };
  }, [fileKind, pdfPages, target, pdfAutoTemplate]);

  // rows / newRows / overlapCount / dupCount / skipped / preview are derived
  // near the top of the component, above the effects whose dependency arrays
  // reference them — see the TDZ note there.

  // A never-synced fed account has no boundary yet, so there is nothing to
  // import safely against. Rather than guess one, pull the feed and look again.
  async function syncNow() {
    setSyncState("running");
    setError(null);
    try {
      await runSync({ force: true });
      setSyncState("done");
      setCoverageNonce(n => n + 1);
      if (onImported) onImported();
    } catch (e) {
      console.error("sync before import failed", e);
      // Deliberately does NOT unlock the import. A failed pull tells us nothing
      // about what the feed holds, and the first pull can reach back two years.
      setSyncState("failed");
      setError("Couldn't sync this account, so there's no safe boundary to import against. Try again.");
    }
  }

  // mixedSource BLOCKS rather than warns: the app has no way to delete
  // transactions, so importing a second format into the same account would
  // permanently double-count it until someone runs SQL against the database.
  const canConfirm =
    !!analysis && !analysis.needsManualMapping && !analysis.error && !busy && !loadingIds &&
    !auditOnly && !mixedSource &&
    boundaryState !== "loading" && boundaryState !== "error" && boundaryState !== "unsynced" &&
    newRows.length > 0 &&
    (target !== "new" || newName.trim().length > 0);

  const needsSyncFirst = boundaryState === "unsynced";
  const primaryLabel =
    busy ? "Importing…"
    : syncState === "running" ? "Syncing…"
    : needsSyncFirst ? "Sync this account first"
    : `Import ${newRows.length || ""} transaction${newRows.length !== 1 ? "s" : ""}`;
  const primaryOn = needsSyncFirst ? syncState !== "running" : canConfirm;

  async function confirm() {
    if (!canConfirm) return;
    // Defence in depth. canConfirm already gates the button, but these are the
    // two invariants whose violation costs money rather than showing a wrong
    // screen, and they are cheap to restate right before the write. They throw
    // inside an async handler, so they land in the catch below as a visible
    // error — never as a render blank.
    if (auditOnly) return;
    if (targetIsSimpleFin && !overlapFrom) {
      throw new Error("internal: no feed boundary — refusing to import into a fed account");
    }
    setBusy(true);
    setError(null);
    try {
      let accountId = target;
      let accountName = targetAcct ? (targetAcct.nickname || targetAcct.name) : newName.trim();
      if (target === "new") {
        const acct = await createManualAccount({ name: newName.trim(), subtype: newSubtype });
        accountId = acct.id;
        accountName = acct.name;
      }
      const payload = newRows.map(toInsertRow);
      if (overlapFrom && payload.some(r => r.date >= overlapFrom)) {
        throw new Error("internal: a row on/after the feed boundary reached the insert payload");
      }
      const written = await importCsvTransactions(accountId, payload, incomingSource);
      // Remember the PDF layout for this account so the next statement from the
      // same bank is read without teaching it again.
      if (fileKind === "pdf" && pdfTemplate) {
        try {
          await setSetting(`pdftpl:${accountId}`, JSON.stringify({ ...pdfTemplate, version: TEMPLATE_VERSION }));
        } catch (e) {
          console.warn("could not save the PDF layout template", e);
        }
      }
      setResult({ written, dupCount, skipped: skipped.length, accountName, savedTemplate: fileKind === "pdf" });
      if (onImported) onImported();
    } catch (e) {
      console.error("csv import failed", e);
      setError(e.message || "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const panelStyle = {
    background: "var(--card)", borderRadius: 16, border: "1px solid var(--border)",
    width: "92vw", maxWidth: 540, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden",
  };
  const sectionLabel = { fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 };
  const selStyle = { fontSize: 13, fontFamily: "inherit", color: "var(--text)", background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", outline: "none", width: "100%" };

  return createPortal(
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div onClick={e => e.stopPropagation()} style={panelStyle}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Import transactions</div>
          <button onClick={onClose} disabled={busy} className="nbtn" title="Close" style={{ opacity: busy ? .4 : 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 20px", overflowY: "auto" }}>
          <ModalErrorBoundary>
          {result ? (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 34, marginBottom: 8 }}>✓</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                Imported {result.written} transaction{result.written !== 1 ? "s" : ""}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                into <strong style={{ color: "var(--text)" }}>{result.accountName}</strong>.<br />
                {result.dupCount > 0 && <>Skipped {result.dupCount} already-imported row{result.dupCount !== 1 ? "s" : ""}. </>}
                {result.skipped > 0 && <>Ignored {result.skipped} unreadable/zero row{result.skipped !== 1 ? "s" : ""}. </>}
                {result.savedTemplate && <><br />The statement layout was saved — next month's PDF reads automatically.</>}
              </div>
            </div>
          ) : (
            <>
              {/* 1 — File */}
              <div style={{ marginBottom: 18 }}>
                <div style={sectionLabel}>1 · Choose a statement file</div>
                <input ref={fileRef} type="file" accept=".csv,.pdf,text/csv,text/plain,application/pdf" onChange={onFile}
                  style={{ display: "none" }} />
                <button className="ibtn" onClick={() => fileRef.current?.click()} style={{ fontSize: 13 }} disabled={pdfBusy}>
                  {pdfBusy ? "Reading PDF…" : fileName ? "Choose a different file" : "Choose CSV or PDF…"}
                </button>
                {fileName && (
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                    {fileName}
                    {fileKind === "pdf" && pdfPages && <> · {pdfPages.length} page{pdfPages.length !== 1 ? "s" : ""}</>}
                    {analysis && !analysis.needsManualMapping && !analysis.error && (
                      <> · <strong style={{ color: "var(--text)" }}>{rows.length}</strong> transaction{rows.length !== 1 ? "s" : ""} found
                        {skipped.length > 0 && <> · {skipped.length} skipped</>}</>
                    )}
                  </div>
                )}
                {(analysis?.error || pdfApplyError) && (
                  <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{analysis?.error || pdfApplyError}</div>
                )}
                {pdfAdvisory && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", lineHeight: 1.5 }}>
                    {pdfAdvisory}
                  </div>
                )}
              </div>

              {/* 1b — Manual column mapping fallback (non-BECU / undetected header) */}
              {fileKind === "csv" && fileText && analysis?.needsManualMapping && (
                <ManualMapper fileText={fileText} onApply={setManualCols} amountSign={amountSign} setAmountSign={setAmountSign} selStyle={selStyle} sectionLabel={sectionLabel} />
              )}

              {/* 1c — PDF layout template: auto-detected or previously taught. */}
              {fileKind === "pdf" && pdfPages && pdfTemplate && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                    <div style={sectionLabel}>Statement layout</div>
                    <button className="ibtn" style={{ fontSize: 11 }} onClick={() => setShowEditor(s => !s)}>
                      {showEditor ? "Done adjusting" : "Adjust columns"}
                    </button>
                  </div>
                  <div style={{
                    fontSize: 12, borderRadius: 8, padding: "9px 12px", lineHeight: 1.5,
                    background: pdfApplied?.layoutSuspect ? "var(--danger-bg)" : "var(--bg)",
                    border: `1px solid ${pdfApplied?.layoutSuspect ? "var(--danger-border)" : "var(--border)"}`,
                    color: pdfApplied?.layoutSuspect ? "var(--danger)" : "var(--muted)",
                  }}>
                    {pdfApplied?.layoutSuspect
                      ? "Couldn't read this statement with the saved layout — the bank may have changed its format. Open “Adjust columns” and re-confirm."
                      : (() => {
                        const t = rowTotals(rows);
                        return (
                          <>
                            {templateSource === "saved"
                              ? <>Using the layout you saved for this account. </>
                              : <>Layout detected automatically. </>}
                            <strong style={{ color: "var(--text)" }}>{rows.length}</strong> transactions read,
                            totalling <strong style={{ color: "var(--text)" }}>{money(t.out)} out</strong>
                            {t.in > 0 && <> and <strong style={{ color: "var(--text)" }}>{money(t.in)} in</strong></>}.
                            <br />Compare those totals with the ones printed on your statement — if they match, the whole
                            statement was read correctly.
                          </>
                        );
                      })()}
                  </div>
                  {showEditor && (
                    <div style={{ marginTop: 12 }}>
                      <PdfTemplateEditor pages={pdfPages} template={pdfTemplate} onChange={setPdfTemplate} rowCount={rows.length} />
                      {pdfAutoTemplate && (
                        <button className="ibtn" style={{ fontSize: 11 }} onClick={() => { setPdfTemplate(pdfAutoTemplate); setTemplateSource("auto"); }}>
                          Reset to auto-detected
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 2 — Target account */}
              {(fileKind === "pdf" ? !!pdfApplied : !!fileText) && analysis && !analysis.needsManualMapping && !analysis.error && (
                <>
                  <div style={{ marginBottom: 18 }}>
                    <div style={sectionLabel}>2 · Import into</div>
                    <select value={target} onChange={e => setTarget(e.target.value)} style={selStyle}>
                      <option value="new">➕ New imported account…</option>
                      {manual.length > 0 && (
                        <optgroup label="Imported accounts">
                          {manual.map(a => <option key={a.id} value={a.id}>{a.nickname || a.name}{a.subtype ? ` · ${a.subtype}` : ""}</option>)}
                        </optgroup>
                      )}
                      {simplefin.length > 0 && (
                        <optgroup label="Connected accounts (SimpleFIN)">
                          {/* Hidden accounts ARE offered: getAccounts has no
                              hidden filter and backfilling history before
                              unhiding is a legitimate order of operations. Say
                              so rather than leave it looking like a bug. */}
                          {simplefin.map(a => <option key={a.id} value={a.id}>{a.nickname || a.name}{a.hidden ? " · hidden" : ""}</option>)}
                        </optgroup>
                      )}
                      {other.length > 0 && (
                        <optgroup label="Other accounts — compare only">
                          {other.map(a => <option key={a.id} value={a.id}>{a.nickname || a.name}{a.mask ? ` ··${a.mask}` : ""}</option>)}
                        </optgroup>
                      )}
                    </select>

                    {target === "new" && (
                      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Account name (e.g. Mason Checking)"
                          style={{ ...selStyle, fontSize: 16 }} autoFocus />
                        <div style={{ display: "flex", gap: 8 }}>
                          {["checking", "savings", "credit"].map(st => (
                            <button key={st} onClick={() => setNewSubtype(st)}
                              style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer",
                                // Accent tint, derived from the token so it re-tints in dark mode. If a browser
                                // can't do color-mix the fill just drops out — the accent text + border still
                                // show which subtype is selected.
                                background: newSubtype === st ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "var(--bg)",
                                color: newSubtype === st ? "var(--accent)" : "var(--muted)",
                                border: `1px solid ${newSubtype === st ? "var(--accent)" : "var(--border)"}` }}>
                              {st === "credit" ? "Credit card" : st[0].toUpperCase() + st.slice(1)}
                            </button>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          {newSubtype === "credit"
                            ? "Card purchases count as spending by category; refunds and payments never count as income."
                            : "Savings outflows never count as spending in Trends; pick Checking for a day-to-day account."}
                        </div>
                        {/* Gated on FED accounts, not on `plaid`. `plaid` is
                            "neither manual nor SimpleFIN", which went
                            permanently empty the moment the last Plaid item was
                            unlinked — so this warning silently stopped
                            rendering at exactly the point it started mattering
                            most. It guards the one double-count the overlap
                            guard structurally cannot see: that guard protects
                            the account you PICKED, while this is about picking
                            the wrong one. Importing a BECU statement onto a new
                            manual account while BECU is SimpleFIN-fed doubles
                            every total in the period, and no dedup id can
                            catch it across two accounts. */}
                        {fedAccounts.length > 0 && (
                          <div style={{ fontSize: 11, color: "var(--warn)", background: "var(--warn-bg)", border: "1px solid var(--warn-border)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>
                            Only for an account that <strong>isn't</strong> already connected. If this statement belongs to one of your
                            connected accounts, pick it above instead — importing it here would count every transaction twice.
                          </div>
                        )}
                      </div>
                    )}

                    {mixedSource && (
                      <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: 8, padding: "10px 12px", lineHeight: 1.5 }}>
                        {legacySource
                          ? <>This account already holds imported transactions from before the app started recording which format they
                            came from. If they came from a {incomingSource === "pdf" ? "CSV" : "PDF"}, importing this
                            {incomingSource === "pdf" ? " PDF" : " CSV"} would add every transaction a second time — banks word the same
                            transaction differently in the two formats, so the duplicate check can't see it. Import into a new account instead.</>
                          : <>This account already holds transactions imported from {incomingSource === "pdf" ? "a CSV" : "a PDF"}. Banks word
                            the same transaction differently in the two formats, so importing both would add each transaction twice. Stick to
                            one format per account, or create a separate account for this one.</>}
                      </div>
                    )}

                    {targetIsUnknown && (
                      <div style={{ marginTop: 10, fontSize: 12, color: "var(--warn)", background: "var(--warn-bg)", border: "1px solid var(--warn-border)", borderRadius: 8, padding: "10px 12px", lineHeight: 1.5 }}>
                        This account isn't recognised as connected or imported, so nothing can be imported into it — only compared.
                        Its transactions carry ids from a source this importer can't match against, which means a duplicate would go undetected.
                      </div>
                    )}
                  </div>

                  {/* The verdict: one sentence saying what this file will do.
                      Replaces the old coverage paragraph, which said "no synced
                      transactions yet, so the whole file will import" whenever
                      the boundary was missing — including when the lookup had
                      simply FAILED, and including on an account whose first pull
                      was about to fetch two years of history on top. */}
                  {targetIsSimpleFin && (
                    <div style={{
                      fontSize: 11, lineHeight: 1.6, marginBottom: 12, borderRadius: 8, padding: "10px 12px",
                      color: boundaryState === "error" ? "var(--danger)" : boundaryState === "unsynced" || overlapCount > 0 ? "var(--warn)" : "var(--muted)",
                      background: boundaryState === "error" ? "var(--danger-bg)" : boundaryState === "unsynced" || overlapCount > 0 ? "var(--warn-bg)" : "var(--bg)",
                      border: `1px solid ${boundaryState === "error" ? "var(--danger-border)" : boundaryState === "unsynced" || overlapCount > 0 ? "var(--warn-border)" : "transparent"}`,
                    }}>
                      {boundaryState === "loading" ? "Checking what the feed already has…"
                        : boundaryState === "error" ? <>Couldn't check where this account's feed starts, so importing isn't safe — a statement covering dates the feed already has would count every transaction twice. Close and retry.</>
                        : boundaryState === "unsynced" ? <>This account hasn't synced yet, so there's no boundary to import against — the first pull reaches back up to two years and would land on top of anything imported now.</>
                        : !coverageStart ? <>The feed has no transactions for this account. Rows from the last {FEED_LOOKBACK_DAYS} days are still excluded — the next pull can reach back that far.</>
                        : verdict === "audit" ? <>The feed covers this account from <strong>{overlapFrom}</strong> and every row here is inside that. Nothing will be imported — here's how your statement compares.</>
                        : verdict === "both" ? <>The feed starts <strong>{overlapFrom}</strong>. The <strong>{newRows.length}</strong> row{newRows.length !== 1 ? "s" : ""} before it will import; the <strong>{overlapCount}</strong> on or after it {overlapCount !== 1 ? "are" : "is"} compared against the feed instead.</>
                        : <>The feed starts <strong>{overlapFrom}</strong>. Every row in this file predates it, so there's nothing to exclude.</>}
                    </div>
                  )}

                  {/* The single override, and it only ever points AWAY from
                      inserting. Defaulted to the file's own answer, so on the
                      common paths it is never touched. */}
                  {targetIsExisting && !targetIsUnknown && (
                    <div style={{ marginBottom: 12 }}>
                      {compareOnly ? (
                        <button className="ibtn" style={{ width: "100%", justifyContent: "center", minHeight: 44 }} onClick={() => setCompareOnly(false)}>
                          ← Back to import
                        </button>
                      ) : verdict !== "audit" && (
                        <button
                          className="ibtn"
                          style={{ width: "100%", justifyContent: "center", minHeight: 44, opacity: !loadingIds && existingIds.size === 0 ? .45 : 1 }}
                          disabled={!loadingIds && existingIds.size === 0}
                          title={!loadingIds && existingIds.size === 0 ? "Nothing on this account to compare against" : ""}
                          onClick={() => setCompareOnly(true)}>
                          Compare only — don't import
                        </button>
                      )}
                    </div>
                  )}

                  {auditShown && (
                    <Reconciliation recon={recon} loading={reconLoading} sectionLabel={sectionLabel} step={previewShown ? 4 : 3} />
                  )}

                  {/* Preview — only when something can actually be inserted. */}
                  {previewShown && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={sectionLabel}>3 · Preview</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        {loadingIds || coverageLoading ? "checking…" : (
                          <><strong style={{ color: "var(--text)" }}>{newRows.length}</strong> new{dupCount > 0 && <> · {dupCount} duplicate</>}{overlapCount > 0 && <> · {overlapCount} compared instead</>}</>
                        )}
                      </div>
                    </div>

                    <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                      {preview.length === 0 && <div style={{ padding: "18px 12px", textAlign: "center", fontSize: 13, color: "var(--muted)" }}>No importable rows.</div>}
                      {preview.map((r, i) => (
                        <div key={r.plaid_tx_id + i} style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                          borderBottom: i < preview.length - 1 ? "1px solid var(--border)" : "none",
                          opacity: r.isDuplicate || r.isOverlap ? .4 : 1,
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: r.isDuplicate || r.isOverlap ? "line-through" : "none" }}>
                              {r.description}
                            </div>
                            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                              <span>{r.date}</span>
                              <span>·</span>
                              <span>{r.mapped_category}</span>
                              {r.isTransfer && <span style={{ background: "var(--bg)", color: "var(--muted)", borderRadius: 10, padding: "1px 6px", fontWeight: 600 }}>transfer</span>}
                              {r.isDuplicate && <span style={{ background: "var(--bg)", color: "var(--muted)", borderRadius: 10, padding: "1px 6px", fontWeight: 600 }}>already imported</span>}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", fontWeight: 500, flexShrink: 0, color: r.amount < 0 ? readableInk(MONEY_IN, cardSurface) : "var(--text)" }}>
                            {money(r.amount)}
                          </div>
                        </div>
                      ))}
                    </div>
                    {rows.length > preview.length && (
                      <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", marginTop: 6 }}>
                        Showing the first {preview.length} of {rows.length}. All {newRows.length} new rows import.
                      </div>
                    )}
                    {skipped.length > 0 && (
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, background: "var(--bg)", borderRadius: 8, padding: "8px 10px" }}>
                        {skipped.length} row{skipped.length !== 1 ? "s" : ""} skipped (unreadable date/amount or $0): {skipped.slice(0, 3).map(s => s.rawDesc || s.rawDate || "—").join(", ")}{skipped.length > 3 ? "…" : ""}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
                      Positive = money out, negative (green) = money in. Importing past months will recompute earlier Trends
                      figures — that's the intended whole-household correction, not a bug.
                    </div>
                  </div>
                  )}
                </>
              )}

              {error && (
                <div style={{ fontSize: 12, color: "var(--danger)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>{error}</div>
              )}
            </>
          )}
          </ModalErrorBoundary>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", gap: 8, padding: "14px 20px", borderTop: "1px solid var(--border)" }}>
          {result ? (
            <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "var(--accent)", color: "var(--accent-text)", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Done</button>
          ) : auditOnly ? (
            // Nothing to insert — the only action is to close.
            <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "var(--accent)", color: "var(--accent-text)", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Close (nothing imported)</button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy || syncState === "running"} className="ibtn" style={{ flex: 1, justifyContent: "center", opacity: busy ? .5 : 1 }}>Cancel</button>
              {/* On a never-synced fed account the primary action is to SYNC,
                  not to import — there is no boundary to import against yet, and
                  inventing one is how you double-count two years of history. */}
              <button onClick={needsSyncFirst ? syncNow : confirm} disabled={!primaryOn}
                style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: "none", background: "var(--accent)", color: "var(--accent-text)", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: primaryOn ? "pointer" : "default", opacity: primaryOn ? 1 : .5 }}>
                {primaryLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
    , document.body);
}

// Fallback when the header can't be auto-detected: show the first parsed rows
// and let the user assign each column role by index. Feeds the same buildRows.
function ManualMapper({ fileText, onApply, amountSign, setAmountSign, selStyle, sectionLabel }) {
  const [headerIndex, setHeaderIndex] = useState(0);
  const [cols, setCols] = useState({ date: -1, description: -1, debit: -1, credit: -1, amount: -1 });
  const [mode, setMode] = useState("debitcredit"); // or "amount"

  // First few parsed rows as a grid to eyeball while assigning column roles.
  const grid = useMemo(() => parseCsv(fileText).slice(0, 6), [fileText]);

  const ncols = grid.reduce((n, r) => Math.max(n, r.length), 0);
  const setRole = (role, idx) => setCols(c => ({ ...c, [role]: idx }));

  function apply() {
    const m = { headerIndex, date: cols.date, description: cols.description };
    if (mode === "debitcredit") { m.debit = cols.debit; m.credit = cols.credit; m.amount = -1; }
    else { m.amount = cols.amount; m.debit = -1; m.credit = -1; }
    onApply(m);
  }

  const roles = mode === "debitcredit" ? ["date", "description", "debit", "credit"] : ["date", "description", "amount"];
  const ready = roles.every(r => cols[r] >= 0);

  return (
    <div style={{ marginBottom: 18, background: "var(--bg)", borderRadius: 10, padding: 12 }}>
      <div style={sectionLabel}>Map columns (header not auto-detected)</div>
      <div style={{ overflowX: "auto", marginBottom: 10 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
          <tbody>
            {grid.map((row, ri) => (
              <tr key={ri} style={{ opacity: ri === headerIndex ? 1 : .6 }}>
                <td style={{ color: "var(--muted)", padding: "2px 6px" }}>{ri}{ri === headerIndex ? " (hdr)" : ""}</td>
                {Array.from({ length: ncols }).map((_, ci) => (
                  <td key={ci} style={{ border: "1px solid var(--border)", padding: "2px 6px", whiteSpace: "nowrap", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{row[ci] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 11, color: "var(--muted)" }}>Header row
          <input type="number" min={0} value={headerIndex} onChange={e => setHeaderIndex(Math.max(0, +e.target.value || 0))}
            style={{ ...selStyle, width: 60, marginLeft: 6, display: "inline-block", padding: "4px 6px" }} />
        </label>
        <select value={mode} onChange={e => setMode(e.target.value)} style={{ ...selStyle, width: "auto" }}>
          <option value="debitcredit">Separate Debit / Credit</option>
          <option value="amount">Single signed Amount</option>
        </select>
        {mode === "amount" && (
          <select value={amountSign} onChange={e => setAmountSign(e.target.value)} style={{ ...selStyle, width: "auto" }}>
            <option value="in_positive">+ = money in</option>
            <option value="out_positive">+ = money out</option>
          </select>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 8, marginTop: 10 }}>
        {roles.map(role => (
          <label key={role} style={{ fontSize: 11, color: "var(--muted)" }}>{ROLE_LABELS[role]}
            <select value={cols[role]} onChange={e => setRole(role, +e.target.value)} style={{ ...selStyle, marginTop: 4 }}>
              <option value={-1}>—</option>
              {Array.from({ length: ncols }).map((_, ci) => <option key={ci} value={ci}>col {ci}{grid[headerIndex]?.[ci] ? ` (${grid[headerIndex][ci]})` : ""}</option>)}
            </select>
          </label>
        ))}
      </div>
      <button className="ibtn" onClick={apply} disabled={!ready} style={{ marginTop: 10, fontSize: 12, opacity: ready ? 1 : .5 }}>Apply mapping</button>
    </div>
  );
}

// The audit. Reconciles the statement against what the account already holds
// and shows
// NOTE the `plaidOnly` / `plaidTotal` / `plaidDescriptor` keys below come from
// reconcileCsv and are deliberately NOT renamed: they mean "already on this
// account", the same adapter-agnostic sense as the plaid_tx_id column, and
// reconcileCsv has no test coverage to catch a rename going wrong.
// four buckets. Inserts nothing. Kept compact + mobile-first; each list caps at
// 50 rows with a "+N more" line so a big month doesn't blow up the modal.
//
// The bucket hues (MONEY_IN / SYNC_GAP / AMOUNT_DIFF, plus the --muted token for
// the neutral one) are a STATUS palette, one hue per bucket, drawn as a dot + a
// tinted chip. They are not theme tokens — the buckets must stay distinguishable
// from each other — so instead of hoping a fixed hue "holds up" on both
// surfaces, each is contrast-corrected at render against the surface it sits on
// (chip → --card, section dot → --bg).
const RECON_CAP = 50;

function ReconRow({ left, sub, amount, amountNote }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", borderTop: "1px solid var(--border)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{left}</div>
        {sub && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", fontWeight: 500 }}>{amount}</div>
        {amountNote && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>{amountNote}</div>}
      </div>
    </div>
  );
}

function ReconSection({ title, hint, color, count, children }) {
  // Hook before the early return — the section header paints --bg, so the dot
  // is corrected against --bg, not against the card behind it.
  const bgSurface = useSurface("--bg");
  if (!count) return null;
  return (
    <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "9px 12px", background: "var(--bg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: markColor(color, bgSurface), flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>· {count}</span>
        </div>
        {hint && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Reconciliation({ recon, loading, sectionLabel, step = 3 }) {
  // Hooks before the early returns. The chips sit on the modal panel (--card).
  // The neutral "feed-only" bucket takes its hue from the --muted TOKEN read at
  // runtime rather than the #888780 literal it used to hardcode — that literal
  // was light mode's --muted value verbatim, so it stayed a light-mode grey on a
  // dark card. As a token it adapts, and still reads as the neutral of the four.
  const cardSurface = useSurface("--card");
  const neutralHue = useSurface("--muted");
  if (loading) {
    return <div style={{ marginBottom: 10 }}><div style={sectionLabel}>Comparing against the feed…</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>Reconciling the CSV against what's already synced — nothing will be imported.</div></div>;
  }
  if (!recon) return null;
  const c = recon.counts;
  const cleanMatched = recon.matched.filter(m => !m.dateMismatch && !m.categoryMismatch).length;
  const flaggedMatched = recon.matched.filter(m => m.dateMismatch || m.categoryMismatch);

  // chipStyle's default tintAlpha (0.1333 = 0x22/255) reproduces the old
  // `color + "22"` tint exactly on the light card, then derives a label ink and
  // a dot that clear 4.5:1 / 3:1 against that tint on whichever surface is live.
  const chip = (label, n, color) => {
    const s = chipStyle(color, cardSurface);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, background: s.bg, color: s.ink, borderRadius: 20, padding: "3px 9px" }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.dot }} />{n} {label}
      </span>
    );
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={sectionLabel}>{step} · Comparison audit</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.csvTotal} in file · {c.plaidTotal} already on this account</div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {chip("matched", c.matched, MONEY_IN)}
        {chip("sync gap" + (c.csvOnly !== 1 ? "s" : ""), c.csvOnly, SYNC_GAP)}
        {chip("amount diff" + (c.amountMismatches !== 1 ? "s" : ""), c.amountMismatches, AMOUNT_DIFF)}
        {chip("feed-only", c.plaidOnly, neutralHue)}
      </div>

      <ReconSection title="In your statement, missing here" hint="Possible sync gaps — the feed may not have picked these up." color={SYNC_GAP} count={recon.csvOnly.length}>
        {recon.csvOnly.slice(0, RECON_CAP).map((r, i) => (
          <ReconRow key={i} left={r.description} sub={r.date} amount={money(r.amount)} />
        ))}
        {recon.csvOnly.length > RECON_CAP && <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "6px 0" }}>+{recon.csvOnly.length - RECON_CAP} more</div>}
      </ReconSection>

      <ReconSection title="Amount differs" hint="Same merchant a few days apart, different amount — likely the same transaction (a tip, a pending vs posted change)." color={AMOUNT_DIFF} count={recon.amountMismatches.length}>
        {recon.amountMismatches.slice(0, RECON_CAP).map((m, i) => (
          <ReconRow key={i} left={m.csv.description}
            sub={`statement ${m.csv.date} · feed ${m.plaid.date}`}
            amount={`${money(m.csv.amount)} → ${money(m.plaid.amount)}`}
            amountNote={`${m.amountDiff > 0 ? "+" : ""}${money(m.amountDiff)}`} />
        ))}
      </ReconSection>

      <ReconSection title="On this account, not in your statement" hint="Pending, timing, or simply not in this export yet." color={neutralHue} count={recon.plaidOnly.length}>
        {recon.plaidOnly.slice(0, RECON_CAP).map((r, i) => (
          <ReconRow key={i} left={r.description || r.merchant_name || "Transaction"} sub={`${r.date}${r.pending ? " · pending" : ""}`} amount={money(r.amount)} />
        ))}
        {recon.plaidOnly.length > RECON_CAP && <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "6px 0" }}>+{recon.plaidOnly.length - RECON_CAP} more</div>}
      </ReconSection>

      <ReconSection title="Matched, with differences" hint="Paired by amount + date, but the date or category disagrees." color={MATCH_DIFF} count={flaggedMatched.length}>
        {flaggedMatched.slice(0, RECON_CAP).map((m, i) => (
          <ReconRow key={i} left={m.csv.description}
            sub={[m.dateMismatch ? `date ${m.csv.date}→${m.plaid.date}` : null,
                  m.categoryMismatch ? `category statement "${m.csv.mapped_category}" vs feed "${m.plaid.user_category || m.plaid.mapped_category}"` : null].filter(Boolean).join(" · ")}
            amount={money(m.csv.amount)} />
        ))}
      </ReconSection>

      <div style={{ fontSize: 11, color: "var(--muted)", background: "var(--bg)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>
        {cleanMatched} of {c.csvTotal} statement rows matched cleanly. Nothing was imported.
      </div>
    </div>
  );
}
