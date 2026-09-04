#!/bin/sh
# PreToolUse guard (matcher: Bash, if: npm *): a BARE `npm test` prints 5,700+
# TAP lines (~20k tokens) straight into the model's context. Since 2026-09-04
# this REWRITES exactly that form to the digest pipe via `updatedInput`
# (allow + rewritten command) instead of denying it — a deny cost a round
# trip (the refusal, then the model re-issuing the piped form) every time;
# the rewrite costs nothing and the model sees, via additionalContext, that
# the digest ran. Everything else — the digest pipe itself, targeted
# `node --test <file>` runs, redirected output — passes untouched.
#
# Dependency: python3 (for safe JSON parsing). If it is missing, allow —
# a broken guard must never block the test suite.
#
# NOTE the program is passed with -c via command substitution, NOT a plain
# heredoc — `python3 - <<PY` would take the program from stdin and the hook
# JSON piped in by Claude Code would never be seen (caught by the pipe-test
# when this hook was first written). `$(cat <<'PY' … PY)` consumes the
# heredoc inside the substitution and leaves stdin for the JSON.
command -v python3 >/dev/null 2>&1 || exit 0

exec python3 -c "$(cat <<'PY'
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

inp = data.get('tool_input') or {}
cmd = inp.get('command', '') or ''
norm = ' '.join(cmd.split())

# Only the bare forms; anything with a pipe, redirect, or extra args is fine.
if re.fullmatch(r'npm (test|t|run test|run tests)( --)?', norm):
    updated = dict(inp)  # updatedInput replaces the whole object: keep the rest
    updated['command'] = norm + ' 2>&1 | .claude/hooks/test-digest.sh'
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'permissionDecisionReason': 'bare npm test rewritten to the TAP digest pipe',
            'updatedInput': updated,
            'additionalContext': (
                'The bare npm test was rewritten by the repo hook to '
                '`npm test 2>&1 | .claude/hooks/test-digest.sh`: a green run shows only '
                'the summary lines; a red run shows every failing block verbatim.'
            ),
        }
    }))
sys.exit(0)
PY
)"
