// The `.claude/` token-usage setup, kept honest the way claudeMdLockstep keeps
// the memory docs honest: a hook that silently stopped firing, a helper that
// silently stopped matching, or an agent body that quietly grew back to a
// page would each cost tokens on every session with no alarm anywhere.
//
// What is pinned, and why each pin is cheap enough to keep:
//  (1) settings.json parses, and every hook it wires exists, is executable,
//      is `#!/bin/sh`, and is LF — a CRLF shebang fails to exec on Linux CI
//      with an error that reads like a missing interpreter.
//  (2) The always-loaded footprint: every agent/skill description (loaded into
//      EVERY session's system prompt as the routing table) stays short, and
//      agent, rule, and skill BODIES stay within a page. CLAUDE.md's own
//      100-line cap lives in claudeMdLockstep — not restated here.
//  (3) The hooks and the digest do what docs/claude-routing.md says they do,
//      exercised by piping the same JSON Claude Code pipes in: the test guard
//      REWRITES a bare `npm test` to the digest pipe and stays silent on the
//      piped form; the read guard DENIES a whole-file Read/cat of a big file
//      and stays silent on a ranged Read, a piped cat, a memory doc, an
//      image; the outline helper maps Dashboard.jsx to a few hundred lines.
//  (4) The digest keeps a failing block VERBATIM and never hides a run that
//      died before its TAP summary (the "never truncate a broken run" rule).
//
// The hooks need `sh` and python3; where either is missing (a bare Windows
// shell) those cases skip rather than fail — the hooks themselves degrade to
// allow there, by design, so there is nothing to assert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const claudeDir = join(root, '.claude');
const rel = p => join(root, p);

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const hasPython = hasSh && spawnSync('sh', ['-c', 'command -v python3']).status === 0;
const skipReason = hasPython ? false : 'needs sh + python3 (the hooks degrade to allow without them)';

// Pipe hook-shaped JSON at a hook the way Claude Code does; return parsed JSON
// output or null when the hook stayed silent (= allow, untouched).
function runHook(script, input) {
  const r = spawnSync('sh', [rel(script)], { cwd: root, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, `${script} exited ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}
const decision = j => j?.hookSpecificOutput?.permissionDecision ?? null;

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

// --- (1) settings.json wires real, executable, LF hooks ----------------------

const settings = JSON.parse(readFileSync(rel('.claude/settings.json'), 'utf8'));
const wiredHooks = [...new Set(
  Object.values(settings.hooks ?? {}).flat().flatMap(e => e.hooks ?? []).map(h => h.command)
)];

test('settings.json wires the three guards and each hook script is a real LF sh script', () => {
  assert.ok(wiredHooks.length >= 2, `only ${wiredHooks.length} hook commands wired — did the hooks block go missing?`);
  assert.ok(wiredHooks.includes('.claude/hooks/pretooluse-test-guard.sh'));
  assert.ok(wiredHooks.includes('.claude/hooks/pretooluse-read-guard.sh'));
  for (const h of [...wiredHooks, '.claude/hooks/test-digest.sh', '.claude/hooks/outline.sh']) {
    assert.ok(existsSync(rel(h)), `${h} is wired or documented but does not exist`);
    const text = readFileSync(rel(h), 'utf8');
    assert.ok(text.startsWith('#!/bin/sh\n'), `${h} must start with #!/bin/sh`);
    assert.ok(!text.includes('\r'), `${h} has CRLF line endings — the shebang would not exec`);
    if (process.platform !== 'win32') {
      assert.ok(statSync(rel(h)).mode & 0o111, `${h} is not executable (chmod +x, and git add the mode)`);
    }
  }
  // The Read guard must fire on Read AND on Bash `cat`: both matchers wired.
  const pre = settings.hooks.PreToolUse;
  const readGuardMatchers = pre.filter(e => e.hooks.some(h => h.command.endsWith('read-guard.sh'))).map(e => e.matcher);
  assert.deepEqual(readGuardMatchers.sort(), ['Bash', 'Read']);
});

