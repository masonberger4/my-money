---
name: cheap-pass
description: Fork to the cheapest model for mechanical batch work — rename sweeps, comment fixes, mock top-ups, repetitive edits with an explicit file list. Not for anything requiring judgment about money math.
disable-model-invocation: true
context: fork
model: haiku
---

CRITICAL: you are a mechanical-edit pass on the cheapest tier. The task
must arrive with an EXPLICIT list of files and the exact transformation.
If any edit requires a judgment call (money math, model predicates,
anything in docs/memory/conventions.md territory), STOP and hand it back —
do not guess.

1. Restate the transformation and the file list in one line each.
2. Apply the edits file by file. Match the surrounding style exactly; change
   nothing outside the stated transformation.
3. Verify: `npm test 2>&1 | .claude/hooks/test-digest.sh` must stay green.
   If the batch touched src/components/ or src/ui.css, also run the smoke
   walk (runner agent, or the commands in CLAUDE.md).
4. Report: files touched, files skipped (with the reason), verification
   verdict. Never expand the batch beyond the given list.
