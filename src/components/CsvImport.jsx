import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeCsv, toInsertRow, parseCsv, reconcileCsv, csvDateRange } from "../csvImport.js";
import { createManualAccount, importCsvTransactions, getExistingTxIds, getAccountTransactionsInRange, isManualAccount, getCategoryRules } from "../dataAdapter.js";

// CSV import — a file-picker action on the Accounts tab, in two modes chosen by
// the target account:
//  • STANDALONE (Phase 1) — target is a new/existing MANUAL account: pick a
//    bank CSV → preview the exact rows → confirm → real transactions land on a
//    non-Plaid account. No DB write before Confirm; the preview greys out rows a
//    prior import already inserted (stable csv:… id) so re-imports are safe.
//  • COMPARISON (Phase 2) — target is a PLAID-LINKED account: insert NOTHING
//    (that's the double-count trap). Reconcile the CSV against what Plaid
//    already synced and show a read-only audit — sync gaps, pending/timing, and
//    amount/date/category mismatches on matched pairs.

// Pad an ISO date by ±days so the Plaid fetch covers the CSV's period plus the
// date-drift window on both ends. Explicit UTC math — never new Date(string).
function padIso(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function money(n) {
  const v = Number(n);
  const s = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? "−" + s : s; // negative = money in
}

const ROLE_LABELS = { date: "Date", description: "Description", debit: "Debit", credit: "Credit", amount: "Amount (signed)" };

export default function CsvImport({ accounts = [], onClose, onImported }) {
  const [fileName, setFileName] = useState(null);
  const [fileText, setFileText] = useState(null);
  const [manualCols, setManualCols] = useState(null); // {headerIndex,date,description,debit,credit,amount}
  const [amountSign, setAmountSign] = useState("in_positive");
  const [target, setTarget] = useState("new"); // "new" | accountId
  const [newName, setNewName] = useState("");
  const [newSubtype, setNewSubtype] = useState("checking");
  const [existingIds, setExistingIds] = useState(new Set());
  // Learned merchant rules, so an import agrees with what the household has
  // already taught the classifier instead of re-deriving from keywords alone.
  const [rules, setRules] = useState(null);
  const [loadingIds, setLoadingIds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [recon, setRecon] = useState(null);
  const [reconLoading, setReconLoading] = useState(false);
  const fileRef = useRef(null);

  const manual = accounts.filter(isManualAccount);
  const plaid = accounts.filter(a => !isManualAccount(a));
  const targetIsPlaid = target !== "new" && plaid.some(a => a.id === target);
  const targetAcct = target !== "new" ? accounts.find(a => a.id === target) : null;

  // Parse + build rows. Small files → cheap to recompute on every change.
  const analysis = useMemo(() => {
    if (!fileText) return null;
    try {
      return analyzeCsv(fileText, { existingIds, manualColumns: manualCols, amountSign, rules });
    } catch (e) {
      return { error: e.message, rows: [], skipped: [], needsManualMapping: false };
    }
  }, [fileText, existingIds, manualCols, amountSign, rules]);

  // Learned merchant rules, loaded once — analyzeCsv re-runs when they arrive.
  useEffect(() => {
    let cancelled = false;
    getCategoryRules()
      .then(r => { if (!cancelled) setRules(r); })
      .catch(err => { console.error("category rules unavailable", err); if (!cancelled) setRules({}); });
    return () => { cancelled = true; };
  }, []);

  // Load the target account's existing ids so dupes grey out. New account or a
  // Plaid target (comparison mode, no insert) → none.
  useEffect(() => {
    if (target === "new" || targetIsPlaid) { setExistingIds(new Set()); return; }
    let cancelled = false;
    setLoadingIds(true);
    getExistingTxIds(target)
      .then(ids => { if (!cancelled) setExistingIds(ids); })
      .catch(() => { if (!cancelled) setExistingIds(new Set()); })
      .finally(() => { if (!cancelled) setLoadingIds(false); });
    return () => { cancelled = true; };
  }, [target, targetIsPlaid]);

  // Comparison mode: when the target is Plaid-linked, reconcile the CSV against
  // what Plaid already synced over the CSV's date range (± the drift window).
  // Inserts nothing — this only reads and audits.
  const csvRows = analysis && !analysis.needsManualMapping && !analysis.error ? analysis.rows : null;
  useEffect(() => {
    if (!targetIsPlaid || !csvRows) { setRecon(null); return; }
    const { min, max } = csvDateRange(csvRows);
    if (!min || !max) { setRecon({ counts: { matched: 0, csvOnly: 0, plaidOnly: 0, amountMismatches: 0 }, matched: [], amountMismatches: [], csvOnly: [], plaidOnly: [] }); return; }
    let cancelled = false;
    setReconLoading(true);
    getAccountTransactionsInRange(target, padIso(min, -7), padIso(max, 7))
      .then(plaidRows => { if (!cancelled) setRecon(reconcileCsv(csvRows, plaidRows)); })
      .catch(e => { if (!cancelled) { console.error("reconcile failed", e); setError(e.message || "Couldn't load Plaid transactions to compare."); setRecon(null); } })
      .finally(() => { if (!cancelled) setReconLoading(false); });
    return () => { cancelled = true; };
  }, [target, targetIsPlaid, csvRows]);

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    setResult(null);
    setManualCols(null);
    setFileName(f.name);
    try {
      const text = await f.text();
      setFileText(text);
    } catch {
      setError("Couldn't read that file.");
    }
  }

  const rows = analysis?.rows || [];
  const newRows = rows.filter(r => !r.isDuplicate);
  const dupCount = rows.length - newRows.length;
  const skipped = analysis?.skipped || [];
  const preview = rows.slice(0, 200);

  const canConfirm =
    !!analysis && !analysis.needsManualMapping && !analysis.error && !busy && !loadingIds &&
    !targetIsPlaid && newRows.length > 0 &&
    (target !== "new" || newName.trim().length > 0);

  async function confirm() {
    if (!canConfirm) return;
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
      const written = await importCsvTransactions(accountId, payload);
      setResult({ written, dupCount, skipped: skipped.length, accountName });
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
  const selStyle = { fontSize: 13, fontFamily: "inherit", color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", outline: "none", width: "100%" };

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div onClick={e => e.stopPropagation()} style={panelStyle}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Import transactions from CSV</div>
          <button onClick={onClose} disabled={busy} className="nbtn" title="Close" style={{ opacity: busy ? .4 : 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 20px", overflowY: "auto" }}>
          {result ? (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 34, marginBottom: 8 }}>✓</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                Imported {result.written} transaction{result.written !== 1 ? "s" : ""}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                into <strong style={{ color: "var(--text)" }}>{result.accountName}</strong>.<br />
                {result.dupCount > 0 && <>Skipped {result.dupCount} already-imported row{result.dupCount !== 1 ? "s" : ""}. </>}
                {result.skipped > 0 && <>Ignored {result.skipped} unreadable/zero row{result.skipped !== 1 ? "s" : ""}.</>}
              </div>
            </div>
          ) : (
            <>
              {/* 1 — File */}
              <div style={{ marginBottom: 18 }}>
                <div style={sectionLabel}>1 · Choose a CSV file</div>
                <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile}
                  style={{ display: "none" }} />
                <button className="ibtn" onClick={() => fileRef.current?.click()} style={{ fontSize: 13 }}>
                  {fileName ? "Choose a different file" : "Choose file…"}
                </button>
                {fileName && (
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                    {fileName}
                    {analysis && !analysis.needsManualMapping && !analysis.error && (
                      <> · <strong style={{ color: "var(--text)" }}>{rows.length}</strong> transaction{rows.length !== 1 ? "s" : ""} found
                        {skipped.length > 0 && <> · {skipped.length} skipped</>}</>
                    )}
                  </div>
                )}
                {analysis?.error && (
                  <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{analysis.error}</div>
                )}
              </div>

              {/* 1b — Manual column mapping fallback (non-BECU / undetected header) */}
              {fileText && analysis?.needsManualMapping && (
                <ManualMapper fileText={fileText} onApply={setManualCols} amountSign={amountSign} setAmountSign={setAmountSign} selStyle={selStyle} sectionLabel={sectionLabel} />
              )}

              {/* 2 — Target account */}
              {fileText && analysis && !analysis.needsManualMapping && !analysis.error && (
                <>
                  <div style={{ marginBottom: 18 }}>
                    <div style={sectionLabel}>2 · Import into</div>
                    <select value={target} onChange={e => setTarget(e.target.value)} style={selStyle}>
                      <option value="new">➕ New imported account…</option>
                      {manual.length > 0 && (
                        <optgroup label="Imported accounts (re-import / add)">
                          {manual.map(a => <option key={a.id} value={a.id}>{a.nickname || a.name}{a.subtype ? ` · ${a.subtype}` : ""}</option>)}
                        </optgroup>
                      )}
                      {plaid.length > 0 && (
                        <optgroup label="Plaid-linked — compare (reconcile, nothing imported)">
                          {plaid.map(a => <option key={a.id} value={a.id}>{a.nickname || a.name}{a.mask ? ` ··${a.mask}` : ""}</option>)}
                        </optgroup>
                      )}
                    </select>

                    {target === "new" && (
                      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Account name (e.g. Mason Checking)"
                          style={{ ...selStyle, fontSize: 16 }} autoFocus />
                        <div style={{ display: "flex", gap: 8 }}>
                          {["checking", "savings"].map(st => (
                            <button key={st} onClick={() => setNewSubtype(st)}
                              style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer",
                                background: newSubtype === st ? "#7F77DD22" : "var(--bg)", color: newSubtype === st ? "#7F77DD" : "var(--muted)",
                                border: `1px solid ${newSubtype === st ? "#7F77DD" : "var(--border)"}` }}>
                              {st[0].toUpperCase() + st.slice(1)}
                            </button>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          Savings outflows never count as spending in Trends; pick Checking for a day-to-day account.
                        </div>
                      </div>
                    )}

                    {targetIsPlaid && (
                      <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", lineHeight: 1.5 }}>
                        This account already syncs via Plaid. Nothing will be imported — the CSV is compared against what Plaid synced
                        to surface sync gaps, pending/timing differences, and amount mismatches.
                      </div>
                    )}
                  </div>

                  {/* 3 — Comparison audit (Plaid target) */}
                  {targetIsPlaid && (
                    <Reconciliation recon={recon} loading={reconLoading} sectionLabel={sectionLabel} />
                  )}

                  {/* 3 — Preview (standalone: new/manual target) */}
                  {!targetIsPlaid && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={sectionLabel}>3 · Preview</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        {loadingIds ? "checking for duplicates…" : (
                          <><strong style={{ color: "var(--text)" }}>{newRows.length}</strong> new{dupCount > 0 && <> · {dupCount} duplicate</>}</>
                        )}
                      </div>
                    </div>

                    <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                      {preview.length === 0 && <div style={{ padding: "18px 12px", textAlign: "center", fontSize: 13, color: "var(--muted)" }}>No importable rows.</div>}
                      {preview.map((r, i) => (
                        <div key={r.plaid_tx_id + i} style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                          borderBottom: i < preview.length - 1 ? "1px solid var(--border)" : "none",
                          opacity: r.isDuplicate ? .4 : 1,
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: r.isDuplicate ? "line-through" : "none" }}>
                              {r.description}
                            </div>
                            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                              <span>{r.date}</span>
                              <span>·</span>
                              <span>{r.mapped_category}</span>
                              {r.isTransfer && <span style={{ background: "#88878022", color: "#888780", borderRadius: 10, padding: "1px 6px", fontWeight: 600 }}>transfer</span>}
                              {r.isDuplicate && <span style={{ background: "#88878022", color: "#888780", borderRadius: 10, padding: "1px 6px", fontWeight: 600 }}>already imported</span>}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", fontWeight: 500, flexShrink: 0, color: r.amount < 0 ? "#1D9E75" : "var(--text)" }}>
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
                <div style={{ fontSize: 12, color: "#A32D2D", background: "#FCEBEB", border: "1px solid #F09595", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>{error}</div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", gap: 8, padding: "14px 20px", borderTop: "1px solid var(--border)" }}>
          {result ? (
            <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "#7F77DD", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Done</button>
          ) : targetIsPlaid ? (
            // Comparison mode inserts nothing — only a close action.
            <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "#7F77DD", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Close (nothing imported)</button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy} className="ibtn" style={{ flex: 1, justifyContent: "center", opacity: busy ? .5 : 1 }}>Cancel</button>
              <button onClick={confirm} disabled={!canConfirm}
                style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: "none", background: "#7F77DD", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: canConfirm ? "pointer" : "default", opacity: canConfirm ? 1 : .5 }}>
                {busy ? "Importing…" : `Import ${newRows.length || ""} transaction${newRows.length !== 1 ? "s" : ""}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
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

// Comparison-mode audit. Reconciles the CSV against Plaid-synced rows and shows
// four buckets. Inserts nothing. Kept compact + mobile-first; each list caps at
// 50 rows with a "+N more" line so a big month doesn't blow up the modal.
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
  if (!count) return null;
  return (
    <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "9px 12px", background: "var(--bg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>· {count}</span>
        </div>
        {hint && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Reconciliation({ recon, loading, sectionLabel }) {
  if (loading) {
    return <div style={{ marginBottom: 10 }}><div style={sectionLabel}>Comparing against Plaid…</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>Reconciling the CSV against what's already synced — nothing will be imported.</div></div>;
  }
  if (!recon) return null;
  const c = recon.counts;
  const cleanMatched = recon.matched.filter(m => !m.dateMismatch && !m.categoryMismatch).length;
  const flaggedMatched = recon.matched.filter(m => m.dateMismatch || m.categoryMismatch);

  const chip = (label, n, color) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, background: color + "22", color, borderRadius: 20, padding: "3px 9px" }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />{n} {label}
    </span>
  );

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={sectionLabel}>3 · Comparison audit</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.csvTotal} CSV · {c.plaidTotal} synced</div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {chip("matched", c.matched, "#1D9E75")}
        {chip("sync gap" + (c.csvOnly !== 1 ? "s" : ""), c.csvOnly, "#D85A30")}
        {chip("amount diff" + (c.amountMismatches !== 1 ? "s" : ""), c.amountMismatches, "#B7791F")}
        {chip("Plaid-only", c.plaidOnly, "#888780")}
      </div>

      <ReconSection title="In your CSV, missing from Plaid" hint="Possible sync gaps — Plaid may not have picked these up." color="#D85A30" count={recon.csvOnly.length}>
        {recon.csvOnly.slice(0, RECON_CAP).map((r, i) => (
          <ReconRow key={i} left={r.description} sub={r.date} amount={money(r.amount)} />
        ))}
        {recon.csvOnly.length > RECON_CAP && <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "6px 0" }}>+{recon.csvOnly.length - RECON_CAP} more</div>}
      </ReconSection>

      <ReconSection title="Amount differs" hint="Same merchant a few days apart, different amount — likely the same transaction (a tip, a pending vs posted change)." color="#B7791F" count={recon.amountMismatches.length}>
        {recon.amountMismatches.slice(0, RECON_CAP).map((m, i) => (
          <ReconRow key={i} left={m.csv.description}
            sub={`CSV ${m.csv.date} · Plaid ${m.plaid.date}`}
            amount={`${money(m.csv.amount)} → ${money(m.plaid.amount)}`}
            amountNote={`${m.amountDiff > 0 ? "+" : ""}${money(m.amountDiff)}`} />
        ))}
      </ReconSection>

      <ReconSection title="Synced by Plaid, not in your CSV" hint="Pending, timing, or simply not in this export yet." color="#888780" count={recon.plaidOnly.length}>
        {recon.plaidOnly.slice(0, RECON_CAP).map((r, i) => (
          <ReconRow key={i} left={r.description || r.merchant_name || "Transaction"} sub={`${r.date}${r.pending ? " · pending" : ""}`} amount={money(r.amount)} />
        ))}
        {recon.plaidOnly.length > RECON_CAP && <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "6px 0" }}>+{recon.plaidOnly.length - RECON_CAP} more</div>}
      </ReconSection>

      <ReconSection title="Matched, with differences" hint="Paired by amount + date, but the date or category disagrees." color="#378ADD" count={flaggedMatched.length}>
        {flaggedMatched.slice(0, RECON_CAP).map((m, i) => (
          <ReconRow key={i} left={m.csv.description}
            sub={[m.dateMismatch ? `date ${m.csv.date}→${m.plaid.date}` : null,
                  m.categoryMismatch ? `category CSV "${m.csv.mapped_category}" vs Plaid "${m.plaid.user_category || m.plaid.mapped_category}"` : null].filter(Boolean).join(" · ")}
            amount={money(m.csv.amount)} />
        ))}
      </ReconSection>

      <div style={{ fontSize: 11, color: "var(--muted)", background: "var(--bg)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>
        {cleanMatched} of {c.csvTotal} CSV rows matched cleanly. Nothing was imported — this account stays Plaid-synced.
      </div>
    </div>
  );
}
