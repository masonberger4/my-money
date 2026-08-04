import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeLabel, unhideConfirmMessage, TYPE_LABELS } from '../src/unhideConfirm.js';

test('typeLabel maps the three stored types', () => {
  assert.equal(typeLabel('credit'), 'Credit card');
  assert.equal(typeLabel('loan'), 'Loan');
  assert.equal(typeLabel('depository'), 'Bank account');
});

test('typeLabel refines depository by subtype', () => {
  assert.equal(typeLabel('depository', 'checking'), 'Checking account');
  assert.equal(typeLabel('depository', 'savings'), 'Savings account');
});

test('subtype never refines non-depository types', () => {
  // A credit account with a stray subtype must still read as a card.
  assert.equal(typeLabel('credit', 'checking'), 'Credit card');
});

test('unknown type falls back to the raw string, never a confident label', () => {
  assert.equal(typeLabel('brokerage'), 'brokerage');
  assert.equal(typeLabel(null), 'Unknown type');
  assert.equal(typeLabel(undefined, 'checking'), 'Unknown type');
});

test('confirm message surfaces the guessed type and the account label', () => {
  const msg = unhideConfirmMessage({ name: 'Venture X', mask: '4321', type: 'credit' });
  assert.match(msg, /^Unhide "Venture X ··4321" as Credit card\?/);
  assert.match(msg, /guessed from the account name/);
  assert.match(msg, /If Credit card is wrong/);
});

test('confirm message prefers the nickname and tolerates sparse rows', () => {
  const msg = unhideConfirmMessage({ nickname: 'Our card', type: 'credit' });
  assert.match(msg, /"Our card" as Credit card\?/);
  const bare = unhideConfirmMessage({});
  assert.match(bare, /"this account" as Unknown type\?/);
  assert.doesNotThrow(() => unhideConfirmMessage(null));
});

test('TYPE_LABELS covers exactly the stored account types', () => {
  assert.deepEqual(Object.keys(TYPE_LABELS).sort(), ['credit', 'depository', 'loan']);
});
