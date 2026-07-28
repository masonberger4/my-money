// Shared keyword classifier: bank descriptor → app category (+ internal-transfer
// tagging). Pure JS, no React and no Supabase, so both the browser (CSV import)
// and the serverless sync (SimpleFIN) can import it.
//
// Why it exists as its own module: Plaid shipped a category with every
// transaction (src/categoryMap.js mapped it). SimpleFIN and raw bank CSVs do
// not — they give a descriptor string and nothing else — so those feeds derive
// `mapped_category` themselves, at WRITE time, from the same rule table. With
// Plaid retired this table is the ONLY categorizer the app has, which raised
// the bar for it considerably; see the four design notes below.
//
// Every rule target MUST be a valid ERA_CATEGORIES member; the table is
// validated at module load so a bad edit can never write an invalid
// mapped_category (dataAdapter reads it straight through as the effective
// category). Order matters — first match wins, most specific first.

import { ERA_CATEGORIES, UNCATEGORIZED } from './categoryMap.js';

export const TRANSFER_CATEGORY = 'Transfers and card payments';
// Unmatched merchants land in UNCATEGORIZED, NOT in a real category. The old
// fallback was "Shopping and gear", which made an unrecognised merchant
// indistinguishable from a confident answer and quietly inflated that bucket.
export const FALLBACK_CATEGORY = UNCATEGORIZED;

// ---------------------------------------------------------------------------
// Card payments vs. purchases.
//
// "Transfers and card payments" is EXCLUDED from spending, so anything that
// lands here vanishes from every total. That makes false positives here far
// more damaging than a mere mislabel: an issuer name alone used to be enough,
// so "Capital One Travel", "Discover Tire and Auto" and "Amex Travel" — real
// purchases — disappeared from the dashboard silently.
//
// Two independent guards now:
//   1. An issuer name must co-occur with PAYMENT-shaped wording.
//   2. A positive amount on a CREDIT account is a purchase by definition — a
//      card payment arrives as money IN — so the transfer rules are skipped
//      entirely for card charges, whatever the descriptor says.
// ---------------------------------------------------------------------------
const PAYMENT_WORD_RE = /\b(PAYMENT|PAYMENTS|PYMT|PMT|AUTOPAY|AUTO PAY|E-?PAY|E-?PAYMENT|BILL ?PAY|ONLINE PMT|\bACH\b)\b/i;

const CARD_ISSUER_RE = /\b(AMEX|AMERICAN EXPRESS|CHASE CARD|CHASE CREDIT|CAPITAL ONE|DISCOVER|CITI CARD|CITIBANK|SYNCHRONY|BARCLAY|COMENITY|CREDIT CRD)\b/i;

// Descriptors that are unambiguously a card payment on their own.
const STANDALONE_PAYMENT_RE = /\b(CARD PAYMENT|CARD PMT|CC PYMT|CREDIT CARD PAYMENT|CARDMEMBER SERV|CARDMEMBER PAYMENT|EPAYMENT)\b/i;

// Explicit "moved my own money" wording.
const TRANSFER_RE = /ONLINE BANKING TRANSFER|\bTRANSFER\s+(TO|FROM)\b/i;

// …but a CARD PAYMENT is NOT an internal deposit↔deposit transfer, even when
// the bank words it as one ("Online Banking Transfer To VISA" — BECU pays an
// own credit card this way). Washing must never remove a card payment: its
// checking leg is real cash out that cashSpending must count.
const CARD_PAYMENT_RE = /\b(VISA|MASTERCARD|MASTER CARD|AMEX|AMERICAN EXPRESS|DISCOVER|CREDIT CARD|CREDIT CRD|CARD PAYMENT|CARD PMT|CC PYMT|CARDMEMBER)\b/i;

// A charge on a credit card. Card payments and refunds arrive as money in
// (negative), so a positive amount here can only be a purchase.
function isCardPurchase(accountType, amount) {
  return accountType === 'credit' && typeof amount === 'number' && amount > 0;
}

function looksLikeCardPayment(descriptor) {
  if (STANDALONE_PAYMENT_RE.test(descriptor)) return true;
  return CARD_ISSUER_RE.test(descriptor) && PAYMENT_WORD_RE.test(descriptor);
}

