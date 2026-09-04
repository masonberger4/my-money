#!/bin/sh
# Line-numbered map of a file's structure — the cheap substitute for reading a
# big file whole. Usage:
#   .claude/hooks/outline.sh <file> [<file> ...]
#
# What it lists, by extension:
#   .js/.jsx/.mjs/.cjs/.ts/.tsx (and anything unrecognised): function
#     declarations at ANY depth, const/let/class bindings of arrows, functions,
#     hooks, memo/forwardRef; useEffect/useLayoutEffect sites; Dashboard's
#     `tab==="…"&&` view branches; one-line JSX comments; `// ----` banners.
#   .md: headings + table rows whose first cell is a backticked path (so a
#     key-files.md row is one `sed -n` / Read-with-limit away).   .sql: create/alter/drop/insert/grant + `-- ===` banners.
#   .json: top-level keys.   .css: `/* ---- */` banners and @-rules.
#
# Why: src/components/Dashboard.jsx is 8,000+ lines (~100k tokens); this map
# of it is ~290 lines. The read guard (pretooluse-read-guard.sh) points here
# when a whole-file read of a file over its line threshold is denied. Read the
# range you need afterwards with offset+limit (or `sed -n 'A,Bp'`).
#
# Zero dependencies beyond grep/wc/cut. Every output line is `N:text`, cut at
# 120 characters; a file with no matches says so instead of printing nothing.
[ $# -gt 0 ] || { echo "usage: $0 <file> [<file> ...]" >&2; exit 2; }

JS='^[[:space:]]*(export[[:space:]]+)?(default[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+[A-Za-z_$]|^[[:space:]]*(export[[:space:]]+)?(const|let|class)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=[[:space:]]*(async[[:space:]]*)?(\(|function|use[A-Z]|React\.memo|forwardRef|memo\()|^[[:space:]]*(export[[:space:]]+)?class[[:space:]]+[A-Za-z_$]|^[[:space:]]*(useEffect|useLayoutEffect)\(|tab==="[a-z]+"&&|^[[:space:]]*\{/\*.*\*/\}[[:space:]]*$|^[[:space:]]*//[[:space:]]*(-{3,}|={3,}|#{2,})|^[[:space:]]*(describe|test|it)\('
MD='^#{1,4} |^\| `[^`]+` \|'
SQL='^[[:space:]]*(create|alter|drop|insert|grant|revoke|--[[:space:]]*(={3,}|-{3,}))'
JSON='^  "[^"]+":'
CSS='^[[:space:]]*/\*[[:space:]]*(-{3,}|={3,})|^@[a-z-]+'

status=0
for f in "$@"; do
  if [ ! -f "$f" ]; then echo "== $f: not a file =="; status=1; continue; fi
  total=$(wc -l < "$f" | tr -d ' ')
  case "$f" in
    *.md)   re=$MD;   flags=-nE ;;
    *.sql)  re=$SQL;  flags=-inE ;;
    *.json) re=$JSON; flags=-nE ;;
    *.css)  re=$CSS;  flags=-nE ;;
    *)      re=$JS;   flags=-nE ;;
  esac
  echo "== $f ($total lines) =="
  out=$(grep $flags "$re" "$f" | cut -c1-120)
  if [ -n "$out" ]; then echo "$out"; else echo "(no structure matched — grep -n it for the identifier you need)"; fi
done
exit $status
