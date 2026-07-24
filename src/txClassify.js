// Shared keyword classifier: bank descriptor → app category (+ internal-transfer
// tagging). Pure JS, no React and no Supabase, so both the browser (CSV import)
// and the serverless sync (SimpleFIN) can import it.
//
// Why it exists as its own module: Plaid ships a category with every
// transaction (src/categoryMap.js maps it). SimpleFIN and raw bank CSVs do not
// — they give a descriptor string and nothing else — so those two feeds have to
// derive `mapped_category` themselves, at WRITE time, from the same rule table.
// It started life inside csvImport.js; SimpleFIN made it a second caller.
//
// Every rule target MUST be a valid ERA_CATEGORIES member; the table is
// validated at module load so a bad edit can never write an invalid
// mapped_category (dataAdapter reads it straight through as the effective
// category). Order matters — first match wins, most specific first.

import { ERA_CATEGORIES } from './categoryMap.js';

export const TRANSFER_CATEGORY = 'Transfers and card payments';
export const FALLBACK_CATEGORY = 'Shopping and gear';

const RAW_RULES = [
  // Internal transfers & card payments first — must never count as spending.
  [/ONLINE BANKING TRANSFER|\bTRANSFER\s+(TO|FROM)\b/i, TRANSFER_CATEGORY],
  [/\b(AMEX|AMERICAN EXPRESS|CHASE CARD|CHASE CREDIT|CAPITAL ONE|DISCOVER|CITI CARD|SYNCHRONY|BARCLAY|CARD PAYMENT|CREDIT CRD|CC PYMT|CARDMEMBER)\b/i, TRANSFER_CATEGORY],
  // Housing / mortgage — the taxonomy has no "Housing"; map to Utilities to
  // match how Plaid's RENT_AND_UTILITIES already resolves (rent → Utilities).
  [/NEWREZ|SHELLPOINT|\bMORTGAGE\b|LOANCARE|MR COOPER|WELLS FARGO HOME|RUSHMORE|SPS SELECT/i, 'Utilities'],
  // Income / benefits — money-in, excluded from spending; category is cosmetic.
  [/PAYROLL|DIRECT DEP|WA ST.*EMPLOY|EMPLOYMENT SECURITY|UNEMPLOYMENT|IRS TREAS|US TREASURY|SSA TREAS|TAX REF|INTEREST PAID|DIVIDEND/i, 'Cash, checks, and misc'],
  // Utilities & telecom.
  [/PUGET SOUND ENERGY|PUGET SOUND|\bPSE\b|SEATTLE CITY LIGHT|SNOHOMISH PUD|\bPUD\b|CITY OF |WATER DIST|SEWER|COMCAST|XFINITY|CENTURYLINK|CENTURY LINK|ZIPLY|VERIZON|T-?MOBILE|\bAT&?T\b|WAVE BROADBAND|WASTE MGMT|WASTE MANAGEMENT|REPUBLIC SERVICES/i, 'Utilities'],
  // Groceries — clear grocers only (Walmart/Target left to Shopping).
  [/SAFEWAY|FRED MEYER|\bQFC\b|COSTCO WHSE|COSTCO WHOLESALE|TRADER JOE|WHOLE FOODS|WINCO|ALBERTSONS|KROGER|\bPCC\b|METROPOLITAN MARKET|\bH ?MART\b|GROCERY|SAFEWY/i, 'Groceries'],
  // Coffee & snacks.
  [/STARBUCKS|DUTCH BROS|\bCOFFEE\b|PEETS|CARIBOU COFFEE/i, 'Coffee and snacks'],
  // Dining out & delivery.
  [/RESTAURANT|\bGRILL\b|PIZZA|\bTACO\b|SUSHI|\bCAFE\b|MCDONALD|CHIPOTLE|DOORDASH|UBER EATS|GRUBHUB|PANERA|SUBWAY|CHICK-?FIL-?A|DAIRY QUEEN|\bDQ\b|BURGER/i, 'Dining out'],
  // Fuel / vehicle (mortgage rule above already claimed SHELLPOINT).
  [/CHEVRON|\bSHELL\b|\bARCO\b|\b76\b|EXXON|\bFUEL\b|GAS STATION|GASOLINE|TEXACO|CONOCO|\bBP\b|COSTCO GAS|FRED MEYER FUEL|LES SCHWAB|JIFFY LUBE|AUTO REPAIR/i, 'Vehicle expenses'],
  // Ride share vs transit.
  [/\bUBER\b(?! EATS)|\bLYFT\b/i, 'Ride shares'],
  [/SOUND TRANSIT|\bORCA\b|KING COUNTY METRO|METRO TRANSIT|WA STATE FERR|WSDOT/i, 'Public transit'],
  // Healthcare & pharmacy.
  [/PHARMACY|WALGREENS|\bCVS\b|RITE AID|BARTELL|\bKAISER\b|CLINIC|HOSPITAL|MEDICAL|\bDENTAL\b|ORTHODON/i, 'Healthcare and pharmacy'],
  // Entertainment & subscriptions.
  [/NETFLIX|SPOTIFY|\bHULU\b|DISNEY ?\+|DISNEYPLUS|\bHBO\b|\bMAX\b|YOUTUBE|APPLE\.COM\/BILL|PRIME VIDEO|AUDIBLE|PATREON|NINTENDO|PLAYSTATION|\bXBOX\b|\bSTEAM\b|PARAMOUNT\+/i, 'Entertainment and subscriptions'],
  // Pets.
  [/\bCHEWY\b|PETCO|PETSMART|\bVCA\b|VETERINAR|\bVET\b/i, 'Pets'],
  // Childcare.
  [/DAYCARE|CHILDCARE|KINDERCARE|PRESCHOOL|BRIGHT HORIZONS/i, 'Childcare'],
  // Home improvement retail.
  [/HOME DEPOT|LOWES|LOWE'?S|ACE HARDWARE|MCLENDON/i, 'Home maintenance and improvement'],
];

// Validate rule targets once, dropping (and warning about) any that aren't in
// the shared taxonomy so an invalid label can never reach the database.
const CATEGORY_RULES = RAW_RULES.filter(([, cat]) => {
  if (ERA_CATEGORIES.includes(cat)) return true;
  // eslint-disable-next-line no-console
  console.warn(`[txClassify] dropping rule with invalid category: ${cat}`);
  return false;
});

export function guessCategory(description) {
  const d = String(description ?? '');
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(d)) return cat;
  }
  return FALLBACK_CATEGORY;
}

