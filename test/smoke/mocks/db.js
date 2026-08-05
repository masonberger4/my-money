const store = new Map();

// The `dash:cats` registry the render check boots with. Seeded (outside
// post-wipe mode, which is meant to show an app with nothing taught yet) so the
// smoke run actually EXERCISES one level of nesting: "Everyday" is a parent of
// "Groceries" and "Dining out", both of which carry rows in the fixture. Without
// this the group rows on the Categories and Budget tabs would never render in
// the only automated check that evaluates Dashboard.jsx in a browser.
const POSTWIPE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('postwipe');
if (!POSTWIPE) {
  store.set('dash:cats', JSON.stringify([
    { id: '1', name: 'Everyday', color: '#7F77DD' },
    { id: '2', name: 'Groceries', color: '#1D9E75', parent: 'Everyday' },
    { id: '3', name: 'Dining out', color: '#D85A30', parent: 'Everyday' },
    { id: '4', name: 'Utilities', color: '#378ADD' },
  ]));
}

export async function getSetting(key) { return store.has(key) ? store.get(key) : null; }
export async function setSetting(key, value) { store.set(key, value); }
export async function getSettings() { return {}; }
export async function deleteSetting() {}