// --- (2) the always-loaded footprint -----------------------------------------

const AGENT_BODY_MAX = 70;   // lines — a page; the routing table says what, the memory docs say why
const RULE_MAX = 40;         // lines — pointers + hard invariants, never restatements
const SKILL_MAX = 45;        // lines
const DESCRIPTION_MAX = 320; // chars — every description rides in every session's system prompt

test('every agent has name/description/model, a short description, and a bounded body', () => {
  const agents = mdFiles('.claude/agents');
  assert.ok(agents.length >= 7, `only ${agents.length} agents found — the routing table has 7`);
  for (const f of agents) {
    const { fields, body } = frontmatter(readFileSync(rel(f), 'utf8'));
    for (const k of ['name', 'description', 'model']) assert.ok(fields[k], `${f} lacks frontmatter ${k}`);
    assert.ok(fields.description.length <= DESCRIPTION_MAX, `${f} description is ${fields.description.length} chars (cap ${DESCRIPTION_MAX})`);
    assert.ok(/^\d+$/.test(fields.maxTurns ?? ''), `${f} lacks a numeric maxTurns (the runaway backstop)`);
    assert.ok(lineCount(body) <= AGENT_BODY_MAX, `${f} body is ${lineCount(body)} lines (cap ${AGENT_BODY_MAX}) — the rules belong in docs/memory, the agent points at them`);
  }
});

test('every rule is path-scoped and bounded; every skill has a short description and bounded body', () => {
  const rules = mdFiles('.claude/rules');
  assert.ok(rules.length >= 5, `only ${rules.length} rules found`);
  for (const f of rules) {
    const text = readFileSync(rel(f), 'utf8');
    assert.ok(/^---\npaths:\n(\s+- .+\n)+---\n/.test(text), `${f} lacks a paths: frontmatter list`);
    assert.ok(lineCount(text) <= RULE_MAX, `${f} is ${lineCount(text)} lines (cap ${RULE_MAX})`);
  }
  const skills = readdirSync(rel('.claude/skills')).map(d => `.claude/skills/${d}/SKILL.md`).filter(f => existsSync(rel(f)));
  assert.ok(skills.length >= 6, `only ${skills.length} skills found`);
  for (const f of skills) {
    const { fields } = frontmatter(readFileSync(rel(f), 'utf8'));
    assert.ok(fields.name && fields.description, `${f} lacks name/description`);
    assert.ok(fields.description.length <= DESCRIPTION_MAX, `${f} description is ${fields.description.length} chars (cap ${DESCRIPTION_MAX})`);
    assert.ok(lineCount(readFileSync(rel(f), 'utf8')) <= SKILL_MAX, `${f} is ${lineCount(readFileSync(rel(f), 'utf8'))} lines (cap ${SKILL_MAX})`);
  }
});

// --- (3) the hooks do what the routing doc says --------------------------------

const TEST_GUARD = '.claude/hooks/pretooluse-test-guard.sh';
const READ_GUARD = '.claude/hooks/pretooluse-read-guard.sh';
const BIG = 'src/components/Dashboard.jsx';
const bash = command => ({ tool_name: 'Bash', cwd: root, tool_input: { command, description: 'x' } });
const read = tool_input => ({ tool_name: 'Read', cwd: root, tool_input });

