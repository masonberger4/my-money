#!/usr/bin/env node
// PreToolUse guard (matcher: Read; and Bash/PowerShell via `if: Bash(cat *)`).
//
// What it stops: a WHOLE-FILE read of a big file — a Read with no `limit`, or a
// bare `cat <file>` — which puts up to 2,000 lines (~30k tokens for
// Dashboard.jsx, whose thousands of lines are well over 100k in full; tens
// of thousands for the key-files.md table, which is few lines but wide)
// into the context in one call. The memory docs
// already say "search it, never read it whole"; this makes the rule
// mechanical. Hooks from settings run inside subagents too, so Explore is
// held to it as well.
//
// Big = over BIG_LINES lines OR over BIG_BYTES bytes. Both knobs sit above
// every docs/memory file EXCEPT key-files.md, on purpose: that file is a
// per-file table every rule says to read one ROW of (the outline lists the
// rows), while conventions.md sits under both knobs because it is meant to
// be read whole for money math (`wc -lc docs/memory/*.md` shows the margins). Override per machine with MM_READ_GUARD_LINES / MM_READ_GUARD_BYTES.
//
// What passes untouched: a Read with `limit` (the caller chose the range — a
// deliberate whole read is `limit: <line count>`); a `cat` that pipes or
// redirects (its output is filtered or leaves the context); anything at or
// under both thresholds; anything binary (NUL byte in the first 8 KiB), so
// PDFs and images are never miscounted; a path that does not exist.
//
// Node, not sh+python3 (the 2026-08-31 form): node is the one runtime this
// repo guarantees on every machine, and a guard that silently allows on a
// Windows shell without python3 saves nothing exactly where Mason runs
// locally. Malformed input → exit 0 with no output (= allow): a broken guard
// must never block a read.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep, basename } from 'node:path';

const BIG_LINES = Number(process.env.MM_READ_GUARD_LINES) || 1000;
const BIG_BYTES = Number(process.env.MM_READ_GUARD_BYTES) || 64 * 1024;

let data;
try { data = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const tool = data?.tool_name ?? '';
const inp = (data?.tool_input && typeof data.tool_input === 'object') ? data.tool_input : {};
const cwd = data?.cwd || process.cwd();

const resolvePath = p => (isAbsolute(p) ? p : join(cwd, p));

// {lines, bytes} for a text file; null for missing, unreadable, or binary.
function measure(path) {
  let fd;
  try {
    const p = resolvePath(path);
    const st = statSync(p);
    if (!st.isFile()) return null;
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(1 << 20);
    let lines = 0, pos = 0, n;
    while ((n = readSync(fd, buf, 0, buf.length, pos)) > 0) {
      if (pos === 0 && buf.subarray(0, Math.min(n, 8192)).includes(0)) return null;
      for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
      pos += n;
    }
    return { lines, bytes: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const posix = s => s.split(sep).join('/');
function shown(path) {
  const rel = relative(cwd, resolvePath(path));
  return posix(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path);
}

const big = m => m && (m.lines > BIG_LINES || m.bytes > BIG_BYTES);

function deny(path, m) {
  const rel = shown(path);
  const kb = Math.round(m.bytes / 1024);
  const est = Math.max(1, Math.round(m.bytes / 4000));
  const reason =
    `${rel} is ${m.lines.toLocaleString('en-US')} lines / ${kb} KB (~${est}k tokens whole); ` +
    `whole-file reads of files over ${BIG_LINES.toLocaleString('en-US')} lines or ${Math.round(BIG_BYTES / 1024)} KB ` +
    'are blocked to keep the context small. Instead: grep -n it for the identifier you need, or run ' +
    `\`.claude/hooks/outline.sh ${rel}\` for a line-numbered map (declarations; headings and table rows for .md), ` +
    'then Read just that range with offset+limit, or delegate the lookup to the Explore agent. ' +
    `A deliberate whole read is Read with limit:${m.lines} — the guard only stops the accidental case.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n');
  process.exit(0);
}

// Minimal shell-word split: enough for `cat [-flags] path ...`; quotes kept
// together. Command separators glued to a path (`cat f;`, `cat f&&x`) are
// turned into spaces first so the path still measures.
function words(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

if (tool === 'Read') {
  const path = typeof inp.file_path === 'string' ? inp.file_path : '';
  if (path && (inp.limit === undefined || inp.limit === null)) {
    const m = measure(path);
    if (big(m)) deny(path, m);
  }
} else if (tool === 'Bash' || tool === 'PowerShell') {
  const cmd = typeof inp.command === 'string' ? inp.command : '';
  const piped = /(^|[^|])\|(?!\|)/.test(cmd); // a single `|`; `||` is a separator, not a pipe
  if (!piped && !cmd.includes('>')) {
    const w = words(cmd.replace(/;|&&|\|\|/g, ' '));
    if (w.length && basename(w[0]) === 'cat') {
      for (const arg of w.slice(1)) {
        if (arg.startsWith('-')) continue;
        const m = measure(arg);
        if (big(m)) deny(arg, m);
      }
    }
  }
}
process.exit(0);
