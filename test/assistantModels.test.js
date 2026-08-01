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
