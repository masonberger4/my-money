import { useCallback, useEffect, useState } from "react";
import { claimSimpleFinToken, getSimpleFinStatus, disconnectSimpleFin } from "../plaidClient.js";
import { runSync } from "../sync.js";

// SimpleFIN connect — the Accounts-tab modal that replaces Plaid Link.
//
// There is no SDK and no popup: the user links their banks on SimpleFIN
// Bridge's own hosted page, copies the setup token it prints, and pastes it
// here. The server claims a durable access URL from that token and keeps it
// (api/simplefin-claim.js); the browser never receives it.
//
// While SimpleFIN runs ALONGSIDE Plaid, accounts arrive HIDDEN. A bank
// connected to both feeds would otherwise import every transaction twice and
// silently double every total, so nothing joins the dashboard until it has been
// compared and unhidden by hand. That is the whole point of this phase, and the
// copy below says so.

const BRIDGE_URL = "https://bridge.simplefin.org/";

function describeError(err, fallback) {
  const d = err?.detail;
  if (d?.message) return d.message;
  if (typeof d === "string" && d) return d;
  if (typeof d?.error === "string" && d.error) return `${fallback}: ${d.error}`;
  if (err?.status) return `${fallback} (HTTP ${err.status})`;
  return fallback;
}

function relative(iso) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function SimpleFinConnect({ onClose, onConnected }) {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null); // 'claiming' | 'syncing'
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getSimpleFinStatus());
    } catch (err) {
      console.error("simplefin status failed", err);
      setStatus({ connected: false, unavailable: true });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function connect() {
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    setStep("claiming");

    let claimed;
    try {
      claimed = await claimSimpleFinToken(value);
    } catch (err) {
      console.error("simplefin claim failed", err);
      setError(describeError(err, "Could not connect to SimpleFIN"));
      setStep(null);
      setBusy(false);
      return;
    }

    // Past this point the connection EXISTS and the setup token is spent, so a
    // failure here is never "could not connect" — saying so would send the user
    // back to Bridge for a second, redundant token. Pull immediately so
    // accounts land right away (`force` skips the once-an-hour throttle), but
    // treat a failed first pull as a note on a connection that succeeded.
    setStep("syncing");
    let warning = claimed.warning || null;
    try {
      await runSync({ force: true });
    } catch (err) {
      console.error("simplefin first sync failed", err);
      warning = describeError(err, "Connected, but the first sync didn't finish");
    }

    setToken("");
    setResult({ accounts: claimed.accounts, warning });
    await load();
    if (onConnected) onConnected();
    setStep(null);
    setBusy(false);
  }

  async function disconnect() {
    const ok = window.confirm(
      "Stop syncing from SimpleFIN?\n\nThe stored access URL is deleted, so no further data is pulled. " +
        "Accounts and transactions already imported stay in the app — remove them from the account screen if you want them gone.\n\n" +
        "Reconnecting means generating a new setup token in SimpleFIN Bridge."
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectSimpleFin();
      setResult(null);
      await load();
      if (onConnected) onConnected();
    } catch (err) {
      console.error("simplefin disconnect failed", err);
      setError(describeError(err, "Could not disconnect"));
    } finally {
      setBusy(false);
    }
  }

  const panelStyle = {
    background: "var(--card)", borderRadius: 16, border: "1px solid var(--border)",
    width: "92vw", maxWidth: 540, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden",
  };
  const sectionLabel = { fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 };
  const note = { fontSize: 11, color: "var(--muted)", lineHeight: 1.6 };

  const connected = !!status?.connected;

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div onClick={e => e.stopPropagation()} style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Connect banks with SimpleFIN</div>
          <button onClick={onClose} disabled={busy} className="nbtn" title="Close" style={{ opacity: busy ? .4 : 1 }}>×</button>
        </div>

        <div style={{ padding: "16px 20px", overflowY: "auto" }}>
          {status === null ? (
            <div style={{ ...note, padding: "20px 0", textAlign: "center" }}>Checking connection…</div>
          ) : (
            <>
              {status.migration_pending && (
                <div style={{ fontSize: 12, color: "#8A6A16", background: "#FDF4E0", border: "1px solid #E9CE8A", borderRadius: 8, padding: "10px 12px", marginBottom: 16, lineHeight: 1.5 }}>
                  The SimpleFIN tables aren't in the database yet. Run the
                  {" "}<code>20260724000001_simplefin.sql</code> migration in the Supabase SQL editor first.
                </div>
              )}

              {/* Current state */}
              <div style={{ marginBottom: 18 }}>
                <div style={sectionLabel}>Status</div>
                <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: connected ? "#1D9E75" : "var(--muted)", flexShrink: 0 }} />
                    {connected ? "Connected" : "Not connected"}
                  </div>
                  {connected && (
                    <div style={{ ...note, marginTop: 6 }}>
                      {status.institutions || 0} bank{status.institutions === 1 ? "" : "s"} ·{" "}
                      {status.accounts || 0} account{status.accounts === 1 ? "" : "s"}
                      {status.hidden_accounts > 0 && <> · {status.hidden_accounts} still hidden</>}
                      <br />
                      Last pull {relative(status.last_pulled_at)} · refreshes at most every{" "}
                      {status.min_pull_minutes || 60} min
                    </div>
                  )}
                  {status.last_error && (
                    <div style={{ fontSize: 11, color: "#A32D2D", marginTop: 8, lineHeight: 1.5 }}>
                      Last feed message: {status.last_error}
                    </div>
                  )}
                </div>
              </div>

              {result ? (
                <div style={{ textAlign: "center", padding: "6px 0 14px" }}>
                  <div style={{ fontSize: 34, marginBottom: 8 }}>✓</div>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
                    SimpleFIN connected
                  </div>
                  <div style={{ ...note, maxWidth: 380, margin: "0 auto" }}>
                    {result.accounts == null
                      ? <>Your banks are linked.</>
                      : <>The feed can see {result.accounts} account{result.accounts === 1 ? "" : "s"}.</>}
                    {" "}New accounts are added
                    <strong style={{ color: "var(--text)" }}> hidden</strong>, so they don't touch any totals yet.
                    <br /><br />
                    On the Accounts tab: open each one, check its <strong style={{ color: "var(--text)" }}>type</strong> is
                    right (SimpleFIN doesn't send one — it's guessed from the name, and the checking/savings split drives
                    Trends), compare its transactions against the Plaid copy, then unhide it.
                  </div>
                  {result.warning && (
                    <div style={{ fontSize: 11, color: "#8A6A16", background: "#FDF4E0", border: "1px solid #E9CE8A", borderRadius: 8, padding: "10px 12px", marginTop: 14, lineHeight: 1.5, textAlign: "left" }}>
                      {result.warning} — the connection is saved and retries on its own, so the
                      accounts will appear on the next sync.
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Step 1 */}
                  <div style={{ marginBottom: 18 }}>
                    <div style={sectionLabel}>1 · Link your banks at SimpleFIN</div>
                    <a href={BRIDGE_URL} target="_blank" rel="noreferrer noopener" className="ibtn"
                      style={{ fontSize: 13, textDecoration: "none", display: "inline-flex" }}>
                      Open SimpleFIN Bridge ↗
                    </a>
                    <div style={{ ...note, marginTop: 8 }}>
                      Sign in there, connect each bank, then press <strong style={{ color: "var(--text)" }}>Create Setup
                      Token</strong>. Bridge hands back one long string of letters and numbers.
                    </div>
                  </div>

                  {/* Step 2 */}
                  <div style={{ marginBottom: 18 }}>
                    <div style={sectionLabel}>
                      2 · Paste the setup token{connected ? " (adds another connection)" : ""}
                    </div>
                    <textarea
                      value={token}
                      onChange={e => setToken(e.target.value)}
                      placeholder="aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9zaW1wbGVmaW4vY2xhaW0v…"
                      rows={4}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      style={{
                        width: "100%", boxSizing: "border-box", resize: "vertical",
                        fontFamily: "'DM Mono',monospace", fontSize: 12, lineHeight: 1.5,
                        color: "var(--text)", background: "var(--bg)",
                        border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", outline: "none",
                      }}
                    />
                    <div style={{ ...note, marginTop: 8 }}>
                      A setup token works once. If it's already been used, create a fresh one in Bridge.
                      Already-linked banks keep working — you only need a new token to add more.
                    </div>
                  </div>

                  <div style={{ ...note, background: "var(--bg)", borderRadius: 8, padding: "10px 12px" }}>
                    New accounts arrive <strong style={{ color: "var(--text)" }}>hidden</strong> and change nothing until
                    you unhide them. That's deliberate: while a bank is connected to both Plaid and SimpleFIN, counting
                    both feeds would double its spending.
                  </div>
                </>
              )}

              {error && (
                <div style={{ fontSize: 12, color: "#A32D2D", background: "#FCEBEB", border: "1px solid #F09595", borderRadius: 8, padding: "10px 12px", marginTop: 12, lineHeight: 1.5 }}>
                  {error}
                </div>
              )}

              {connected && !result && (
                <button onClick={disconnect} disabled={busy}
                  style={{ marginTop: 16, width: "100%", padding: "8px 0", borderRadius: 8, border: "1px solid #F09595", background: "none", color: "#A32D2D", fontFamily: "inherit", fontSize: 12, fontWeight: 500, cursor: busy ? "default" : "pointer", opacity: busy ? .6 : 1 }}>
                  Stop syncing from SimpleFIN…
                </button>
              )}
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, padding: "14px 20px", borderTop: "1px solid var(--border)" }}>
          {result ? (
            <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "#7F77DD", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Done</button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy} className="ibtn" style={{ flex: 1, justifyContent: "center", opacity: busy ? .5 : 1 }}>Cancel</button>
              <button onClick={connect} disabled={busy || !token.trim()}
                style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: "none", background: "#7F77DD", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 500, cursor: busy || !token.trim() ? "default" : "pointer", opacity: busy || !token.trim() ? .5 : 1 }}>
                {step === "claiming" ? "Claiming…" : step === "syncing" ? "Fetching accounts…" : "Connect"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
