// The bottom-navigation map (PR B of the YNAB redesign, 2026-08-15). Pure,
// zero imports. The Dashboard's ELEVEN internal `tab` state values are
// unchanged — every body gate, the month-picker clamp and the lazy-load
// effects keep working — and this module only decides how those values group
// under the FIVE bottom items. One source of truth: the smoke harness walks
// the same ids via data-mm-nav/data-mm-report hooks.

export const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: '🏠', tab: 'overview' },
  { id: 'plan', label: 'Plan', icon: '✉️', tab: 'budget' },
  { id: 'spending', label: 'Spending', icon: '💵', tab: 'transactions' },
  { id: 'accounts', label: 'Accounts', icon: '🏦', tab: 'accounts' },
  { id: 'reflect', label: 'Reflect', icon: '📊', tab: 'reflect' },
];

// The report screens the Reflect hub links to (each keeps its own tab value
// and body). Order = the hub's card order.
export const REFLECT_TABS = ['categories', 'trends', 'recurring', 'tax', 'ask'];

const NAV_BY_TAB = {
  overview: 'home',
  budget: 'plan',
  transactions: 'spending',
  accounts: 'accounts',
  debt: 'accounts', // the Accounts screen's second segment
  reflect: 'reflect',
};
for (const t of REFLECT_TABS) NAV_BY_TAB[t] = 'reflect';

// Which bottom item highlights for a given tab value. Unknown values land on
// Home rather than leaving the bar highlight-less (the degrade instinct).
export function navForTab(tab) {
  return NAV_BY_TAB[tab] || 'home';
}

const TITLES = {
  overview: 'Home',
  budget: 'Plan',
  transactions: 'Spending',
  accounts: 'Accounts',
  debt: 'Debt',
  reflect: 'Reflect',
  categories: 'Categories',
  trends: 'Trends',
  recurring: 'Recurring',
  tax: 'Tax',
  ask: 'Ask',
};

export function pageTitle(tab) {
  return TITLES[tab] || 'Home';
}

// ---------------------------------------------------------------------------
// TEMPORARY — DELIBERATE LINT ERROR. This PR is a test of the `static checks`
// merge gate and must NEVER be merged; it is closed as soon as the gate is
// confirmed to block. The reference below is a misspelled constant, the exact
// typo class that reaches production as a ReferenceError: `npm test` never
// executes this dead function and `vite build` does not resolve free
// identifiers, so both stay green. Only eslint's no-undef sees it.
export function gateProbe(tab) {
  return NAV_ITEMS_TPYO[tab] ?? null;
}
