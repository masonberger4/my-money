// Tests for the learned-merchant-rule core (src/txClassify.js).
//
// This path had NO coverage, which is how the "Always categorize X as Y" bug
// stayed invisible: every part of it looks reasonable read one line at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantKey, matchLearnedRule, guessCategory, isCardPaymentDescriptor, isCardPaymentReceived, isKeyPrefix } from '../src/txClassify.js';

// --- merchantKey: what collapses and what stays distinct --------------------

test('merchantKey drops store numbers so one rule covers every visit', () => {
  assert.equal(merchantKey('SAFEWAY #1234'), 'SAFEWAY');
  assert.equal(merchantKey('SAFEWAY 8892'), 'SAFEWAY');
  assert.equal(merchantKey('safeway #1234'), 'SAFEWAY');
});

test('merchantKey keeps COSTCO GAS and COSTCO WHSE distinct', () => {
  // The whole point of dropping ONLY digits: fuel and groceries at the same
  // brand are different categories.
  assert.notEqual(merchantKey('COSTCO GAS #0117'), merchantKey('COSTCO WHSE #0117'));
  assert.equal(merchantKey('COSTCO GAS #0117'), 'COSTCO GAS');
  assert.equal(merchantKey('COSTCO WHSE #0117'), 'COSTCO WHSE');
});

test('merchantKey is empty for a descriptor with nothing to key on', () => {
  assert.equal(merchantKey(''), '');
  assert.equal(merchantKey(null), '');
  assert.equal(merchantKey('#1234 5678'), '');
});

// --- matchLearnedRule ------------------------------------------------------

test('a learned rule matches the merchant it was taught from', () => {
  const rules = { 'COSTCO GAS': 'Vehicle expenses' };
  assert.equal(matchLearnedRule('COSTCO GAS', rules), 'Vehicle expenses');
  assert.equal(matchLearnedRule('COSTCO GAS #0117', rules), 'Vehicle expenses');
  assert.equal(matchLearnedRule('Costco Gas #1183', rules), 'Vehicle expenses');
});

test('a learned rule extends over trailing location tokens', () => {
  const rules = { 'COSTCO GAS': 'Vehicle expenses' };
  // Whole-token prefix, so the store's city/state doesn't break the match.
  assert.equal(matchLearnedRule('COSTCO GAS #0117 SEATTLE WA', rules), 'Vehicle expenses');
  assert.equal(matchLearnedRule('COSTCO GAS 0117 TUKWILA WA', rules), 'Vehicle expenses');
});

test('a learned rule does not leak to a different merchant sharing a first word', () => {
  const rules = { 'COSTCO GAS': 'Vehicle expenses' };
  assert.equal(matchLearnedRule('COSTCO WHSE #0117', rules), null);
  assert.equal(matchLearnedRule('COSTCO.COM', rules), null);
  // A partial token is not a prefix match — the boundary has to be a token.
  assert.equal(matchLearnedRule('COSTCO GASOLINE #0117', rules), null);
});

test('the longest matching rule wins over a shorter one', () => {
  const rules = { COSTCO: 'Groceries', 'COSTCO GAS': 'Vehicle expenses' };
  assert.equal(matchLearnedRule('COSTCO GAS #0117', rules), 'Vehicle expenses');
  assert.equal(matchLearnedRule('COSTCO WHSE #0117', rules), 'Groceries');
});

test('matchLearnedRule accepts a Map as well as a plain object', () => {
  const rules = new Map([['SAFEWAY', 'Groceries']]);
  assert.equal(matchLearnedRule('SAFEWAY #1234', rules), 'Groceries');
});

test('matchLearnedRule tolerates no rules and unkeyable descriptors', () => {
  assert.equal(matchLearnedRule('SAFEWAY', null), null);
  assert.equal(matchLearnedRule('', { SAFEWAY: 'Groceries' }), null);
});

test('a rule may point at a CUSTOM category, not just an ERA_CATEGORIES member', () => {
  // The Categories tab can create its own categories, and correcting a
  // transaction to one of them has to be learnable — nothing here may validate
  // the target against the built-in taxonomy.
  const rules = { 'COSTCO GAS': 'gas' };
  assert.equal(matchLearnedRule('COSTCO GAS #0117', rules), 'gas');
  assert.equal(guessCategory('COSTCO GAS #0117', { rules }), 'gas');
});

