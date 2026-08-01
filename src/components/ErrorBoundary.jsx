import { Component } from "react";

// Backstop for anything unguarded that throws during render — without one a
// render throw blanks the whole PWA. Generalized from CsvImport's old
// ModalErrorBoundary: pass `fallback` for a scoped presentation (the import
// modal does), otherwise the full "Something broke" card with a reload button.
// The try/catch-during-render discipline everywhere else still applies — this
// is the net, not the plan.
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
