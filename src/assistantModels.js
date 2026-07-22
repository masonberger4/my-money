// Assistant model options + a rough per-question cost estimate. Shared by the
// Ask-tab settings UI (client) and api/assistant.js (server, which validates
// the chosen model/effort against this list). Prices are USD per million
// tokens at list price (Sonnet 5 has lower intro pricing through 2026-08-31,
// so its real cost runs a bit under these estimates).
//
// Capability notes: Haiku 4.5 predates adaptive thinking and the effort
// parameter, so it runs with neither (sending them would 400). Sonnet 5 and
// Opus 4.8 support adaptive thinking + effort (low → max).
export const ASSISTANT_MODELS = {
  'claude-haiku-4-5': {
    label: 'Haiku 4.5', blurb: 'Fastest & cheapest',
    thinking: false, effort: false, maxTokens: 1024, inPerM: 1, outPerM: 5,
  },
  'claude-sonnet-5': {
    label: 'Sonnet 5', blurb: 'Balanced',
    thinking: true, effort: true, maxTokens: 4096, inPerM: 3, outPerM: 15,
  },
  'claude-opus-4-8': {
    label: 'Opus 4.8', blurb: 'Most capable',
    thinking: true, effort: true, maxTokens: 4096, inPerM: 5, outPerM: 25,
  },
};

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export const DEFAULT_EFFORT = 'medium';

// Rough token assumptions. The ~90-day context block dominates input and is
// prompt-cached, so a first question pays a cache-write premium (~1.25×) while
// follow-ups in the same chat read it cheaply (~0.1×). Higher effort spends
// more of the output budget on hidden thinking tokens (billed as output).
const CONTEXT_TOKENS = 9000;
const SHORT_ANSWER_TOKENS = 400;
const EFFORT_OUT = { low: 1500, medium: 2500, high: 4096, xhigh: 4096, max: 4096 };

// Returns { low, high } dollars per question — bottom = a follow-up on cached
// context with a short answer; top = the first question of a chat (context
// written to cache) with a full answer, capped by the model's max output.
export function estimateCostRange(modelId, effort) {
  const m = ASSISTANT_MODELS[modelId];
  if (!m) return null;
  const inTok = CONTEXT_TOKENS;
  const low = (inTok * m.inPerM * 0.1 + SHORT_ANSWER_TOKENS * m.outPerM) / 1e6;
  const outHi = Math.min(m.effort ? EFFORT_OUT[effort] || 2500 : 1200, m.maxTokens);
  const high = (inTok * m.inPerM * 1.25 + outHi * m.outPerM) / 1e6;
  return { low, high };
}

// "0.4¢" / "16¢" — friendlier than "$0.004" for sub-dollar amounts.
export function formatCents(dollars) {
  const c = dollars * 100;
  return c < 10 ? `${c.toFixed(1)}¢` : `${Math.round(c)}¢`;
}