// --- REGRESSION: the rule a user can actually teach -------------------------

test('REGRESSION: a rule taught from a descriptor carrying a city is over-specific', () => {
  // The prefix runs rule→row, so a rule is only general if the descriptor it
  // was taught from was ALREADY the short form. Teach from a row whose
  // descriptor carries the city and the key inherits it, matching that store
  // only. Pinned because it is the difference between "always categorize this
  // merchant" working and silently applying to one row.
  const key = merchantKey('COSTCO GAS #0117 SEATTLE WA');
  assert.equal(key, 'COSTCO GAS SEATTLE WA');
  const rules = { [key]: 'gas' };
  assert.equal(matchLearnedRule('COSTCO GAS #0117 SEATTLE WA', rules), 'gas');
  assert.equal(matchLearnedRule('COSTCO GAS #0117 TUKWILA WA', rules), null);
  assert.equal(matchLearnedRule('COSTCO GAS #0117', rules), null);
});

test('NEW CONTRACT: nothing is guessed — an untaught merchant is Uncategorized', () => {
  // The descriptor→category keyword table is deleted (2026-08-04). COSTCO GAS
  // used to be guessed as 'Vehicle expenses' out of a taxonomy the household
  // never chose; now the only way it gets a category is being taught. Kept as
  // documentation of the reversal — this assertion IS the new model.
  assert.equal(guessCategory('COSTCO GAS #0117', {}), 'Uncategorized');
  assert.equal(guessCategory('STARBUCKS STORE 4471', {}), 'Uncategorized');
  assert.equal(guessCategory('NEWREZ SHELLPOINT MORTGAGE', {}), 'Uncategorized');
  assert.equal(guessCategory('NORDSTROM RACK #12', {}), 'Uncategorized');
});

test('learned rules categorize, but never beat the transfer guards', () => {
  assert.equal(guessCategory('COSTCO GAS #0117', { rules: { 'COSTCO GAS': 'gas' } }), 'gas');
  // …but a card payment stays a transfer whatever a rule says, because that
  // bucket is excluded from spending.
  const rules = { 'CAPITAL ONE AUTOPAY': 'gas' };
  assert.equal(
    guessCategory('CAPITAL ONE AUTOPAY', { rules }),
    'Transfers and card payments',
  );
});

// --- 2026-08-03 classifier gaps found live (double-count findings F2) --------

test('REGRESSION: the live BofA / Wells Fargo card-payment descriptors classify as card payments', () => {
  // Exact live descriptors that missed the guard: BANK OF AMERICA / WELLS
  // FARGO were absent from CARD_ISSUER_RE and BECU's unspaced CCPYMT from
  // STANDALONE_PAYMENT_RE, so $1,109.57 of card payments counted as purchases.
  assert.equal(
    guessCategory('External Withdrawal - BANK OF AMERICA - PAYMENT', {}),
    'Transfers and card payments'
  );
  assert.equal(
    guessCategory('External Withdrawal - WELLS FARGO CARD - CCPYMT', {}),
    'Transfers and card payments'
  );
  // The verdict the spending model's veto uses agrees.
  assert.equal(isCardPaymentDescriptor('External Withdrawal - BANK OF AMERICA - PAYMENT'), true);
  assert.equal(isCardPaymentDescriptor('External Withdrawal - WELLS FARGO CARD - CCPYMT'), true);
});

// --- Amount-scoped learned rules -------------------------------------------
//
// A rules bag value is EITHER a category string (the legacy any-amount shape)
// or an array of { amount, category }, where `amount: null` is that same
// any-amount rule. The motivating case is one merchant carrying two meanings
// that only the amount separates: a recurring Zelle for exactly $1,800.00 is
// rent, every other Zelle to the same person is a gift.

test('the Zelle case: one merchant, two meanings separated by the amount', () => {
  const rules = {
    'ZELLE TRANSFER': [
      { amount: null, category: 'Gifts' },
      { amount: 1800, category: 'Rent' },
    ],
  };
  assert.equal(matchLearnedRule('ZELLE TRANSFER', rules, 1800.0), 'Rent');
  assert.equal(matchLearnedRule('ZELLE TRANSFER', rules, 50), 'Gifts');
  // The amount alone teaches nothing — a different merchant is a different key.
  assert.equal(matchLearnedRule('VENMO PAYMENT', rules, 1800), null);
});