// Exposed for tests: assert no rule points at a category outside the taxonomy.
export function invalidRuleCategories() {
  return RAW_RULES.map(([, c]) => c).filter(c => !ERA_CATEGORIES.includes(c));
}

// Internal-transfer descriptors → raw_category so markInternalTransfers can
// pair the two legs. Conservative: only clear "transfer to/from" wording, so a
// genuine bill is never mislabeled as a washable transfer. An unmatched leg
// stays counted (income for an in-leg, spending for an out-leg) by design.
const TRANSFER_RE = /ONLINE BANKING TRANSFER|\bTRANSFER\s+(TO|FROM)\b/i;

// …but a CARD PAYMENT is NOT an internal deposit↔deposit transfer, even when
// the bank words it as one ("Online Banking Transfer To VISA" — BECU pays an
// own credit card this way). Washing must never remove a card payment: its
// checking leg is real cash out that cashSpending must count. So card-payment
// wording is left un-tagged (raw_category '') — it stays counted as spending,
// and still maps to 'Transfers and card payments' (excluded from purchase
// spending) via guessCategory.
const CARD_PAYMENT_RE = /\b(VISA|MASTERCARD|MASTER CARD|AMEX|AMERICAN EXPRESS|DISCOVER|CREDIT CARD|CREDIT CRD|CARD PAYMENT|CARD PMT|CC PYMT|CARDMEMBER)\b/i;

// amount uses the app convention: positive = money out, negative = money in.
export function transferRawCategory(description, amount) {
  const d = String(description ?? '');
  if (CARD_PAYMENT_RE.test(d)) return '';
  if (!TRANSFER_RE.test(d)) return '';
  if (amount > 0) return 'TRANSFER_OUT';
  if (amount < 0) return 'TRANSFER_IN';
  return '';
}

// One call for a feed that gives a descriptor and nothing else: the pair of
// category columns api/sync.js and the CSV importer both write.
export function classifyDescription(description, amount) {
  return {
    raw_category: transferRawCategory(description, amount),
    mapped_category: guessCategory(description),
  };
}
