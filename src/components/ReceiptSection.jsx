import { useEffect, useRef, useState } from "react";
import { getReceipts, addReceipt, deleteReceipt, getReceiptUrl } from "../dataAdapter.js";
import { compressReceipt } from "../receiptImage.js";

// Receipt photos inside the transaction detail sheet. Self-contained: owns its
// list + signed URLs (minted fresh per mount — never stored anywhere), talks
// to the adapter directly, and tells the parent only that "receipt state
// changed" (onChanged → invalidateTax) so the Tax tab's no-receipt nag stays
// honest. Deliberately NOT part of the saveTx optimistic-patch machinery:
// receipts aren't a transactions column, so no tx list ever renders them —
// the sheet is the single reader.
export default function ReceiptSection({ txId, onChanged }) {
  const [receipts, setReceipts] = useState(null); // null = loading
  const [urls, setUrls] = useState({});           // receipt id → signed URL
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [viewing, setViewing] = useState(null);   // receipt being shown full-size
  const fileRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const s = ++seq.current;
    setReceipts(null); setUrls({}); setErr(null); setViewing(null);
    getReceipts(txId)
      .then(async ({ receipts: rows }) => {
        if (s !== seq.current) return;
        setReceipts(rows);
        // Signed URLs mint sequentially-ish per row; failures render as a
        // grey tile rather than killing the section.
        for (const r of rows) {
          try {
            const u = await getReceiptUrl(r.storage_path);
            if (s === seq.current) setUrls(prev => ({ ...prev, [r.id]: u }));
          } catch (e) { console.error("receipt url failed", e); }
        }
      })
      .catch(e => {
        console.error("receipts load failed", e);
        if (s === seq.current) { setReceipts([]); setErr("Couldn't load receipts"); }
      });
  }, [txId]);

  async function onPick(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = ""; // same file re-pickable after a failure
    if (!file || busy) return;
    setBusy(true); setErr(null);
    try {
      const { blob, mime } = await compressReceipt(file);
      const row = await addReceipt(txId, blob, mime);
      setReceipts(prev => [...(prev || []), row]);
      try { setUrls(prev => ({ ...prev, [row.id]: URL.createObjectURL(blob) })); } catch {}
      onChanged?.();
    } catch (e) {
      console.error("receipt add failed", e);
      setErr(e?.message || "Couldn't save the receipt");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(r) {
    if (busy) return;
    if (!window.confirm("Delete this receipt photo? This can't be undone.")) return;
    setBusy(true); setErr(null);
    try {
      await deleteReceipt(r);
      setReceipts(prev => (prev || []).filter(x => x.id !== r.id));
      setViewing(null);
      onChanged?.();
    } catch (e) {
      console.error("receipt delete failed", e);
      setErr("Couldn't delete the receipt");
    } finally {
      setBusy(false);
    }
  }

  const tile = { width: 72, height: 72, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", objectFit: "cover", flexShrink: 0, cursor: "pointer" };

  return (
    <>
      <div style={{ borderTop: "1px solid var(--border)", margin: "12px 0" }} />
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Receipt</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {(receipts || []).map(r => (
          urls[r.id]
            ? <img key={r.id} src={urls[r.id]} alt="Receipt" style={tile} onClick={() => setViewing(r)} />
            : <div key={r.id} style={{ ...tile, cursor: "default" }} />
        ))}
        <button onClick={() => fileRef.current?.click()} disabled={busy || receipts === null}
          style={{ width: 72, height: 72, borderRadius: 8, border: "1px dashed var(--border)", background: "none",
            color: "var(--muted)", fontFamily: "inherit", fontSize: 11, cursor: "pointer", lineHeight: 1.3 }}>
          {busy ? "Saving…" : <>📷<br />Add</>}
        </button>
      </div>
      {/* capture="environment" opens the rear camera directly on iPhone; the
          picker still offers the photo library. image/heic deliberately NOT
          listed — see src/receiptImage.js. */}
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
        style={{ display: "none" }} onChange={onPick} />
      <div style={{ marginTop: 5, fontSize: 10, color: "var(--muted)", textAlign: "center" }}>
        Photos are kept with the transaction for tax records.
      </div>
      {err && <div style={{ marginTop: 6, fontSize: 11, color: "var(--danger)" }}>{err}</div>}

      {viewing && (
        <div onClick={() => setViewing(null)}
          style={{ position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 60,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <img src={urls[viewing.id]} alt="Receipt"
            style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 10, background: "#fff" }} />
          <button onClick={ev => { ev.stopPropagation(); onDelete(viewing); }} disabled={busy}
            style={{ marginTop: 12, padding: "8px 18px", borderRadius: 8, border: "1px solid var(--danger)",
              background: "none", color: "var(--danger)", fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Delete receipt
          </button>
        </div>
      )}
    </>
  );
}