test('BACKWARD COMPATIBILITY: the legacy string shape behaves exactly as before', () => {
  // A loader that never learned about amounts keeps working unchanged: string
  // values are read as a single any-amount rule, so prefix matching and
  // longest-rule-wins are untouched, with or without an amount argument.
  const rules = { COSTCO: 'Groceries', 'COSTCO GAS': 'Vehicle expenses' };
  assert.equal(matchLearnedRule('COSTCO GAS #0117 SEATTLE WA', rules), 'Vehicle expenses');
  assert.equal(matchLearnedRule('COSTCO GAS #0117 SEATTLE WA', rules, 42.5), 'Vehicle expenses');
  assert.equal(matchLearnedRule('COSTCO WHSE #0117', rules, 42.5), 'Groceries');
  // GASOLINE is not a whole-token extension of the GAS rule, so it falls back
  // to the shorter COSTCO rule rather than inheriting the fuel category.
  assert.equal(matchLearnedRule('COSTCO GASOLINE #0117', rules, 42.5), 'Groceries');
  assert.equal(matchLearnedRule('COSTCO GASOLINE #0117', { 'COSTCO GAS': 'Vehicle expenses' }, 42.5), null);
});

test('BACKWARD COMPATIBILITY: a Map works, in both the legacy and the amount-scoped shape', () => {
  const legacy = new Map([['SAFEWAY', 'Groceries']]);
  assert.equal(matchLearnedRule('SAFEWAY #1234', legacy, 12.34), 'Groceries');
  const scoped = new Map([
    ['ZELLE TRANSFER', [{ amount: null, category: 'Gifts' }, { amount: 1800, category: 'Rent' }]],
  ]);
  assert.equal(matchLearnedRule('ZELLE TRANSFER TO SAM', scoped, 1800), 'Rent');
  assert.equal(matchLearnedRule('ZELLE TRANSFER TO SAM', scoped, 20), 'Gifts');
});

test('REGRESSION: an amount-scoped rule on a SHORT key beats an any-amount rule on a LONGER key', () => {
  // The documented precedence, and the reason it is not just "longest key
  // wins": an exact amount is a deliberate, narrow assertion about ONE
  // recurring payment, and it has to survive beside the generic rule for the
  // same merchant — which, being longer, would otherwise shadow it whenever
  // the descriptor happened to carry extra tokens.
  const rules = {
    ZELLE: [{ amount: 1800, category: 'Rent' }],
    'ZELLE TRANSFER TO SAM': 'Gifts',
  };
  assert.equal(matchLearnedRule('ZELLE TRANSFER TO SAM SMITH', rules, 1800), 'Rent');
  // Off the scoped amount, the longer any-amount rule is the only match left.
  assert.equal(matchLearnedRule('ZELLE TRANSFER TO SAM SMITH', rules, 25), 'Gifts');
});

test('key length only breaks ties WITHIN the amount-scoped tier', () => {
  const rules = {
    ZELLE: [{ amount: 1800, category: 'Wrong' }],
    'ZELLE TRANSFER': [{ amount: 1800, category: 'Rent' }],
  };
  assert.equal(matchLearnedRule('ZELLE TRANSFER TO SAM', rules, 1800), 'Rent');
});

test('amounts compare at CENT precision, and sub-cent noise never misses', () => {
  const rules = { ZELLE: [{ amount: 1800, category: 'Rent' }] };
  assert.equal(matchLearnedRule('ZELLE', rules, 1800.0), 'Rent');
  assert.equal(matchLearnedRule('ZELLE', rules, 1800.004), 'Rent');
  // One cent away is a different payment, not a rounding artifact.
  assert.equal(matchLearnedRule('ZELLE', rules, 1800.01), null);
  // No floating-point false negative: 0.1 + 0.2 is 0.30000000000000004 and
  // must still match a rule taught at 0.3.
  const pennies = { TEST: [{ amount: 0.3, category: 'Tiny' }] };
  assert.equal(matchLearnedRule('TEST', pennies, 0.1 + 0.2), 'Tiny');
});

test('sign is significant: a rule for +1800 does not match -1800', () => {
  // Amounts are the app convention (positive = money out), so the sign is the
  // difference between paying rent and being paid. A refund must never inherit
  // the payment's rule.
  const rules = { ZELLE: [{ amount: 1800, category: 'Rent' }] };
  assert.equal(matchLearnedRule('ZELLE', rules, -1800), null);
  const inbound = { ZELLE: [{ amount: -1800, category: 'Rent received' }] };
  assert.equal(matchLearnedRule('ZELLE', inbound, -1800), 'Rent received');
  assert.equal(matchLearnedRule('ZELLE', inbound, 1800), null);
});

