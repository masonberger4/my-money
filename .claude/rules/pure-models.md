---
paths:
  - "src/*.js"
  - "src/adapters/**"
---

The pure model layer. Read the touched file's row in
`docs/memory/key-files.md` and the model rules in
`docs/memory/conventions.md` (the linked-boundary spending/income model,
categories, envelopes) BEFORE editing — precedence chains here are decided
and test-pinned.

Hard invariants:
- Amounts: POSITIVE = money out. `assigned`/targets are plain positive
  dollars OUTSIDE that convention.
- ONE predicate per verdict: `isSpend` / `isIncome` / `displayCategory` /
  `deriveTxType`. Never re-derive a verdict a shape already carries
  (`counted`) — a second answer drifts.
- Rows must go through `markInternalTransfers` before `isSpend`; single-
  account reads never pair.
- Pure files stay plain-Node importable (no React/Supabase imports); every
  model change lands with its paired test.
- Never import `src/adapters/*` outside the adapter layer — the smoke
  harness aliases the façade, and a direct import bypasses the mock
  (`test/smokeMocks.test.js` names missing mock exports).
- Precedence changes (what outranks what) are architect-agent territory.
