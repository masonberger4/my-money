// Tests for src/assistantModels.js — the shared client+server model
// allowlist and cost estimator. Deliberately concrete, module-level
// assertions: api/assistant.js imports THIS module, so "the allowlist matches
// what the server validates" would compare the list to itself. The source
// scan at the bottom pins the drift that actually matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ASSISTANT_MODELS,
  EFFORT_LEVELS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  estimateCostRange,
  formatCents,
} from '../src/assistantModels.js';
import { shapeAssistantReply } from '../api/assistant.js';

test('estimateCostRange: null for unknown ids, 0 < low ≤ high for every model × effort', () => {
  assert.equal(estimateCostRange('claude-nonexistent-9', 'medium'), null);
  for (const modelId of Object.keys(ASSISTANT_MODELS)) {
    for (const effort of EFFORT_LEVELS) {
      const r = estimateCostRange(modelId, effort);
      assert.ok(r && typeof r.low === 'number' && typeof r.high === 'number', `${modelId}/${effort}`);
      assert.ok(r.low > 0, `${modelId}/${effort}: low > 0`);
      assert.ok(r.low <= r.high, `${modelId}/${effort}: low ≤ high`);
    }
  }
});

test('effort-capable models: the high bound is monotone non-decreasing across EFFORT_LEVELS', () => {
  // Behaviorally pins the internal per-effort output table: a level missing
  // from it silently collapses to the 2500-token default, which would dent
  // the monotone sequence here.
  for (const [modelId, cfg] of Object.entries(ASSISTANT_MODELS)) {
    if (!cfg.effort) continue;
    let prev = 0;
    for (const effort of EFFORT_LEVELS) {
      const { high } = estimateCostRange(modelId, effort);
      assert.ok(high >= prev, `${modelId}: high(${effort})=${high} < previous ${prev}`);
      prev = high;
    }
  }
});

test('models without effort support cost the same at every effort level', () => {
  const flat = Object.entries(ASSISTANT_MODELS).filter(([, cfg]) => !cfg.effort);
  assert.ok(flat.length >= 1, 'fixture sanity: at least one effort-less model (Haiku)');
  for (const [modelId] of flat) {
    assert.deepEqual(estimateCostRange(modelId, 'low'), estimateCostRange(modelId, 'max'), modelId);
  }
});

test('DEFAULT_MODEL is allowlisted and DEFAULT_EFFORT is a member of EFFORT_LEVELS', () => {
  assert.ok(ASSISTANT_MODELS[DEFAULT_MODEL], 'DEFAULT_MODEL must be in the allowlist');
  assert.ok(EFFORT_LEVELS.includes(DEFAULT_EFFORT));
});

test('every allowlisted model carries the fields the server reads', () => {
  for (const [id, cfg] of Object.entries(ASSISTANT_MODELS)) {
    for (const key of ['label', 'thinking', 'effort', 'maxTokens', 'inPerM', 'outPerM']) {
      assert.ok(key in cfg, `${id} missing ${key}`);
    }
    assert.ok(cfg.maxTokens > 0);
  }
});

test('list prices are pinned as documentation (USD per million tokens, input/output)', () => {
  // A failure here means a price moved or a model changed: re-verify against
  // Anthropic's current pricing table before updating these numbers. They
  // feed the "~X–Y¢/question" chip and nothing else, but a stale price
  // quietly steers the household toward the wrong model.
  const prices = Object.fromEntries(
    Object.entries(ASSISTANT_MODELS).map(([id, m]) => [id, [m.inPerM, m.outPerM]])
  );
  assert.deepEqual(prices, {
    'claude-haiku-4-5': [1, 5],
    'claude-sonnet-5': [2, 10],
    'claude-opus-4-8': [5, 25],
  });
});

test('estimateCostRange: exact values for one model × effort (the formula, pinned)', () => {
  // low  = cached context (0.1×) + a short answer
  // high = context written to cache (1.25×) + the effort's output budget
  const r = estimateCostRange('claude-sonnet-5', 'medium');
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  assert.ok(close(r.low, (9000 * 2 * 0.1 + 400 * 10) / 1e6), `low ${r.low}`);
  assert.ok(close(r.high, (9000 * 2 * 1.25 + 2500 * 10) / 1e6), `high ${r.high}`); // 0.0475
});

