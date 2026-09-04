#!/usr/bin/env node
// PreToolUse guard (matcher: Bash, if: npm * / node --test*): a BARE `npm test`
// or a bare `node --test` prints 5,700+ TAP lines (~20k tokens) straight into
// the model's context. Since 2026-09-04 this REWRITES exactly those forms to
// the digest pipe via `updatedInput` (allow + rewritten command) instead of
// denying — a deny cost a round trip (the refusal, then the model re-issuing
// the piped form) every time; the rewrite costs nothing, and the model is told
// via additionalContext that the digest ran. Everything else — the digest pipe
// itself, targeted `node --test <file>` runs, redirected output — passes
// untouched.
//
// Node, not sh+python3, for the reason in pretooluse-read-guard.mjs: node is
// the one runtime this repo guarantees everywhere. Malformed input → exit 0
// with no output (= allow): a broken guard must never block the test suite.
//
// If a CLI predates `updatedInput` the rewrite is ignored and the bare form
// runs un-digested — the tell is a TAP dump with no additionalContext note;
// the fix is the pre-2026-09-04 deny form (git history), not removing the hook.
import { readFileSync } from 'node:fs';

let data;
try { data = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const inp = (data?.tool_input && typeof data.tool_input === 'object') ? data.tool_input : {};
const cmd = typeof inp.command === 'string' ? inp.command : '';
const norm = cmd.trim().split(/\s+/).join(' ');

// Only the bare forms; anything with a pipe, redirect, a file, or extra args is fine.
const BARE = /^(npm (test|t|run test|run tests)( --)?|node --test)$/;
if (BARE.test(norm)) {
  const updated = { ...inp, command: `${norm} 2>&1 | .claude/hooks/test-digest.sh` };
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'bare test run rewritten to the TAP digest pipe',
      updatedInput: updated,
      additionalContext:
        `The bare \`${norm}\` was rewritten by the repo hook to \`${updated.command}\`: ` +
        'a green run shows only the summary lines; a red run shows every failing block verbatim.',
    },
  }) + '\n');
}
process.exit(0);
