import Anthropic from '@anthropic-ai/sdk';
import { requireUser } from './_lib/supabase.js';
import { buildSpendingContext } from './_lib/spendingContext.js';

const SYSTEM_PROMPT = `You are the household finance assistant inside "my-money", a private personal-finance dashboard used by one household. You see their real accounts and their last 90 days of transactions in the context below.

How to behave:
- Answer questions about their spending, balances, and habits using ONLY the data provided. If the data can't answer the question (older than 90 days, a merchant that isn't there), say so plainly instead of guessing.
- When you make a suggestion, tie it to specific numbers from their data ("you spent $412 on Dining out in July, up from $280 in June") rather than generic advice.
- Amounts: positive = money out, negative = money in. "Transfers and card payments" and "Return" categories are not real spending — never count them in spending totals.
- Be concise. Lead with the answer, then at most a few supporting numbers. This renders in a small chat panel on a phone.
- Use plain text — no markdown tables, no headers. Short paragraphs and simple "-" lists only.
- You cannot take actions (no moving money, no editing transactions). If asked, explain what the user can do in the app instead.`;

const MAX_TURNS = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'assistant_not_configured',
      message: 'Set ANTHROPIC_API_KEY in the server environment to enable the assistant.',
    });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Only accept plain user/assistant text turns from the client.
  const history = messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_TURNS)
    .map(m => ({ role: m.role, content: m.content }));
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'last message must be from the user' });
  }

  try {
    const context = await buildSpendingContext(user.householdId);
    const today = new Date().toISOString().slice(0, 10);

    const anthropic = new Anthropic();

    const response = await anthropic.messages.create({
      // Haiku 4.5: fast and cheap for household finance Q&A. It predates
      // adaptive thinking (a 4.6+ feature), so no `thinking` param — it would
      // 400. Bump back to an Opus/Sonnet model + adaptive thinking if answers
      // need more depth.
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        {
          type: 'text',
          text: `Today's date: ${today}\n\n# Household financial data\n\n${context}`,
          // Caches prompt + data together; identical across the turns of a
          // conversation, so follow-up questions read from cache.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: history,
    });

    if (response.stop_reason === 'refusal') {
      return res.status(200).json({
        reply: "I can't help with that request.",
        stop_reason: 'refusal',
      });
    }

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({
      reply: reply || 'I had trouble producing an answer — try rephrasing.',
      stop_reason: response.stop_reason,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'assistant_auth', message: 'Invalid ANTHROPIC_API_KEY.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'assistant_rate_limited', message: 'The assistant is rate-limited right now — try again in a minute.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('assistant API error', err.status, err.message);
      return res.status(502).json({ error: 'assistant_api', message: `Assistant error (${err.status}).` });
    }
    console.error('assistant error', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
