// Transfer/card-payment guards + learned-rule matching: bank descriptor → app
// category. Pure JS, no React and no Supabase, so both the browser (CSV import)
// and the serverless sync (SimpleFIN) can import it.
//
// **The descriptor→category keyword table is GONE (Mason, 2026-08-04).** The app
// ships no categories at all: the user creates every category and TEACHES which
// merchants belong to it, and `category_rules` (matched here by
// `matchLearnedRule`) makes it automatic thereafter. Nothing is guessed —
// an untaught merchant is Uncategorized, honestly and visibly. That kills the
// NEWREZ→"Utilities" class of confidently-wrong guesses at the root: the old
// table had to invent a bucket for every merchant out of a taxonomy the
// household never chose.
//
// What SURVIVES here is not taste, it is MECHANISM: the transfer and
// card-payment guards. "Transfers and card payments" is excluded from spending,
// so a false positive there deletes money from every total silently — those
// regexes are pinned by REGRESSION tests and must never be deleted alongside a
// classifier cleanup.

// One definition of each constant, in categoryMap. Untaught merchants land in
// FALLBACK_CATEGORY, which IS UNCATEGORIZED — a real category as the fallback
// made an unrecognised merchant indistinguishable from a confident answer.
import { TRANSFER_CATEGORY, FALLBACK_CATEGORY } from './categoryMap.js';

export { TRANSFER_CATEGORY, FALLBACK_CATEGORY };

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

// BANK OF AMERICA / WELLS FARGO added 2026-08-03: live BECU descriptors
// ("External Withdrawal - BANK OF AMERICA - PAYMENT", "External Withdrawal -
// WELLS FARGO CARD - CCPYMT") missed the guard and $1,109.57 of card payments
// counted as purchases over one quarter (double-count findings F2).
const CARD_ISSUER_RE = /\b(AMEX|AMERICAN EXPRESS|CHASE CARD|CHASE CREDIT|CAPITAL ONE|DISCOVER|CITI CARD|CITIBANK|SYNCHRONY|BARCLAY|COMENITY|CREDIT CRD|BANK OF AMERICA|WELLS FARGO)\b/i;

// Descriptors that are unambiguously a card payment on their own.
// CCPYMT (unspaced — BECU's wording) added 2026-08-03, same finding as above.
const STANDALONE_PAYMENT_RE = /\b(CARD PAYMENT|CARD PMT|CC ?PYMT|CREDIT CARD PAYMENT|CARDMEMBER SERV|CARDMEMBER PAYMENT|EPAYMENT)\b/i;

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

// The ONE category-shaped veto the linked-boundary spending model keeps
// (Mason, 2026-08-03): a card payment never counts as spending, even when its
// card is unlinked so structural pairing cannot wash it. Everything else that
// used to hide behind "Transfers and card payments" — plain transfer wording —
// now counts as spending when it crosses the linked boundary unpaired; only
// this verdict removes an unpaired row from the totals. Covers the
// issuer+payment co-occurrence, the standalone payment wordings, and BECU's
// "Online Banking Transfer To VISA" shape (transfer wording naming a card).
export function isCardPaymentDescriptor(descriptor) {
  const d = String(descriptor ?? '');
  if (looksLikeCardPayment(d)) return true;
  return TRANSFER_RE.test(d) && CARD_PAYMENT_RE.test(d);
}

// Money IN on a credit account that is NOT a merchant refund — the guard that
// had to exist before refunds could net (Mason, 2026-08-17).
//
// Why the issuer requirement above is dropped here, and why that is safe: on
// the PAYER's statement, "payment" alone is ambiguous (a utility bill payment
// is real spending), so an issuer name has to co-occur. On the CARD's own
// statement the ambiguity runs the other way — an issuer never prints its own
// name, so the real wordings are bare: "PAYMENT THANK YOU", "PAYMENT RECEIVED",
// "ELECTRONIC PAYMENT" (all three transcribed from Mason's own Capital One /
// Discover statements — see test/pdfImport.test.js). Every one of them fails
// isCardPaymentDescriptor. Meanwhile a genuine refund carries the MERCHANT's
// name ("REI CO-OP", "AMAZON.COM"), never payment-or-reward wording. The sign
// and the account type have already done the disambiguating before this runs,
// which is what makes the looser test correct rather than reckless — CALL IT
// ONLY FOR CREDIT-ACCOUNT NEGATIVES.
//
// Failure direction is deliberate: an unrecognised wording FAILS TO NET, which
// is exactly today's behaviour, while a missed veto would subtract a
// four-figure card payment from a category. Conservative side up.
const CARD_CREDIT_NON_REFUND_RE = new RegExp(
  [
    // Payments received from the cardholder.
    'PAYMENT', 'PYMT', 'PYMNT', 'PMT', 'AUTOPAY', 'AUTO ?PAY', 'DIRECTPAY', 'BILL ?PAY',
    // Rewards and issuer-side credits — money in, but not a purchase reversal.
    'CASH ?BACK', 'CASHBACK', 'REWARD', 'REDEMPTION', 'REDEEM', 'STATEMENT CREDIT',
    'BALANCE TRANSFER', 'INTEREST REFUND', 'FEE REFUND', 'FEE REVERSAL', 'CREDIT ADJUSTMENT',
  ].join('|'),
  'i'
);

