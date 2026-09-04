// The `.claude/` token-usage setup, kept honest the way claudeMdLockstep keeps
// the memory docs honest: a hook that silently stopped firing, a helper that
// silently stopped matching, a routing table that drifted from the agent
// frontmatter it restates, or an agent body that quietly grew back to a page
// would each cost tokens on every session with no alarm anywhere.
//
// What is pinned, and why each pin is cheap enough to keep:
//  (1) settings.json parses, and every hook it wires exists and is what it
//      claims: node scripts parse, sh scripts are `#!/bin/sh` + executable,
//      all LF — a CRLF shebang fails to exec on Linux CI with an error that
//      reads like a missing interpreter. The guard wiring itself is pinned
//      (test guard on `npm *` and `node --test*`, read guard on Read AND
//      `cat *`), because the `if:` filters are the one part a piped test
//      cannot exercise.
//  (2) The always-loaded footprint, in LINES and BYTES (tokens track bytes;
//      a line cap alone is gameable by longer lines): every agent/skill
//      description (loaded into EVERY session's system prompt as the routing
//      table) stays short; agent, rule, and skill BODIES stay within a page;
//      every agent carries a maxTurns backstop and a report-length cap.
//      CLAUDE.md's own 100-line cap lives in claudeMdLockstep — not restated.
//  (3) docs/claude-routing.md's routing table restates each agent's model /
//      effort / maxTurns; the table and the frontmatter must agree EXACTLY
//      (the noPlaid lesson: a restated fact with no lockstep is a lie in
//      waiting). Every backticked repo path in .claude/**/*.md must exist —
//      the phantom-reference guard, extended to the prompts, which the
//      lockstep test's corpus does not cover.
//  (4) The hooks do what the routing doc says, exercised by piping the same
//      JSON Claude Code pipes in: the test guard REWRITES a bare `npm test`
//      / `node --test` to the digest pipe and stays silent on piped or
//      targeted forms; the read guard DENIES a whole-file Read/cat of a file
//      over the line OR byte threshold (Dashboard.jsx by lines, the 62-line
//      key-files.md by bytes) and stays silent on a ranged Read, a piped cat,
//      conventions.md, an image; the outline helper maps Dashboard.jsx to a
//      few hundred lines and key-files.md to its rows; the token report
//      reads a fixture transcript.
//  (5) The digest keeps a failing block VERBATIM and never hides a run that
//      died before its TAP summary (the "never truncate a broken run" rule).
//
// The guards run on node (always present here). The outline and the digest
// need `sh`; where it is missing (a bare Windows shell) those cases skip
// rather than fail — CI is Linux, so nothing skips there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => join(root, p);
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const shSkip = hasSh ? false : 'needs sh (the helper is a shell script)';