test('omitting the amount means only any-amount rules can match', () => {
  // The honest behaviour for a caller that does not know the amount: an
  // amount-scoped rule asserts something about a specific amount, so with no
  // amount in hand there is nothing to assert.
  const rules = {
    ZELLE: [{ amount: 1800, category: 'Rent' }, { amount: null, category: 'Gifts' }],
  };
  assert.equal(matchLearnedRule('ZELLE', rules), 'Gifts');
  const scopedOnly = { ZELLE: [{ amount: 1800, category: 'Rent' }] };
  assert.equal(matchLearnedRule('ZELLE', scopedOnly), null);
  assert.equal(matchLearnedRule('ZELLE', scopedOnly, undefined), null);
  assert.equal(matchLearnedRule('ZELLE', scopedOnly, null), null);
});

test('guessCategory forwards the amount so an amount-scoped rule fires end to end', () => {
  const rules = {
    'ZELLE TRANSFER': [
      { amount: null, category: 'Gifts' },
      { amount: 1800, category: 'Rent' },
    ],
  };
  // NB: the descriptor deliberately avoids "TRANSFER TO/FROM" wording, which
  // the transfer guard would claim before any rule is consulted.
  assert.equal(guessCategory('ZELLE TRANSFER', { rules, amount: 1800 }), 'Rent');
  assert.equal(guessCategory('ZELLE TRANSFER', { rules, amount: 50 }), 'Gifts');
  assert.equal(guessCategory('ZELLE TRANSFER', { rules }), 'Gifts');
  assert.equal(guessCategory('ZELLE TRANSFER', { amount: 1800 }), 'Uncategorized');
});

test('an amount-scoped rule cannot punch through the transfer/card-payment guards', () => {
  // The load-bearing safety property, unchanged by amount scoping: those
  // guards protect the spending totals, and a rule that made a card payment
  // count as spending would be a footgun. Amount scoping gives a rule no new
  // authority — it only narrows when the rule applies.
  const rules = { 'CAPITAL ONE AUTOPAY': [{ amount: 1800, category: 'Rent' }] };
  assert.equal(
    guessCategory('CAPITAL ONE AUTOPAY', { rules, amount: 1800 }),
    'Transfers and card payments',
  );
  const wired = { 'ONLINE BANKING TRANSFER TO VISA': [{ amount: 500, category: 'Rent' }] };
  assert.equal(
    guessCategory('ONLINE BANKING TRANSFER TO VISA', { rules: wired, amount: 500 }),
    'Transfers and card payments',
  );
  // A card PURCHASE still skips the guards, so its amount-scoped rule applies:
  // the guard exemption and the rule tier are independent mechanisms.
  assert.equal(
    guessCategory('CAPITAL ONE TRAVEL PORTLAND', {
      rules: { 'CAPITAL ONE TRAVEL PORTLAND': [{ amount: 250, category: 'Travel' }] },
      accountType: 'credit',
      amount: 250,
    }),
    'Travel',
  );
});

test('degenerate rule bags and amounts never throw', () => {
  assert.equal(matchLearnedRule('ZELLE', null, 1800), null);
  assert.equal(matchLearnedRule('ZELLE', undefined, 1800), null);
  assert.equal(matchLearnedRule('', { ZELLE: [{ amount: 1800, category: 'Rent' }] }, 1800), null);
  assert.equal(matchLearnedRule(null, { ZELLE: 'Rent' }, 1800), null);
  // A malformed bag: null value, empty array, an entry with no category, and
  // an empty key are all skipped rather than crashing a sync mid-import.
  const messy = {
    ZELLE: null,
    SAFEWAY: [],
    COSTCO: [{ amount: 1800 }, { amount: null, category: 'Groceries' }],
    '': 'Nope',
  };
  assert.equal(matchLearnedRule('ZELLE', messy, 1800), null);
  assert.equal(matchLearnedRule('SAFEWAY', messy, 1800), null);
  assert.equal(matchLearnedRule('COSTCO WHSE', messy, 1800), 'Groceries');
  // Infinities and NaN are not an amount.
  const rules = { ZELLE: [{ amount: 1800, category: 'Rent' }] };
  assert.equal(matchLearnedRule('ZELLE', rules, NaN), null);
  assert.equal(matchLearnedRule('ZELLE', rules, Infinity), null);
});

