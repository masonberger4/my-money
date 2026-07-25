import { useEffect, useMemo, useRef, useState } from "react";
import { applyTemplate, COLUMN_ROLES, splitLineIntoCells, groupIntoLines } from "../pdfImport.js";

// Visual "teach it once" template editor.
//
// The statement is rendered from its own text runs (positioned exactly as in
// the PDF — no canvas, no image), with draggable vertical rules marking the
// column boundaries. The user labels each column (Date / Description / Debit /
// Credit / Amount / ignore) and the parsed result updates live underneath.
//
// Nothing here is bank-specific: the resulting template is saved per account
// and re-applied to later statements, so a layout is taught once rather than
// hard-coded.

const ROLE_LABELS = {
  date: "Date", date2: "Date 2", description: "Description",
  debit: "Debit / charges", credit: "Credit / payments", amount: "Amount", ignore: "— ignore —",
};
const ROLE_COLORS = {
  date: "#378ADD", date2: "#7F9BDD", description: "#7F77DD",
  debit: "#D85A30", credit: "#1D9E75", amount: "#B7791F", ignore: "#888780",
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export default function PdfTemplateEditor({ pages, template, onChange, rowCount }) {
  const [pageIdx, setPageIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const wrapRef = useRef(null);
  const [wrapW, setWrapW] = useState(340);

  const page = pages?.[Math.min(pageIdx, (pages?.length || 1) - 1)] || null;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWrapW(el.clientWidth || 340);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  // Jump to the first page that actually yields rows, so the user lands on the
  // transaction table rather than the cover page.
  const applied = useMemo(() => (pages && template ? applyTemplate(pages, template) : null), [pages, template]);
  useEffect(() => {
    if (!applied?.rowMeta?.length) return;
    const first = applied.rowMeta[0].page;
    setPageIdx(p => (pages[p]?.page === first ? p : Math.max(0, pages.findIndex(pg => pg.page === first))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  if (!page || !template) return null;

  const scale = ((wrapW - 2) / page.width) * zoom;
  const boundaries = template.boundaries || [];
  const roles = template.roles || [];
  const nCols = boundaries.length + 1;

  // Functional updates throughout: a pointer drag fires many times against a
  // closure captured at pointerdown, and spreading the stale `template` there
  // would throw away the very change being made.
  const set = patch => onChange(prev => ({ ...prev, ...patch }));
  const setRole = (i, role) => {
    const next = [...roles];
    while (next.length < nCols) next.push("ignore");
    // A role other than 'ignore' is unique — taking it releases the old holder.
    if (role !== "ignore") next.forEach((r, j) => { if (r === role && j !== i) next[j] = "ignore"; });
    next[i] = role;
    set({ roles: next.slice(0, nCols) });
  };

  function dragBoundary(e, i) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = boundaries[i];
    const px = page.width * scale;
    const move = ev => {
      const nextVal = clamp(start + (ev.clientX - startX) / px, 0.02, 0.98);
      onChange(prev => {
        const next = [...(prev.boundaries || [])];
        next[i] = Math.round(nextVal * 10000) / 10000;
        return { ...prev, boundaries: next };
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // Re-sort after a drag so column order always matches visual order —
      // reading the CURRENT boundaries, not the ones captured at pointerdown.
      onChange(prev => ({ ...prev, boundaries: [...(prev.boundaries || [])].sort((a, b) => a - b) }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function addBoundaryAt(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left) / rect.width, 0.02, 0.98);
    const next = [...boundaries, Math.round(frac * 10000) / 10000].sort((a, b) => a - b);
    const insertAt = next.indexOf(Math.round(frac * 10000) / 10000);
    const nextRoles = [...roles];
    nextRoles.splice(insertAt, 0, "ignore");
    set({ boundaries: next, roles: nextRoles });
  }

  function removeBoundary(i) {
    const next = boundaries.filter((_, j) => j !== i);
    const nextRoles = roles.filter((_, j) => j !== i + 1);
    set({ boundaries: next, roles: nextRoles });
  }

  // Sample cell values for the current page's first matching row, so each
  // column selector shows what it is actually capturing.
  const sample = useMemo(() => {
    const lines = groupIntoLines(page.runs);
    const meta = applied?.rowMeta?.find(m => m.page === page.page);
    const line = meta ? lines.find(l => Math.abs(l.y - meta.y) < 1.5) : null;
    return line ? splitLineIntoCells(line, boundaries, page.width) : null;
  }, [page, boundaries, applied]);

  const rowsOnPage = applied?.rowMeta?.filter(m => m.page === page.page) || [];
  const rowYs = new Set(rowsOnPage.map(m => Math.round(m.y)));

  const label = { fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" };
  const sel = { fontSize: 12, fontFamily: "inherit", color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", outline: "none", width: "100%" };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <div style={label}>Columns on this statement</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button className="nbtn" onClick={() => setPageIdx(p => Math.max(0, p - 1))} disabled={pageIdx === 0} title="Previous page">‹</button>
          <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 52, textAlign: "center" }}>p{page.page}/{pages.length}</span>
          <button className="nbtn" onClick={() => setPageIdx(p => Math.min(pages.length - 1, p + 1))} disabled={pageIdx >= pages.length - 1} title="Next page">›</button>
          <button className="nbtn" onClick={() => setZoom(z => clamp(z * 1.3, 1, 4))} title="Zoom in">+</button>
          <button className="nbtn" onClick={() => setZoom(1)} title="Fit width" style={{ fontSize: 11 }}>⤢</button>
        </div>
      </div>

      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8, lineHeight: 1.5 }}>
        Drag a line to move a column edge · tap empty space to add one · highlighted rows are the
        transactions being read.
      </div>

      {/* Page render: the statement's own text runs, positioned. */}
      <div ref={wrapRef} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", background: "var(--card)", maxHeight: 300 }}>
        <div
          onClick={addBoundaryAt}
          style={{ position: "relative", width: page.width * scale, height: page.height * scale, cursor: "crosshair" }}
        >
          {/* highlight the detected transaction rows */}
          {rowsOnPage.map((m, i) => (
            <div key={`hl${i}`} style={{
              position: "absolute", left: 0, right: 0, top: (m.y - 1) * scale, height: 11 * scale,
              background: "#7F77DD18", pointerEvents: "none",
            }} />
          ))}
          {page.runs.map((r, i) => (
            <div key={i} style={{
              position: "absolute", left: r.x * scale, top: r.y * scale,
              fontSize: Math.max(3, (r.h || 9) * scale * 0.92), lineHeight: 1,
              whiteSpace: "pre", color: rowYs.has(Math.round(r.y)) ? "var(--text)" : "var(--muted)",
              fontFamily: "'DM Mono',monospace", pointerEvents: "none",
            }}>{r.str}</div>
          ))}
          {/* column boundary rules */}
          {boundaries.map((b, i) => (
            <div key={`b${i}`}
              onPointerDown={e => dragBoundary(e, i)}
              onClick={e => e.stopPropagation()}
              title="Drag to move · double-click to remove"
              onDoubleClick={e => { e.stopPropagation(); removeBoundary(i); }}
              style={{
                position: "absolute", top: 0, bottom: 0, left: b * page.width * scale - 6, width: 12,
                cursor: "col-resize", touchAction: "none", display: "flex", justifyContent: "center",
              }}>
              <div style={{ width: 2, height: "100%", background: "#7F77DD", opacity: .85 }} />
            </div>
          ))}
        </div>
      </div>

      {/* One selector per column, showing what it captured. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 8, marginTop: 10 }}>
        {Array.from({ length: nCols }).map((_, i) => (
          <div key={i} style={{ border: `1px solid ${ROLE_COLORS[roles[i] || "ignore"]}55`, borderRadius: 8, padding: 7, background: "var(--bg)" }}>
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              Col {i + 1}{sample && sample[i] ? ` · “${sample[i].slice(0, 18)}”` : ""}
            </div>
            <select value={roles[i] || "ignore"} onChange={e => setRole(i, e.target.value)} style={{ ...sel, borderColor: ROLE_COLORS[roles[i] || "ignore"] }}>
              {COLUMN_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
        ))}
      </div>

      {/* Amount interpretation. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
        <select value={template.amountMode} onChange={e => set({ amountMode: e.target.value })} style={{ ...sel, width: "auto" }}>
          <option value="signed">One Amount column</option>
          <option value="debitcredit">Separate Debit / Credit</option>
        </select>
        {template.amountMode === "signed" && (
          <select value={template.amountSign} onChange={e => set({ amountSign: e.target.value })} style={{ ...sel, width: "auto" }}>
            <option value="out_positive">+ = money out (charges)</option>
            <option value="in_positive">+ = money in (deposits)</option>
          </select>
        )}
        {roles.includes("date2") && (
          <select value={template.dateColumn || "date"} onChange={e => set({ dateColumn: e.target.value })} style={{ ...sel, width: "auto" }}>
            <option value="date">Use Date</option>
            <option value="date2">Use Date 2</option>
          </select>
        )}
        <button className="ibtn" style={{ fontSize: 11 }} onClick={() => setShowAdvanced(s => !s)}>
          {showAdvanced ? "Hide" : "More"} options
        </button>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: rowCount ? "#1D9E75" : "#D85A30" }}>
          {rowCount ?? 0} transaction{rowCount === 1 ? "" : "s"} found
        </span>
      </div>

      {showAdvanced && (
        <div style={{ marginTop: 10, background: "var(--bg)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
            Rows are found by shape — a row counts only when its Date column reads as a date and a money column reads
            as an amount — so this keeps working next month when the table moves. These anchors bound where to look.
          </div>
          <label style={{ fontSize: 11, color: "var(--muted)" }}>Start reading after a line containing
            <input value={template.startAnchor || ""} onChange={e => set({ startAnchor: e.target.value })}
              placeholder="e.g. Trans Date Post Date Description Amount" style={{ ...sel, marginTop: 4, fontSize: 12 }} />
          </label>
          <label style={{ fontSize: 11, color: "var(--muted)" }}>Stop at a line containing (optional)
            <input value={template.stopAnchor || ""} onChange={e => set({ stopAnchor: e.target.value })}
              placeholder="e.g. Important Messages" style={{ ...sel, marginTop: 4, fontSize: 12 }} />
          </label>
        </div>
      )}
    </div>
  );
}