// Pipe hook-shaped JSON at a node hook the way Claude Code does; return the
// parsed JSON output, or null when the hook stayed silent (= allow, untouched).
function runHook(script, input) {
  const r = spawnSync(process.execPath, [rel(script)], { cwd: root, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, `${script} exited ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}
const decision = j => j?.hookSpecificOutput?.permissionDecision ?? null;
const sh = (script, args, opts = {}) => spawnSync('sh', [rel(script), ...args], { cwd: root, encoding: 'utf8', ...opts });

const mdFiles = dir => readdirSync(rel(dir)).filter(f => f.endsWith('.md')).map(f => `${dir}/${f}`);
const frontmatter = text => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, 'no frontmatter block');
  const fields = Object.fromEntries(
    m[1].split('\n').map(l => l.match(/^([A-Za-z-]+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2]])
  );
  return { fields, body: m[2] };
};
const lineCount = text => text.trimEnd().split('\n').length;
const bytes = text => Buffer.byteLength(text, 'utf8');

const agentFiles = mdFiles('.claude/agents');
const skillFiles = readdirSync(rel('.claude/skills')).map(d => `.claude/skills/${d}/SKILL.md`).filter(f => existsSync(rel(f)));
const ruleFiles = mdFiles('.claude/rules');

// --- (1) settings.json wires real hooks, and the wiring is the documented one --

const settings = JSON.parse(readFileSync(rel('.claude/settings.json'), 'utf8'));
const pre = settings.hooks?.PreToolUse ?? [];
const entries = pre.flatMap(e => (e.hooks ?? []).map(h => ({ matcher: e.matcher, if: h.if ?? null, command: h.command })));
const scriptOf = cmd => cmd.replace(/^node /, '');

test('settings.json wires the guards as documented; every hook and helper script is real and LF', () => {
  assert.ok(entries.length >= 3, `only ${entries.length} PreToolUse hooks wired — did the hooks block go missing?`);
  const wiring = entries.map(e => `${e.matcher} ${e.if ?? '*'} → ${scriptOf(e.command)}`).sort();
  assert.deepEqual(wiring, [
    'Bash Bash(cat *) → .claude/hooks/pretooluse-read-guard.mjs',
    'Bash Bash(node --test*) → .claude/hooks/pretooluse-test-guard.mjs',
    'Bash Bash(npm *) → .claude/hooks/pretooluse-test-guard.mjs',
    'Read * → .claude/hooks/pretooluse-read-guard.mjs',
  ]);
  const scripts = [...new Set([...entries.map(e => scriptOf(e.command)), '.claude/hooks/test-digest.sh', '.claude/hooks/outline.sh', '.claude/hooks/session-tokens.mjs'])];
  for (const s of scripts) {
    assert.ok(existsSync(rel(s)), `${s} is wired or documented but does not exist`);
    const text = readFileSync(rel(s), 'utf8');
    assert.ok(!text.includes('\r'), `${s} has CRLF line endings`);
    if (s.endsWith('.mjs')) {
      assert.ok(text.startsWith('#!/usr/bin/env node\n'), `${s} must start with #!/usr/bin/env node`);
      const r = spawnSync(process.execPath, ['--check', rel(s)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${s} does not parse: ${r.stderr}`);
    } else {
      assert.ok(text.startsWith('#!/bin/sh\n'), `${s} must start with #!/bin/sh`);
    }
    if (process.platform !== 'win32') assert.ok(statSync(rel(s)).mode & 0o111, `${s} is not executable (chmod +x, and git add the mode)`);
  }
});

// --- (2) the always-loaded footprint -----------------------------------------

const AGENT_BODY_MAX = 70;     // lines — a page; the routing table says what, the memory docs say why
const RULE_MAX = 40;           // lines — pointers + hard invariants, never restatements
const SKILL_MAX = 45;          // lines
const DESCRIPTION_MAX = 320;   // chars, per description
const DESCRIPTIONS_TOTAL = 3500; // chars, all agent + skill descriptions together
const CLAUDE_MD_BYTES = 7000;  // the always-loaded index (~1.7k tokens); ~15% over 2026-09-04
const CLAUDE_MD_LINE = 200;    // chars — the 100-line cap is gameable by width otherwise
const REPORT_CAP = /at most \d+ lines|under \d+\s*lines|exact edit text/;

test('CLAUDE.md stays a small index in bytes as well as lines', () => {
  const text = readFileSync(rel('CLAUDE.md'), 'utf8');
  assert.ok(bytes(text) <= CLAUDE_MD_BYTES, `CLAUDE.md is ${bytes(text)} bytes (cap ${CLAUDE_MD_BYTES}) — move content into docs/memory/`);
  const wide = text.split('\n').filter(l => l.length > CLAUDE_MD_LINE);
  assert.deepEqual(wide, [], `CLAUDE.md lines over ${CLAUDE_MD_LINE} chars:\n${wide.join('\n')}`);
});

test('every agent: name/description/model, short description, numeric maxTurns, a report cap, a bounded body', () => {
  assert.ok(agentFiles.length >= 7, `only ${agentFiles.length} agents found — the routing table has 7`);
  for (const f of agentFiles) {
    const { fields, body } = frontmatter(readFileSync(rel(f), 'utf8'));
    for (const k of ['name', 'description', 'model']) assert.ok(fields[k], `${f} lacks frontmatter ${k}`);
    assert.ok(fields.description.length <= DESCRIPTION_MAX, `${f} description is ${fields.description.length} chars (cap ${DESCRIPTION_MAX})`);
    assert.ok(/^\d+$/.test(fields.maxTurns ?? ''), `${f} lacks a numeric maxTurns (the runaway backstop)`);
    assert.match(body, REPORT_CAP, `${f} body has no report-length cap ("at most N lines" / "under N lines" / "exact edit text")`);
    assert.ok(lineCount(body) <= AGENT_BODY_MAX, `${f} body is ${lineCount(body)} lines (cap ${AGENT_BODY_MAX}) — the rules belong in docs/memory, the agent points at them`);
  }
});

test('every rule is path-scoped and bounded; every skill has a short description and a bounded body; descriptions total stays small', () => {
  assert.ok(ruleFiles.length >= 5, `only ${ruleFiles.length} rules found`);
  for (const f of ruleFiles) {
    const text = readFileSync(rel(f), 'utf8');
    assert.ok(/^---\npaths:\n(\s+- .+\n)+---\n/.test(text), `${f} lacks a paths: frontmatter list`);
    assert.ok(lineCount(text) <= RULE_MAX, `${f} is ${lineCount(text)} lines (cap ${RULE_MAX})`);
  }
  assert.ok(skillFiles.length >= 6, `only ${skillFiles.length} skills found`);
  let total = 0;
  for (const f of [...agentFiles, ...skillFiles]) {
    const text = readFileSync(rel(f), 'utf8');
    const { fields } = frontmatter(text);
    assert.ok(fields.name && fields.description, `${f} lacks name/description`);
    assert.ok(fields.description.length <= DESCRIPTION_MAX, `${f} description is ${fields.description.length} chars (cap ${DESCRIPTION_MAX})`);
    total += fields.description.length;
    if (f.includes('/skills/')) assert.ok(lineCount(text) <= SKILL_MAX, `${f} is ${lineCount(text)} lines (cap ${SKILL_MAX})`);
  }
  assert.ok(total <= DESCRIPTIONS_TOTAL, `agent + skill descriptions total ${total} chars (cap ${DESCRIPTIONS_TOTAL}) — every one rides in every session's prompt`);
});

// --- (3) docs ↔ config lockstep -----------------------------------------------

const routingDoc = readFileSync(rel('docs/claude-routing.md'), 'utf8');
const ROW = /^\| ([A-Za-z-]+)(?: \([^)]*\))? \| (haiku|sonnet|opus) \| ([a-z]+) \| (\d+) \|/gm;
const tableRows = text => [...text.matchAll(ROW)].map(m => ({ name: m[1], model: m[2], effort: m[3], maxTurns: m[4] }));

