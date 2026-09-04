#!/bin/sh
# PreToolUse guard (matcher: Read; and Bash/PowerShell via `if: Bash(cat *)`).
#
# What it stops: a WHOLE-FILE read of a file over BIG_LINES lines — a Read with
# no `limit`, or a bare `cat <file>` — which puts up to 2,000 lines (~30k
# tokens for Dashboard.jsx, whose 8,000 lines are ~125k tokens in full) into
# the context in one call. The memory docs already say "search it, never read
# it whole"; this makes the rule mechanical. Hooks from settings run inside
# subagents too, so the Explore agent is held to it as well.
#
# What passes untouched: a Read with `limit` (ranged read — the caller chose
# the range); a `cat` that pipes or redirects (`cat f | grep x`, `cat f >
# out`) — its output is filtered or leaves the context; any file at or under
# the threshold; anything binary (NUL byte in the first 8 KiB) so PDFs and
# images are never miscounted; a path that does not exist.
#
# The deny reason carries the real line count, a token estimate, and the cheap
# substitutes (grep -n, the outline map, a ranged Read, the Explore agent).
#
# BIG_LINES is the ONE tuning knob (docs/claude-routing.md "Tuning"): every
# docs/memory file is under it, so the memory docs stay readable whole.
# Override per machine with MM_READ_GUARD_LINES=<n> in the environment.
#
# Dependency: python3 (safe JSON parsing). Missing python3 = allow, so a broken
# guard can never block a read. The program is passed via `-c "$(cat <<'PY'
# … PY)"`: command substitution consumes the heredoc, leaving the hook's own
# stdin (the JSON Claude Code pipes in) for the program to read. A plain
# `python3 - <<PY` would take the program from stdin and never see the JSON.
BIG_LINES=${MM_READ_GUARD_LINES:-1000}
command -v python3 >/dev/null 2>&1 || exit 0

exec python3 -c "$(cat <<'PY'
import json, os, shlex, sys

BIG = int(sys.argv[1])

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = data.get('tool_name') or ''
inp = data.get('tool_input') or {}
cwd = data.get('cwd') or os.getcwd()


def resolve(path):
    return path if os.path.isabs(path) else os.path.join(cwd, path)


def text_lines(path):
    """Line count of a text file; 0 for missing, unreadable, or binary."""
    p = resolve(path)
    try:
        if not os.path.isfile(p):
            return 0, 0
        with open(p, 'rb') as f:
            head = f.read(8192)
            if b'\0' in head:
                return 0, 0
            n = head.count(b'\n')
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                n += chunk.count(b'\n')
        return n, os.path.getsize(p)
    except Exception:
        return 0, 0


def shown(path):
    p = resolve(path)
    try:
        rel = os.path.relpath(p, cwd)
    except ValueError:  # Windows: different drive letters
        return path
    return path if rel.startswith('..') else rel


def deny(path, n, size):
    rel = shown(path)
    est = max(1, round(size / 4000))
    reason = (
        f'{rel} is {n:,} lines (~{est}k tokens whole); whole-file reads of files over '
        f'{BIG:,} lines are blocked to keep the context small. Instead: grep -n it for the '
        f'identifier you need, or run `.claude/hooks/outline.sh {rel}` for a line-numbered '
        f'map of its declarations, then Read just that range with offset+limit (or delegate '
        f'the lookup to the Explore agent).'
    )
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': reason,
    }}))
    sys.exit(0)


if tool == 'Read':
    path = inp.get('file_path') or ''
    if path and inp.get('limit') is None:
        n, size = text_lines(path)
        if n > BIG:
            deny(path, n, size)
elif tool in ('Bash', 'PowerShell'):
    cmd = inp.get('command') or ''
    # A pipe or redirect means the output is filtered or leaves the context.
    if '|' in cmd or '>' in cmd:
        sys.exit(0)
    try:
        words = shlex.split(cmd)
    except ValueError:
        sys.exit(0)
    if not words or os.path.basename(words[0]) != 'cat':
        sys.exit(0)
    for arg in words[1:]:
        if arg.startswith('-') or arg in ('&&', ';', '||'):
            continue
        n, size = text_lines(arg)
        if n > BIG:
            deny(arg, n, size)
sys.exit(0)
PY
)" "$BIG_LINES"
