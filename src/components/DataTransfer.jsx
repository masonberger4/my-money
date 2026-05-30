import { useRef, useState } from 'react';
import { exportData, downloadExport, importData } from '../backup.js';

// Exports the whole local cache to a JSON file. Use on the device that has the
// data (e.g. desktop) to produce a file you can move to another device.
export function ExportButton({ label = '⤓ Export data' }) {
  const [busy, setBusy] = useState(false);

  const handleExport = async () => {
    setBusy(true);
    try {
      const payload = await exportData();
      downloadExport(payload);
    } catch (err) {
      console.error('export failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="ibtn" onClick={handleExport} disabled={busy}>
      {busy ? 'Exporting…' : label}
    </button>
  );
}

// Imports a backup file, replacing local data. Use on a fresh device (e.g.
// phone) to mirror another device. The imported access token reuses the same
// Plaid connection, so no extra connection slot is consumed.
export function ImportButton({ label = '⤒ Import data', onImported }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleFile = async e => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const payload = JSON.parse(await file.text());
      await importData(payload);
      if (onImported) onImported();
    } catch (err) {
      console.error('import failed', err);
      setError(err.message || 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="ibtn"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title={error || ''}
      >
        {busy ? 'Importing…' : error ? 'Import failed — retry' : label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleFile}
        style={{ display: 'none' }}
      />
    </>
  );
}
