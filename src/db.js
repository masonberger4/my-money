import Dexie from 'dexie';

export const db = new Dexie('MyMoney');

db.version(1).stores({
  institutions: '++id, name, accessToken, cursor, lastSync',
  accounts:
    'plaidAccountId, institutionId, name, officialName, type, subtype, currentBalance, availableBalance, mask, lastUpdated',
  transactions:
    'plaidTxId, accountId, date, amount, merchantName, name, plaidCategory, mappedCategory, pending',
  settings: 'key',
});

export async function getSetting(key) {
  const row = await db.settings.get(key);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}