test('a rule amount arriving as a numeric STRING still matches; a row amount as a string does not', () => {
  // PostgREST returns `numeric` columns as strings, so a rule loaded straight
  // from category_rules can carry amount: '1800.00'. The implementation coerces
  // the RULE side (`Number(e.amount)`) but NOT the row side — a caller passing a
  // string amount gets no scoped match. Pinned as the real behaviour: the row
  // amount is the app's own numeric convention and callers must pass a number.
  const rules = { ZELLE: [{ amount: '1800.00', category: 'Rent' }] };
  assert.equal(matchLearnedRule('ZELLE', rules, 1800), 'Rent');
  assert.equal(matchLearnedRule('ZELLE', rules, '1800'), null);
  // A rule amount that is not numeric at all is simply never matched.
  const junk = { ZELLE: [{ amount: 'abc', category: 'Rent' }] };
  assert.equal(matchLearnedRule('ZELLE', junk, 1800), null);
});

test('isCardPaymentDescriptor: transfer wording naming a card is a payment; plain transfers and purchases are not', () => {
  assert.equal(isCardPaymentDescriptor('ONLINE BANKING TRANSFER TO VISA'), true);
  assert.equal(isCardPaymentDescriptor('ONLINE BANKING TRANSFER TO SAVINGS'), false);
  // Issuer-named PURCHASES stay purchases — the co-occurrence guard holds.
  assert.equal(isCardPaymentDescriptor('CAPITAL ONE TRAVEL PORTLAND'), false);
  assert.equal(isCardPaymentDescriptor('DISCOVER TIRE AND AUTO CENTER'), false);
  // A Wells Fargo BANK deposit is not a card payment (issuer without payment wording).
  assert.equal(isCardPaymentDescriptor('WELLS FARGO DES:DEPOSIT'), false);
});

// ---------------------------------------------------------------------------
// The trim-the-key editor (the recorded honest fix for the over-specific-key
// limit): the learn confirm lets the user shorten the key to a leading
// whole-token prefix. These pins are the feature's contract — a trimmed key
// must actually generalize, and the guard must reject every shape that would
// mint a rule that LOOKS taught but matches nothing.
// ---------------------------------------------------------------------------

test('isKeyPrefix: leading whole-token prefixes only', () => {
  const full = 'COSTCO GAS SEATTLE WA';
  assert.equal(isKeyPrefix('COSTCO', full), true);
  assert.equal(isKeyPrefix('COSTCO GAS', full), true);
  assert.equal(isKeyPrefix(full, full), true);
  // A mid-key subset would never fire (matching is rule→row startsWith).
  assert.equal(isKeyPrefix('COSTCO SEATTLE', full), false);
  assert.equal(isKeyPrefix('GAS SEATTLE WA', full), false);
  // A partial token is not a prefix — the match must end at a token boundary.
  assert.equal(isKeyPrefix('COSTCO G', full), false);
  // Empty and non-string shapes are unteachable, never "valid".
  assert.equal(isKeyPrefix('', full), false);
  assert.equal(isKeyPrefix(null, full), false);
  assert.equal(isKeyPrefix('COSTCO', null), false);
  assert.equal(isKeyPrefix(undefined, undefined), false);
});

test('a trimmed key is teachable as-is and matches the long descriptors it came from', () => {
  // merchantKey is idempotent on its own output — that is what lets the
  // confirm pass the trimmed key straight through setCategoryRule with zero
  // adapter changes.
  assert.equal(merchantKey('COSTCO GAS'), 'COSTCO GAS');
  assert.equal(merchantKey(merchantKey('COSTCO GAS #0117 SEATTLE WA')), merchantKey('COSTCO GAS #0117 SEATTLE WA'));
  // The point of trimming: the short rule now covers every store of the chain…
  const rules = { 'COSTCO GAS': 'Transportation' };
  assert.equal(matchLearnedRule('COSTCO GAS #0117 SEATTLE WA', rules), 'Transportation');
  assert.equal(matchLearnedRule('COSTCO GAS #0552 TUKWILA WA', rules), 'Transportation');
  // …without swallowing the sibling merchant (the deliberate no-stemming rule).
  assert.equal(matchLearnedRule('COSTCO WHSE #0117 SEATTLE WA', rules), null);
});