test('the routing table in docs/claude-routing.md matches every agent frontmatter exactly', () => {
  const rows = tableRows(routingDoc);
  assert.equal(rows.length, agentFiles.length, `routing table has ${rows.length} parsable rows but there are ${agentFiles.length} agents — a row was dropped, or the table format changed`);
  for (const row of rows) {
    const f = `.claude/agents/${row.name.toLowerCase()}.md`;
    assert.ok(existsSync(rel(f)), `routing table names "${row.name}" but ${f} does not exist`);
    const { fields } = frontmatter(readFileSync(rel(f), 'utf8'));
    assert.equal(fields.name, row.name, `${f}: frontmatter name vs table`);
    assert.equal(fields.model, row.model, `${f}: frontmatter model "${fields.model}" vs table "${row.model}"`);
    assert.equal(fields.effort, row.effort, `${f}: frontmatter effort "${fields.effort}" vs table "${row.effort}"`);
    assert.equal(fields.maxTurns, row.maxTurns, `${f}: frontmatter maxTurns ${fields.maxTurns} vs table ${row.maxTurns}`);
  }
  // Injection self-check: a mutated copy with a wrong effort must be caught.
  const mutated = routingDoc.replace(/\| haiku \| low \| 30 \|/, '| haiku | max | 30 |');
  assert.notEqual(mutated, routingDoc, 'self-check anchor row not found');
  const bad = tableRows(mutated).find(r => r.effort === 'max');
  assert.ok(bad && frontmatter(readFileSync(rel(`.claude/agents/${bad.name.toLowerCase()}.md`), 'utf8')).fields.effort !== 'max');
});