test('formatCents renders sub-dime amounts with a decimal and larger ones whole', () => {
  assert.equal(formatCents(0.004), '0.4¢');
  assert.equal(formatCents(0.16), '16¢');
});

test('source scan: api/assistant.js takes its model list from src/assistantModels.js and declares no model ids of its own', () => {
  const src = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /from '\.\.\/src\/assistantModels\.js'/,
    'the server must import the shared allowlist'
  );
  for (const name of ['ASSISTANT_MODELS', 'EFFORT_LEVELS', 'DEFAULT_MODEL', 'DEFAULT_EFFORT']) {
    assert.ok(src.includes(name), `api/assistant.js should use ${name}`);
  }
  // No model-id literals: a fork of the list server-side is the drift this
  // file exists to prevent.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const ids = stripped.match(/claude-[a-z0-9.-]+/gi) || [];
  assert.deepEqual(ids, [], `model-id literals found in api/assistant.js: ${ids.join(', ')}`);
});

// --- server reply shaping (api/assistant.js) ----------------------------------
// Adaptive-thinking tokens count against max_tokens, so a thinking model at
// high effort can spend the whole budget before (or while) writing. A
// max_tokens stop must never reach the chat panel looking like a finished
// answer, nor as "try rephrasing" when the question was fine.

const usage = { input_tokens: 9000, output_tokens: 4096, cache_read_input_tokens: 0 };
const msg = (stop_reason, content) => ({ stop_reason, content, usage });
const thinking = { type: 'thinking', thinking: '', signature: 'sig' };

test('shapeAssistantReply: a max_tokens stop with partial text keeps the text, flags it, and says it was cut off', () => {
  const r = shapeAssistantReply(msg('max_tokens', [thinking, { type: 'text', text: 'You spent $412 on Dining out in July, up' }]), { effortCapable: true });
  assert.equal(r.truncated, true);
  assert.equal(r.stop_reason, 'max_tokens');
  assert.ok(r.reply.startsWith('You spent $412 on Dining out in July, up'), 'the partial answer is kept');
  assert.match(r.reply, /cut off/i, 'and visibly marked incomplete');
  assert.match(r.reply, /lower effort/, 'an effort-capable model is pointed at its effort setting');
  assert.deepEqual(r.usage, usage);
});

test('shapeAssistantReply: a max_tokens stop with NO text (thinking used the budget) says so — not "try rephrasing"', () => {
  const r = shapeAssistantReply(msg('max_tokens', [thinking]), { effortCapable: true });
  assert.equal(r.truncated, true);
  assert.doesNotMatch(r.reply, /rephras/i);
  assert.match(r.reply, /ran out of room/);
  assert.match(r.reply, /lower effort/);
});

test('shapeAssistantReply: a model without an effort setting is never told to lower it', () => {
  const r = shapeAssistantReply(msg('max_tokens', [{ type: 'text', text: 'Partial' }]), { effortCapable: false });
  assert.equal(r.truncated, true);
  assert.doesNotMatch(r.reply, /effort/);
  assert.match(r.reply, /narrower question/);
});

test('shapeAssistantReply: end_turn is unchanged — text joined and trimmed, generic fallback when empty, no truncated flag', () => {
  const ok = shapeAssistantReply(msg('end_turn', [thinking, { type: 'text', text: ' Hi ' }, { type: 'text', text: 'there' }]), { effortCapable: true });
  assert.equal(ok.reply, 'Hi \nthere');
  assert.equal(ok.stop_reason, 'end_turn');
  assert.ok(!('truncated' in ok));
  const empty = shapeAssistantReply(msg('end_turn', [thinking]));
  assert.equal(empty.reply, 'I had trouble producing an answer — try rephrasing.');
  assert.ok(!('truncated' in empty));
});

test('shapeAssistantReply: a refusal is unchanged', () => {
  assert.deepEqual(shapeAssistantReply(msg('refusal', [{ type: 'text', text: 'partial' }])), {
    reply: "I can't help with that request.",
    stop_reason: 'refusal',
  });
});