export function isCardPaymentReceived(descriptor) {
  return CARD_CREDIT_NON_REFUND_RE.test(String(descriptor ?? ''));
}

// ---------------------------------------------------------------------------
// Learned merchant rules (the `category_rules` table).
//
// Since the keyword table's deletion these are the app's ONLY categorizer: a
// correction teaches a merchant once and every later import/sync agrees.
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

// The trim-the-key editor's guard (the recorded honest fix for the
// over-specific-key limit — see CLAUDE.md's amount-scoped Convention): the
// learn confirm lets the user SHORTEN the key they are about to teach, but
// only to a leading whole-token prefix. Matching runs rule→row on
// `key.startsWith(rk + ' ')` below, so a mid-key subset ("COSTCO SEATTLE")
// would never fire on anything, a partial token ("COSTCO G") would fire on
// nothing either, and an empty key is unteachable — every shape this guard
// rejects is a rule that LOOKS taught and matches nothing, the
// confidently-wrong failure in its quietest form.
export function isKeyPrefix(shortKey, fullKey) {
  if (typeof shortKey !== 'string' || typeof fullKey !== 'string') return false;
  if (!shortKey) return false;
  return shortKey === fullKey || fullKey.startsWith(shortKey + ' ');
}

// Amounts are compared at CENT precision — the stored rule amount came off a
// real transaction and the row being classified is another real transaction,
// so anything looser would start merging neighbouring payments.
function sameAmount(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.round(a * 100) === Math.round(b * 100);
}

// A rules bag maps merchantKey → EITHER a category string (the any-amount
// rule, and the only shape that existed before amount scoping) OR an array of
// { amount, category } entries, where `amount: null` is that same any-amount
// rule. Both shapes are read here so no caller has to normalize, and a loader
// that never learned about amounts keeps working unchanged.
function entriesFor(value) {
  if (value == null) return [];
  if (typeof value === 'string') return [{ amount: null, category: value }];
  if (Array.isArray(value)) return value.filter(e => e && e.category);
  return [];
}

// rules: Map (or plain object) — see entriesFor for the accepted shapes.
// `amount` is the row's amount in the app convention (positive = money out);
// omit it and only any-amount rules can match, which is the honest behaviour
// for a caller that doesn't know the amount.
//
// Matches exactly, or on a whole-token prefix so a rule learned as "RUDYS"
// covers "RUDYS COLUMBIA CITY" without a rule on "COSTCO" swallowing
// "COSTCO GAS" — the prefix must end at a token boundary, and longer (more
// specific) rules win over shorter ones.
//
// PRECEDENCE, pinned by test: an amount-scoped rule beats EVERY any-amount
// rule, even one with a longer key; length only breaks ties within a tier.
// An exact amount is a deliberate, narrow assertion about one recurring
// payment ("Zelle Transfer for $1,800.00 is rent") and the whole point is that
// it survives beside the generic rule for the same merchant — which, being the
// same key or a shorter one, would otherwise shadow it half the time depending
// on how the descriptor happened to be worded.
export function matchLearnedRule(descriptor, rules, amount) {
  if (!rules) return null;
  const key = merchantKey(descriptor);
  if (!key) return null;
  const get = k => (rules instanceof Map ? rules.get(k) : rules[k]);
  const keys = rules instanceof Map ? [...rules.keys()] : Object.keys(rules);

  let best = null; // { tier, len, category }
  for (const rk of keys) {
    if (!rk) continue;
    if (rk !== key && !key.startsWith(rk + ' ')) continue;
    for (const e of entriesFor(get(rk))) {
      const scoped = e.amount != null;
      if (scoped && !sameAmount(Number(e.amount), amount)) continue;
      const tier = scoped ? 1 : 0;
      if (!best || tier > best.tier || (tier === best.tier && rk.length > best.len)) {
        best = { tier, len: rk.length, category: e.category };
      }
    }
  }
  return best ? best.category : null;
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
  // Learned rules are the household's own knowledge and the ONLY categorizer
  // left. They do NOT beat the transfer guards above: those protect spending
  // totals, and a rule that made card payments count as spending would be a
  // footgun.
  const learned = matchLearnedRule(d, rules, amount);
  if (learned) return learned;

  // No guess. An untaught merchant is Uncategorized — visible and countable,
  // never a confident wrong answer (see the module header).
  return FALLBACK_CATEGORY;
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