// --- isCardPaymentReceived: the card-side veto, against REAL data -------------
//
// Refund netting (2026-08-17) turned credit-account money-in into something
// that MOVES a total, so the line between "refund" and "payment I sent" became
// load-bearing in a way it never was. These are the household's actual
// credit-account money-in descriptors, pulled from prod — the same discipline
// as the $1,109.57 BofA/Wells Fargo miss pinned by name in spending.test.js.
//
// The asymmetry to keep in mind when editing the regex: a MISSED payment
// subtracts four figures from a category and manufactures that much phantom
// envelope Available, while a false positive merely fails to net (today's
// behaviour). Conservative side up — but not so conservative that it eats
// merchant descriptors, which is exactly what happened below.

const REAL_CARD_PAYMENTS = [
  'CAPITAL ONE MOBILE PYMT',            // $26,238 across 10 rows — the big one
  'ELECTRONIC PAYMENT',
  'BA ELECTRONIC PAYMENT',
  'ONLINE/MOBILE PAYMENT CONF#M02191706971',
  'ONLINE ACH PAYMENT THANK YOU',
  'ONLINE/MOBILE PAYMENT CONF#18tdwqgat',
  'INTERNET PAYMENT - THANKYOU',
  'CAPITAL ONE AUTOPAY PYMT',
  // Wordings from Mason's statements that predate the feed (see pdfImport):
  'PAYMENT THANK YOU',
  'PAYMENT RECEIVED',
];

const REAL_CARD_REFUNDS = [
  'AMAZON MKTPLACE PMTS',               // the REGRESSION — see below
  'SEATTLE CC NORTH WEBSEATTLEWA',
  'SP EVERLANE',
  'WALMART.COMWALMART.COMAR',
  'TARGET STORE T3275',
  'LOWES #00004*SEATTLEWA',
  'IKEA 491768525888-434-4532MD',
  'SABAI DESIG',
  'ALASKA AIR 0272130549534SEATTLEWA TK#: 0272130549534 PSGR: BERGER/MASON',
  'COSTCO WHSE #0001',
  'GAP.COM                  800-427-7895 CA',
  'MICHAELS STORES 8403BELLEVUEWA',
  'Build-A-Bear 1330TukwilaWA',
  'TARGET PLUS',
  'JCPENNEY 0696TUKWILAWA',
  'QFC #5826BELLEVUEWA',
  'IBI*FABLETICS.COM844-3225384CA',
  'AMERICAN HEALTH TRAIN',
  'GAMESTOPGRAPEVINETX',
];

test('isCardPaymentReceived holds back every real card payment', () => {
  for (const d of REAL_CARD_PAYMENTS) {
    assert.equal(isCardPaymentReceived(d), true, `must be vetoed: ${d}`);
  }
  // …and note WHY this predicate exists at all: the payer-side test misses
  // almost all of them, because a card statement never prints its own issuer.
  const bare = ['PAYMENT THANK YOU', 'PAYMENT RECEIVED', 'ELECTRONIC PAYMENT', 'INTERNET PAYMENT - THANKYOU'];
  for (const d of bare) {
    assert.equal(isCardPaymentDescriptor(d), false, `isCardPaymentDescriptor cannot do this job: ${d}`);
  }
});

test('isCardPaymentReceived lets every real merchant refund through', () => {
  for (const d of REAL_CARD_REFUNDS) {
    assert.equal(isCardPaymentReceived(d), false, `must NOT be vetoed: ${d}`);
  }
});

test('REGRESSION: "AMAZON MKTPLACE PMTS" is a merchant, not a payment', () => {
  // The regex was a bare alternation with no word boundaries, so `PMT` matched
  // inside `PMTS` — Amazon's own descriptor — and 18 genuine marketplace
  // refunds ($836.09 of Mason's real history) were vetoed and silently failed
  // to net. The boundaries are what fix it, and `PMT` must stay SINGULAR:
  // adding the plural re-breaks this exact row.
  assert.equal(isCardPaymentReceived('AMAZON MKTPLACE PMTS'), false);
  assert.equal(isCardPaymentReceived('CAPITAL ONE MOBILE PYMT'), true, 'the singular forms still veto');
  assert.equal(isCardPaymentReceived('PMT'), true);
});
