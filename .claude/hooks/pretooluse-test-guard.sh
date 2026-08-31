#!/bin/sh
# PreToolUse guard (matcher: Bash, if: npm *): a BARE `npm test` prints 5,700+
# TAP lines straight into the model's context. Deny exactly that form with a
# pointer to the digest pipe; everything else — the digest pipe itself,
# targeted `node --test <file>` runs, redirected output — passes untouched.
#
# Dependency: python3 (for safe JSON parsing). If it is missing, allow —
# a broken guard must never block the test suite.
#
# NOTE: the program is passed with -c, NOT a heredoc — `python3 -` would eat
# stdin as the program and the hook JSON piped in by Claude Code would never
# be seen (caught by the pipe-test when this hook was first written).
command -v python3 >/dev/null 2>&1 || exit 0

exec python3 -c "
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cmd = (data.get(\"tool_input\") or {}).get(\"command\", \"\") or \"\"
norm = \" \".join(cmd.split())

# Only the bare forms; anything with a pipe, redirect, or extra args is fine.
if re.fullmatch(r\"npm (test|t|run test|run tests)( --)?\", norm):
    print(json.dumps({
        \"hookSpecificOutput\": {
            \"hookEventName\": \"PreToolUse\",
            \"permissionDecision\": \"deny\",
            \"permissionDecisionReason\": (
                \"Bare npm test dumps 5,700+ TAP lines into context. Run \"
                \"npm test 2>&1 | .claude/hooks/test-digest.sh (verdict + \"
                \"failures verbatim), or delegate the run to the runner agent.\"
            ),
        }
    }))
sys.exit(0)
"
