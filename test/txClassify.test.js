// Tests for the learned-merchant-rule core (src/txClassify.js).
//
// This path had NO coverage, which is how the "Always categorize X as Y" bug
// stayed invisible: every part of it looks reasonable read one line at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantKey, matchLearnedRule, guessCategory } from '../src/txClassify.js';

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

test('learned rules beat the keyword table but never the transfer guards', () => {
  // COSTCO GAS is in the keyword table as Vehicle expenses; a rule overrides it.
  assert.equal(guessCategory('COSTCO GAS #0117', {}), 'Vehicle expenses');
  assert.equal(guessCategory('COSTCO GAS #0117', { rules: { 'COSTCO GAS': 'gas' } }), 'gas');
  // …but a card payment stays a transfer whatever a rule says, because that
  // bucket is excluded from spending.
  const rules = { 'CAPITAL ONE AUTOPAY': 'gas' };
  assert.equal(
    guessCategory('CAPITAL ONE AUTOPAY', { rules }),
    'Transfers and card payments',
  );
});
