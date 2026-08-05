const store = new Map();
export async function getSetting(key) { return store.has(key) ? store.get(key) : null; }
export async function setSetting(key, value) { store.set(key, value); }
export async function getSettings() { return {}; }
export async function deleteSetting() {}