// ---------------------------------------------------------------------------
// The rule table. Short tokens are deliberately context-bound: a bare \b76\b
// matched "Store 76" and "Apartment 76 Rent", \bMAX\b matched "MAX MUSCLE",
// \bBP\b matched "BP Consulting LLC" — confident wrong answers, which are worse
// than an honest Uncategorized because nothing prompts you to check them.
// ---------------------------------------------------------------------------
const RAW_RULES = [
  // Housing / mortgage — the taxonomy has no "Housing"; map to Utilities to
  // match how Plaid's RENT_AND_UTILITIES already resolved (rent → Utilities).
  [/NEWREZ|SHELLPOINT|\bMORTGAGE\b|LOANCARE|MR COOPER|WELLS FARGO HOME|RUSHMORE|SPS SELECT/i, 'Utilities'],
  // Income / benefits — money-in, excluded from spending; category is cosmetic.
  [/PAYROLL|DIRECT DEP|WA ST.*EMPLOY|EMPLOYMENT SECURITY|UNEMPLOYMENT|IRS TREAS|US TREASURY|SSA TREAS|TAX REF|INTEREST PAID|DIVIDEND/i, 'Cash, checks, and misc'],
  // Utilities & telecom. "CITY OF …" needs a utility word — it was claiming
  // "City of Kent Pool Pass".
  [/PUGET SOUND ENERGY|PUGET SOUND|\bPSE\b|SEATTLE CITY LIGHT|SNOHOMISH PUD|\bPUD\b|CITY OF [A-Z. ]*(LIGHT|WATER|SEWER|UTIL|POWER)|PUBLIC UTILIT|WATER DIST|SEWER|COMCAST|XFINITY|CENTURYLINK|CENTURY LINK|ZIPLY|VERIZON|T-?MOBILE|\bAT&?T\b|WAVE BROADBAND|WASTE MGMT|WASTE MANAGEMENT|REPUBLIC SERVICES/i, 'Utilities'],
  // Groceries — clear grocers only (Walmart/Target left to Shopping).
  [/SAFEWAY|FRED MEYER|\bQFC\b|COSTCO WHSE|COSTCO WHOLESALE|TRADER JOE|WHOLE FOODS|WINCO|ALBERTSONS|KROGER|\bPCC\b|METROPOLITAN MARKET|\bH ?MART\b|GROCERY|SAFEWY|\bMARKET\b/i, 'Groceries'],
  // Coffee & snacks.
  [/STARBUCKS|DUTCH BROS|\bCOFFEE\b|PEETS|CARIBOU COFFEE|\bCAFFE\b|ESPRESSO|\bBAKERY\b|ICE CREAM|BASKIN|MOLLY MOON|\bDONUT|\bCREAMERY\b/i, 'Coffee and snacks'],
  // Dining out & delivery.
  [/RESTAURANT|\bGRILL\b|PIZZA|\bTACO\b|SUSHI|\bCAFE\b|MCDONALD|CHIPOTLE|DOORDASH|UBER EATS|GRUBHUB|PANERA|SUBWAY|CHICK-?FIL-?A|DAIRY QUEEN|\bDQ\s*(GRILL|#|\d)|BURGER|\bTAVERN\b|\bBREWING\b|\bBREWERY\b|\bPUB\b|\bBAR ?&|\bDELI\b|\bDRIVE-?IN\b|\bEATERY\b|\bKITCHEN\b|\bBISTRO\b|\bTHAI\b|\bPHO\b|\bRAMEN\b/i, 'Dining out'],
  // Fuel / vehicle. 76 and BP need fuel context (mortgage rule above already
  // claimed SHELLPOINT, and \bSHELL\b can't match it anyway).
  [/CHEVRON|\bSHELL\b|\bARCO\b|\bUNION 76\b|\b76\s*(GAS|FUEL|STATION)\b|PHILLIPS 66|EXXON|\bFUEL\b|GAS STATION|GASOLINE|TEXACO|CONOCO|\bBP\s*#?\s*\d|\bBP (GAS|FUEL|OIL|STATION)\b|COSTCO GAS|FRED MEYER FUEL|LES SCHWAB|JIFFY LUBE|AUTO REPAIR|\bTIRE\b|AUTO PARTS|\bO'?REILLY\b|NAPA AUTO|CAR WASH|\bPARKING\b|\bTOLL\b|GOOD TO GO/i, 'Vehicle expenses'],
  // Ride share vs transit.
  [/\bUBER\b(?! EATS)|\bLYFT\b/i, 'Ride shares'],
  [/SOUND TRANSIT|\bORCA\b|KING COUNTY METRO|METRO TRANSIT|WA STATE FERR|WSDOT|\bAMTRAK\b|LINK LIGHT RAIL/i, 'Public transit'],
  // Travel & vacation — had NO rules at all, so the category was unreachable
  // and a vacation month showed nothing.
  [/AIRLINE|\bAIR LINES\b|ALASKA AIR|DELTA AIR|UNITED AIR|SOUTHWEST AIR|AMERICAN AIR|JETBLUE|SPIRIT AIR|FRONTIER AIR|\bAIRBNB\b|\bVRBO\b|EXPEDIA|BOOKING\.COM|HOTELS\.COM|PRICELINE|KAYAK|MARRIOTT|HILTON|\bHYATT\b|HOLIDAY INN|BEST WESTERN|\bMOTEL\b|\bHOTEL\b|\bRESORT\b|\bCRUISE\b|HERTZ|\bAVIS\b|ENTERPRISE RENT|RENTAL CAR|TSA PRE|GLOBAL ENTRY|TRAVEL/i, 'Travel and vacation'],
  // Healthcare & pharmacy.
  [/PHARMACY|WALGREENS|\bCVS\b|RITE AID|BARTELL|\bKAISER\b|CLINIC|HOSPITAL|MEDICAL|\bDENTAL\b|ORTHODON|\bOPTICAL\b|OPTOMETR|\bVISION\b|LABCORP|QUEST DIAG|SWEDISH|VIRGINIA MASON|\bURGENT CARE\b/i, 'Healthcare and pharmacy'],
  // Health & fitness (personal care) — also previously unreachable. Matches
  // Plaid's old PERSONAL_CARE → 'Health and fitness' mapping.
  [/\bGYM\b|FITNESS|ORANGETHEORY|CROSSFIT|\bYOGA\b|PILATES|PELOTON|BARBER|\bSALON\b|GREAT CLIPS|SUPERCUTS|SPORT CLIPS|\bSPA\b|MASSAGE|\bNAILS?\b|SEPHORA|\bULTA\b|HAIRCUT|\bTANNING\b|CHIROPRACT/i, 'Health and fitness'],
  // Entertainment & subscriptions. MAX only as HBO Max.
  [/NETFLIX|SPOTIFY|\bHULU\b|DISNEY ?\+|DISNEYPLUS|\bHBO ?MAX\b|\bMAX\.COM\b|YOUTUBE|APPLE\.COM\/BILL|PRIME VIDEO|AUDIBLE|PATREON|NINTENDO|PLAYSTATION|\bXBOX\b|\bSTEAM\b|PARAMOUNT\+|\bAMC\b|REGAL CINEMA|CINEMARK|\bTHEATRE\b|\bTHEATER\b|TICKETMASTER|\bSTUBHUB\b/i, 'Entertainment and subscriptions'],
  // Pets.
  [/\bCHEWY\b|PETCO|PETSMART|\bVCA\b|VETERINAR|\bVET\b|MUD BAY|\bPET ?SUPP|ANIMAL HOSPITAL|HUMANE SOCIET/i, 'Pets'],
  // Childcare — before Education so "PRESCHOOL" can't be read as schooling.
  [/DAYCARE|CHILDCARE|KINDERCARE|PRESCHOOL|BRIGHT HORIZONS|\bNANNY\b|CHILD CARE/i, 'Childcare'],
  // Education — previously unreachable.
  [/TUITION|UNIVERSITY|\bCOLLEGE\b|\bSCHOOL\b|COURSERA|UDEMY|\bEDX\b|KHAN ACADEM|CHEGG|TEXTBOOK|STUDENT LOAN|SCHOLARSHIP|\bTUTOR/i, 'Education'],
  // Home improvement retail.
  [/HOME DEPOT|LOWES|LOWE'?S|ACE HARDWARE|MCLENDON|DUNN LUMBER|\bLUMBER\b|\bHARDWARE\b|\bIKEA\b|\bPLUMBING\b|\bELECTRICIAN\b|\bLANDSCAP/i, 'Home maintenance and improvement'],
  // Side hustles & business — previously unreachable. Deliberately narrow:
  // these words appear in personal spending too.
  [/ETSY SELLER|SHOPIFY|SQUARESPACE|\bWIX\b|GODADDY|BUSINESS LICENSE|QUICKBOOKS|FRESHBOOKS|\bLLC FILING\b|SECRETARY OF STATE|ADOBE CREATIVE/i, 'Side hustles and business'],
  // Cash, checks & misc — previously unreachable, which is why ATM withdrawals
  // and Venmo were being counted as "Shopping and gear". P2P apps land here
  // deliberately: the underlying purpose is unknowable from the descriptor, but
  // it is at least countable and honestly labelled.
  [/\bATM\b|CASH WITHDRAWAL|\bWITHDRAWAL\b|\bCHECK\s*#|\bCHECK\b(?!ING)|\bCHK\b|\bVENMO\b|\bZELLE\b|CASH APP|\bUSPS\b|UPS STORE|\bFEDEX\b|POST OFFICE|\bDMV\b|DEPT OF LICENSING|\bNOTARY\b|\bDONATION\b|GOFUNDME|RED CROSS|\bCHARITY\b/i, 'Cash, checks, and misc'],
  // Shopping & gear — now an EXPLICIT rule rather than the silent fallback, so
  // "this is shopping" is a decision and not the absence of one.
  [/\bAMAZON\b|\bTARGET\b|WALMART|\bCOSTCO\b|\bREI\b|NORDSTROM|OLD NAVY|\bH ?& ?M\b|MARSHALLS|\bTJ ?MAXX\b|ROSS STORES|\bUNIQLO\b|\bZARA\b|\bNIKE\b|ADIDAS|\bETSY\b|\bEBAY\b|BEST BUY|\bAPPLE STORE\b|\bMACY'?S\b|KOHL'?S|\bWAYFAIR\b|BED BATH|\bMICHAELS\b|JOANN|BARNES ?& ?NOBLE|\bGOODWILL\b|VALUE VILLAGE/i, 'Shopping and gear'],
];

// Validate rule targets once, dropping (and warning about) any that aren't in
// the shared taxonomy so an invalid label can never reach the database.
const CATEGORY_RULES = RAW_RULES.filter(([, cat]) => {
  if (ERA_CATEGORIES.includes(cat)) return true;
  // eslint-disable-next-line no-console
  console.warn(`[txClassify] dropping rule with invalid category: ${cat}`);
  return false;
});

// ---------------------------------------------------------------------------
// Learned merchant rules (the `category_rules` table).
//
// The keyword table can't know that "Rudys Columbia City" is a barbershop. A
// correction teaches it once and every later import/sync agrees.
// ---------------------------------------------------------------------------

// Normalized merchant identity. Store numbers and reference digits are noise —
// "SAFEWAY #1234" and "SAFEWAY 8892" are the same merchant — but real words are
// not, so "COSTCO GAS" and "COSTCO WHSE" must stay distinct. Keeps every
// non-numeric token, drops the numeric ones.
export function merchantKey(descriptor) {
  return String(descriptor ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t && !/^\d+$/.test(t))
    .join(' ');
}

// rules: Map (or plain object) of merchantKey → category.
// Matches exactly, or on a whole-token prefix so a rule learned as "RUDYS"
// covers "RUDYS COLUMBIA CITY" without a rule on "COSTCO" swallowing
// "COSTCO GAS" — the prefix must end at a token boundary, and longer (more
// specific) rules win over shorter ones.
export function matchLearnedRule(descriptor, rules) {
  if (!rules) return null;
  const key = merchantKey(descriptor);
  if (!key) return null;
  const get = k => (rules instanceof Map ? rules.get(k) : rules[k]);

  const exact = get(key);
  if (exact) return exact;

  const keys = rules instanceof Map ? [...rules.keys()] : Object.keys(rules);
  let best = null;
  for (const rk of keys) {
    if (rk && key.startsWith(rk + ' ') && (!best || rk.length > best.length)) best = rk;
  }
  return best ? get(best) : null;
}

// opts: { accountType, amount, rules } — all optional. Without accountType and
// amount the transfer rules apply as before, which is right for CSV imports
// (always depository).
export function guessCategory(description, opts = {}) {
  const d = String(description ?? '');
  const { accountType, amount, rules } = opts;

  if (!isCardPurchase(accountType, amount)) {
    if (TRANSFER_RE.test(d)) return TRANSFER_CATEGORY;
    if (looksLikeCardPayment(d)) return TRANSFER_CATEGORY;
  }
  // Learned rules beat the keyword table — they are the household's own
  // knowledge, and they exist precisely because the table got it wrong. They do
  // NOT beat the transfer guards above: those protect spending totals, and a
  // rule that made card payments count as spending would be a footgun.
  const learned = matchLearnedRule(d, rules);
  if (learned) return learned;

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
//
// amount uses the app convention: positive = money out, negative = money in.
export function transferRawCategory(description, amount, accountType) {
  const d = String(description ?? '');
  // A charge on a card is never a leg of a deposit↔deposit transfer.
  if (isCardPurchase(accountType, amount)) return '';
  if (CARD_PAYMENT_RE.test(d)) return '';
  if (!TRANSFER_RE.test(d)) return '';
  if (amount > 0) return 'TRANSFER_OUT';
  if (amount < 0) return 'TRANSFER_IN';
  return '';
}

// One call for a feed that gives a descriptor and nothing else: the pair of
// category columns api/sync.js and the CSV importer both write. accountType is
// optional but should be passed whenever it is known — it is what stops a card
// purchase from being mistaken for a card payment and dropped from spending.
export function classifyDescription(description, amount, accountType, rules) {
  return {
    raw_category: transferRawCategory(description, amount, accountType),
    mapped_category: guessCategory(description, { accountType, amount, rules }),
  };
}
