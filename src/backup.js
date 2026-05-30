import { db } from './db.js';

// Export / import of the entire local IndexedDB so one device (e.g. desktop)
// can mirror its data to another (e.g. phone) without a server.
//
// The export includes each institution's Plaid accessToken and cursor, so the
// importing device reuses the SAME Plaid Item — it does not create a second
// connection and does not consume another slot against the Plaid limit.
//
// SECURITY: the export file contains live Plaid access tokens. Treat it like a
// password — transfer it over a private channel (AirDrop, etc.) and delete it
// once imported. Don't email it or drop it in shared storage.

const EXPORT_APP = 'my-money';
const EXPORT_VERSION = 1;

export async function exportData() {
  const [institutions, accounts, transactions, settings] = await Promise.all([
    db.institutions.toArray(),
    db.accounts.toArray(),
    db.transactions.toArray(),
    db.settings.toArray(),
  ]);
  return {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: { institutions, accounts, transactions, settings },
  };
}

export function downloadExport(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `my-money-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Replaces local data with the contents of an export payload. Institution ids
// are preserved so accounts/transactions keep their foreign-key links.
export async function importData(payload) {
  if (!payload || payload.app !== EXPORT_APP) {
    throw new Error('Not a my-money backup file.');
  }
  const d = payload.data || {};
  await db.transaction(
    'rw',
    db.institutions,
    db.accounts,
    db.transactions,
    db.settings,
    async () => {
      await Promise.all([
        db.institutions.clear(),
        db.accounts.clear(),
        db.transactions.clear(),
        db.settings.clear(),
      ]);
      if (d.institutions?.length) await db.institutions.bulkPut(d.institutions);
      if (d.accounts?.length) await db.accounts.bulkPut(d.accounts);
      if (d.transactions?.length) await db.transactions.bulkPut(d.transactions);
      if (d.settings?.length) await db.settings.bulkPut(d.settings);
    }
  );
}