test('every backticked repo path in .claude/**/*.md exists (the phantom guard, extended to the prompts)', () => {
  const PATH = /^(?![/~])[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/; // relative, at least one slash, no globs
  const EXT = /\.(js|mjs|jsx|sh|md|json|sql|yml|css|html)$|\/$/;
  const seen = new Map();
  for (const f of [...agentFiles, ...skillFiles, ...ruleFiles]) {
    for (const [, tok] of readFileSync(rel(f), 'utf8').matchAll(/`([^`\n]+)`/g)) {
      if (PATH.test(tok) && EXT.test(tok)) seen.set(tok, f);
    }
  }
  assert.ok(seen.size >= 15, `only ${seen.size} path tokens extracted from .claude/**/*.md — extraction broke?`);
  const missing = [...seen].filter(([tok]) => !existsSync(rel(tok))).map(([tok, f]) => `${tok} (in ${f})`);
  assert.deepEqual(missing, [], `.claude prompts name paths that do not exist:\n${missing.join('\n')}`);
});

// --- (4) the hooks do what the routing doc says --------------------------------

const TEST_GUARD = '.claude/hooks/pretooluse-test-guard.mjs';
const READ_GUARD = '.claude/hooks/pretooluse-read-guard.mjs';
const BIG = 'src/components/Dashboard.jsx';
const WIDE = 'docs/memory/key-files.md';
const bash = command => ({ tool_name: 'Bash', cwd: root, tool_input: { command, description: 'x' } });
const read = tool_input => ({ tool_name: 'Read', cwd: root, tool_input });

test('test guard: bare `npm test` / `node --test` are REWRITTEN to the digest pipe, everything else passes', () => {
  const j = runHook(TEST_GUARD, bash('npm test'));
  assert.equal(decision(j), 'allow');
  assert.equal(j.hookSpecificOutput.updatedInput.command, 'npm test 2>&1 | .claude/hooks/test-digest.sh');
  assert.equal(j.hookSpecificOutput.updatedInput.description, 'x', 'updatedInput replaces the whole object — the description must survive');
  assert.match(j.hookSpecificOutput.additionalContext ?? '', /test-digest/);
  assert.equal(runHook(TEST_GUARD, bash('  npm   run test -- ')).hookSpecificOutput.updatedInput.command, 'npm run test -- 2>&1 | .claude/hooks/test-digest.sh');
  assert.equal(runHook(TEST_GUARD, bash('node --test')).hookSpecificOutput.updatedInput.command, 'node --test 2>&1 | .claude/hooks/test-digest.sh');
  for (const ok of ['npm test 2>&1 | .claude/hooks/test-digest.sh', 'node --test test/spending.test.js', 'npm ci', 'npm test -- test/x.test.js', 'npm run build']) {
    assert.equal(runHook(TEST_GUARD, bash(ok)), null, `guard touched: ${ok}`);
  }
  const r = spawnSync(process.execPath, [rel(TEST_GUARD)], { cwd: root, input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '');
});

test('read guard: whole-file Read/cat over the line OR byte threshold is denied with the outline pointer; ranged, piped, small, binary pass', () => {
  assert.ok(lineCount(readFileSync(rel(BIG), 'utf8')) > 1000, `${BIG} is no longer over the line threshold — pick another big file`);
  assert.ok(statSync(rel(WIDE)).size > 64 * 1024 && lineCount(readFileSync(rel(WIDE), 'utf8')) < 1000, `${WIDE} no longer exercises the byte threshold alone`);
  const denied = runHook(READ_GUARD, read({ file_path: rel(BIG) }));
  assert.equal(decision(denied), 'deny');
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /outline\.sh src\/components\/Dashboard\.jsx/, 'the deny must point at the outline helper with a POSIX repo-relative path');
  assert.match(reason, /offset\+limit/);
  assert.match(reason, /\d,\d{3} lines/, 'the deny must state the real line count');
  assert.match(reason, /limit:\d+/, 'the deny must say how to do a deliberate whole read');
  const wide = runHook(READ_GUARD, read({ file_path: rel(WIDE) }));
  assert.equal(decision(wide), 'deny', 'key-files.md (62 lines, 80+ KB) must be caught by the byte threshold');
  assert.match(wide.hookSpecificOutput.permissionDecisionReason, /outline\.sh docs\/memory\/key-files\.md/);
  assert.equal(decision(runHook(READ_GUARD, bash(`cat ${BIG}`))), 'deny');
  assert.equal(decision(runHook(READ_GUARD, bash(`cat -n '${rel(BIG)}'`))), 'deny');
  for (const [label, input] of [
    ['ranged Read', read({ file_path: rel(BIG), offset: 1664, limit: 120 })],
    ['deliberate whole read of the table', read({ file_path: rel(WIDE), limit: 62 })],
    ['conventions.md read whole', read({ file_path: rel('docs/memory/conventions.md') })],
    ['a small file', read({ file_path: rel('CLAUDE.md') })],
    ['a missing file', read({ file_path: rel('src/nope.js') })],
    ['piped cat', bash(`cat ${BIG} | grep -n foo`)],
    ['redirected cat', bash(`cat ${BIG} > /dev/null`)],
    ['grep of the big file', bash(`grep -n foo ${BIG}`)],
    ['cat of a small file', bash('cat CLAUDE.md')],
  ]) {
    assert.equal(runHook(READ_GUARD, input), null, `read guard touched: ${label}`);
  }
  const png = readdirSync(rel('public')).find(f => f.endsWith('.png'));
  if (png) assert.equal(runHook(READ_GUARD, read({ file_path: rel(`public/${png}`) })), null, 'a PNG must never be miscounted');
  const r = spawnSync(process.execPath, [rel(READ_GUARD)], { cwd: root, input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '');
});

test('outline helper: Dashboard.jsx → a few hundred line-numbered entries incl. the component; key-files.md → its rows', { skip: shSkip }, () => {
  const r = sh('.claude/hooks/outline.sh', [BIG]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^== src\/components\/Dashboard\.jsx \(\d{4} lines\) ==$/);
  const entries = lines.slice(1);
  assert.ok(entries.length >= 100 && entries.length <= 600, `${entries.length} entries — the map should be a few hundred lines, not a re-read of the file`);
  for (const l of entries) {
    assert.match(l, /^\d+:/, `outline entry lacks a line number: ${l}`);
    assert.ok(l.length <= 120, `outline entry over 120 chars: ${l.slice(0, 40)}…`);
  }
  assert.ok(entries.some(l => /export default function Dashboard\(/.test(l)), 'the Dashboard component line is missing from its own map');
  assert.ok(entries.some(l => /tab==="overview"&&/.test(l)), 'the view branches are missing from the map');
  const rows = sh('.claude/hooks/outline.sh', [WIDE]).stdout.split('\n').filter(l => /^\d+:\| `[^`]+` \|/.test(l));
  assert.ok(rows.length >= 40, `only ${rows.length} key-files rows listed — a row is one Read-with-limit away only if the outline names it`);
  assert.ok(sh('.claude/hooks/outline.sh', ['docs/memory/conventions.md']).stdout.split('\n').some(l => /^\d+:## Conventions/.test(l)));
  const missing = sh('.claude/hooks/outline.sh', ['nope.txt']);
  assert.equal(missing.status, 1); assert.match(missing.stdout, /not a file/);
});

test('session token report: sums usage per model and ranks tool results from a fixture transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-tokens-'));
  const f = join(dir, 'session.jsonl');
  const usage = { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 50 };
  writeFileSync(f, [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/big.js' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(12_000) }] } }),
    'this line is not JSON and must be skipped',
    JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage, content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ok'.repeat(150) }] }] } }),
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [rel('.claude/hooks/session-tokens.mjs'), f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 assistant turns, 2 tool results/);
  assert.match(r.stdout, /claude-haiku-4-5 \| 2 \| 200 \| 4,000 \| 600 \| 100/);
  const ranked = r.stdout.split('largest tool results:')[1].trim().split('\n');
  assert.match(ranked[0], /12 KB\s+Read\s+\/x\/big\.js/, 'the biggest result must rank first with its tool and target');
  assert.match(ranked[1], /Bash\s+npm test/);
  const none = spawnSync(process.execPath, [rel('.claude/hooks/session-tokens.mjs')], { encoding: 'utf8' });
  assert.equal(none.status, 2, 'no arguments → usage + exit 2');
});

// --- (5) the digest keeps failures verbatim and never hides a broken run ------

const digest = input => sh('.claude/hooks/test-digest.sh', [], { input });

test('digest: green → summary only (exit 0); red → failing block verbatim (exit 1); no summary → full passthrough (exit 1)', { skip: shSkip }, () => {
  const summary = '# tests 2\n# suites 0\n# pass 2\n# fail 0\n# duration_ms 5\n';
  const green = digest('TAP version 13\nok 1 - a\nok 2 - b\n' + summary);
  assert.equal(green.status, 0);
  assert.ok(!green.stdout.includes('ok 1 - a'), 'green detail leaked through the digest');
  assert.match(green.stdout, /# pass 2/);
  assert.match(green.stdout, /green detail suppressed/);

  const block = "not ok 2 - b\n  ---\n  error: 'expected 1 to equal 2'\n  stack: |\n    at x.js:1\n  ...\n";
  const red = digest('ok 1 - a\n' + block + summary.replace('# pass 2\n# fail 0', '# pass 1\n# fail 1'));
  assert.equal(red.status, 1);
  assert.ok(red.stdout.includes(block.trimEnd()), 'the failing block must appear VERBATIM');
  assert.ok(!red.stdout.includes('ok 1 - a'));

  const broken = digest('npm ERR! missing script: test\nnpm ERR! boom\n');
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /npm ERR! boom/);
  assert.match(broken.stdout, /no TAP summary found/);
});
