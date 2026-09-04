#!/usr/bin/env node
// Where did a session's tokens go? Usage:
//   node .claude/hooks/session-tokens.mjs ~/.claude/projects/<project>/<session>.jsonl [subagents/*.jsonl ...]
//
// Reads Claude Code transcript files (one JSON object per line) and prints,
// per file: turns and token usage per model (input, cache read, cache
// creation, output), the total bytes of tool results that entered the
// context, and the ten largest tool results with the tool and what it was
// asked (file path / command / pattern). This is the executable form of the
// docs/claude-routing.md ledger's "measure a real session" note — the numbers
// to tune the guards against, instead of hand-grepping a 1 MB transcript
// inside a session (which costs more than it measures).
//
// The transcript shape is not a documented contract; every field is read
// defensively and a line that does not parse is skipped. Zero dependencies.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node .claude/hooks/session-tokens.mjs <transcript.jsonl> [more ...]');
  process.exit(2);
}

const fmt = n => Math.round(n).toLocaleString('en-US');
const brief = input => {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.command ?? input.pattern ?? input.description ?? input.prompt ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 72);
};

for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { console.log(`== ${file}: ${e.message}`); continue; }
  const byModel = new Map();
  const uses = new Map();
  const results = [];
  let turns = 0;
  for (const line of text.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d?.message;
    if (!m || typeof m !== 'object') continue;
    const content = Array.isArray(m.content) ? m.content : [];
    if (d.type === 'assistant') {
      turns++;
      const u = m.usage ?? {};
      const key = m.model ?? '?';
      const t = byModel.get(key) ?? { turns: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
      t.turns++;
      t.input += u.input_tokens ?? 0;
      t.cacheRead += u.cache_read_input_tokens ?? 0;
      t.cacheCreate += u.cache_creation_input_tokens ?? 0;
      t.output += u.output_tokens ?? 0;
      byModel.set(key, t);
      for (const c of content) if (c?.type === 'tool_use') uses.set(c.id, c);
    } else if (d.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
        const use = uses.get(c.tool_use_id);
        results.push({ bytes: Buffer.byteLength(body), name: use?.name ?? '?', what: brief(use?.input) });
      }
    }
  }
  const resultBytes = results.reduce((n, r) => n + r.bytes, 0);
  console.log(`== ${file}: ${turns} assistant turns, ${results.length} tool results (${fmt(resultBytes / 1024)} KB, ~${fmt(resultBytes / 4000)}k tokens) ==`);
  if (!byModel.size) { console.log('(no assistant usage found — is this a transcript?)'); continue; }
  console.log('model | turns | input | cache read | cache create | output');
  for (const [model, t] of byModel) {
    console.log(`${model} | ${t.turns} | ${fmt(t.input)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheCreate)} | ${fmt(t.output)}`);
  }
  console.log('largest tool results:');
  for (const r of results.sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
    console.log(`  ${fmt(r.bytes / 1024).padStart(6)} KB  ${r.name}  ${r.what}`);
  }
}
