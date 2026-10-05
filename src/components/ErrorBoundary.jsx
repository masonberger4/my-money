import { Component, Suspense, useEffect } from "react";
import { createPortal } from "react-dom";

// Backstop for anything unguarded that throws during render — without one a
// render throw blanks the whole PWA. Generalized from CsvImport's old
// ModalErrorBoundary: pass `fallback` for a scoped presentation (the import
// modal does), otherwise the full "Something broke" card with a reload button.
// The try/catch-during-render discipline everywhere else still applies — this
// is the net, not the plan. LazyModal (below) is the scoped form every lazy
// modal renders inside.
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err, info) { console.error(this.props.label || "render failed", err, info); }
  render() {
    if (this.state.failed) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{ minHeight: "50vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--text)" }}>
          <div className="card" style={{ maxWidth: 420, border: "1px solid var(--danger-border)", padding: 24 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: "var(--danger)" }}>Something broke</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text)", marginBottom: 14 }}>
              The screen hit an error while rendering. Your data is fine — reloading usually fixes it.
            </div>
            <button className="ibtn" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// LazyModal: the wrapper for a lazyWithReload() modal — Suspense plus a
// boundary SCOPED to the modal. When the chunk still can't load after the one
// automatic reload (offline with the chunk never cached), or the modal throws
// while rendering, this card replaces only the modal — without it the throw
// reached App's boundary and the whole Dashboard, nav included, became
// "Something broke".
// The modal's own inner ErrorBoundary (CsvImport) can't cover a failed load:
// it lives inside the chunk that never arrived.
//
// Portalled for the same reason the modals are: a fixed overlay rendered under
// a `.card` (EmptyState's AddAccount) is otherwise clipped to that card.
//
// It lives HERE, not in its own module, on purpose: as a separate file shared
// by the entry (Dashboard) and the lazy EmptyState chunk (AddAccount), it made
// Rolldown fold the runtime helpers into a new shared app chunk that
// vendor-react then imported — so vendor-react's hash followed app code and
// stopped being byte-stable across deploys. Measured, 2026-10-05.
function ModalLoadFailed({ onClose }) {
  // Escape closes it, like every other overlay — the modal's own Escape
  // handler lives in the chunk that failed to load. Nothing is in flight here,
  // so unlike CsvImport/SimpleFinConnect there is no busy gate.
  useEffect(() => {
    const h = e => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label="Couldn't open this" onClick={e => e.stopPropagation()} style={{ maxWidth: "92vw", color: "var(--text)" }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Couldn't open this</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--muted)", marginBottom: 14 }}>
          The app may have just updated, or you're offline. Your data is fine — reloading usually fixes it.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="ibtn" onClick={onClose}>Close</button>
          <button className="ibtn" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function LazyModal({ label, onClose, children }) {
  return (
    <ErrorBoundary label={label} fallback={<ModalLoadFailed onClose={onClose} />}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}