test('test guard: a bare `npm test` is REWRITTEN to the digest pipe, everything else passes', { skip: skipReason }, () => {
  const j = runHook(TEST_GUARD, bash('npm test'));
  assert.equal(decision(j), 'allow');
  assert.equal(j.hookSpecificOutput.updatedInput.command, 'npm test 2>&1 | .claude/hooks/test-digest.sh');
  assert.equal(j.hookSpecificOutput.updatedInput.description, 'x', 'updatedInput replaces the whole object — the description must survive');
  assert.match(j.hookSpecificOutput.additionalContext ?? '', /test-digest/);
  assert.equal(decision(runHook(TEST_GUARD, bash('npm run test'))), 'allow');
  for (const ok of ['npm test 2>&1 | .claude/hooks/test-digest.sh', 'node --test test/spending.test.js', 'npm ci', 'npm test -- test/x.test.js']) {
    assert.equal(runHook(TEST_GUARD, bash(ok)), null, `guard touched: ${ok}`);
  }
});

test('read guard: whole-file Read/cat of a big file is denied with the outline pointer; ranged, piped, small, binary pass', { skip: skipReason }, () => {
  assert.ok(lineCount(readFileSync(rel(BIG), 'utf8')) > 1000, `${BIG} is no longer over the threshold — pick another big file for this test`);
  const denied = runHook(READ_GUARD, read({ file_path: rel(BIG) }));
  assert.equal(decision(denied), 'deny');
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /outline\.sh src\/components\/Dashboard\.jsx/, 'the deny must point at the outline helper with a repo-relative path');
  assert.match(reason, /offset\+limit/);
  assert.match(reason, /\d,\d{3} lines/, 'the deny must state the real line count');
  assert.equal(decision(runHook(READ_GUARD, bash(`cat ${BIG}`))), 'deny');
  assert.equal(decision(runHook(READ_GUARD, bash(`cat -n ${rel(BIG)}`))), 'deny');
  for (const [label, input] of [
    ['ranged Read', read({ file_path: rel(BIG), offset: 1664, limit: 120 })],
    ['a memory doc read whole', read({ file_path: rel('docs/memory/conventions.md') })],
    ['a small file', read({ file_path: rel('CLAUDE.md') })],
    ['a missing file', read({ file_path: rel('src/nope.js') })],
    ['piped cat', bash(`cat ${BIG} | grep -n foo`)],
    ['redirected cat', bash(`cat ${BIG} > /dev/null`)],
    ['grep of the big file', bash(`grep -n foo ${BIG}`)],
    ['cat of a small file', bash('cat CLAUDE.md')],
  ]) {
    assert.equal(runHook(READ_GUARD, input), null, `read guard touched: ${label}`);
  }
  // Binary: the first PNG the repo ships; a NUL byte in the head skips the count.
  const png = readdirSync(rel('public')).find(f => f.endsWith('.png'));
  if (png) assert.equal(runHook(READ_GUARD, read({ file_path: rel(`public/${png}`) })), null, 'a PNG must never be miscounted');
  // Malformed input never blocks anything.
  const r = spawnSync('sh', [rel(READ_GUARD)], { cwd: root, input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '');
});

test('outline helper: maps Dashboard.jsx to a few hundred line-numbered entries, incl. the component itself', { skip: hasSh ? false : 'needs sh' }, () => {
  const r = spawnSync('sh', [rel('.claude/hooks/outline.sh'), BIG], { cwd: root, encoding: 'utf8' });
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
  // Markdown and a missing file: headings; exit 1 with a message, never silence.
  const md = spawnSync('sh', [rel('.claude/hooks/outline.sh'), 'docs/memory/conventions.md'], { cwd: root, encoding: 'utf8' });
  assert.ok(md.stdout.split('\n').some(l => /^\d+:## Conventions/.test(l)));
  const missing = spawnSync('sh', [rel('.claude/hooks/outline.sh'), 'nope.txt'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stdout, /not a file/);
});

// --- (4) the digest keeps failures verbatim and never hides a broken run ------

const digest = input => spawnSync('sh', [rel('.claude/hooks/test-digest.sh')], { cwd: root, input, encoding: 'utf8' });

test('digest: green → summary only (exit 0); red → failing block verbatim (exit 1); no summary → full passthrough (exit 1)', { skip: hasSh ? false : 'needs sh' }, () => {
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
