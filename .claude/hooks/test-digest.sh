#!/bin/sh
# TAP digest for node --test output. Usage:
#   npm test 2>&1 | .claude/hooks/test-digest.sh
#
# Green run  -> just the "# tests/# pass/# fail/..." summary lines.
# Red run    -> each failing test's block (the `not ok` line through its YAML
#               diagnostic, error text verbatim) plus the summary; exits 1.
# No summary -> the run died before TAP completed (npm error, crash): the FULL
#               output is passed through untouched and the exit code is 1 —
#               the digest only truncates output it recognizes as a completed
#               test run, never a broken one.
#
# Zero dependencies beyond awk; if awk is somehow missing, degrade to cat so
# the pipeline still shows everything.
command -v awk >/dev/null 2>&1 || exec cat

exec awk '
  { lines[NR] = $0 }
  /^[[:space:]]*not ok/ { infail = 1; nfail++ }
  infail { print; printed++ }
  infail && /^[[:space:]]*\.\.\.[[:space:]]*$/ { infail = 0 }
  !infail && /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)/ {
    summary = 1; print; printed++
  }
  END {
    if (!summary) {
      # TAP never completed — do not hide anything.
      for (i = 1; i <= NR; i++) print lines[i]
      print "== test-digest: no TAP summary found; full output shown =="
      exit 1
    }
    if (NR > printed) printf "== test-digest: %d of %d lines shown (green detail suppressed) ==\n", printed, NR
    exit (nfail > 0 ? 1 : 0)
  }
'
