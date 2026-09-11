---
"cypher-brain": minor
---

`doctor` and `estimate` now have visibility into the cumulative spend admission
control (`CYPHER_BRAIN_MAX_SPEND_DAILY`/`_MONTHLY`, and the `ton-provider`
counterparts) — previously the only way to see this state was a real push
attempt (#925, #926, #927).

- `doctor` gains four new checks, family-symmetric across arweave/turbo and
  ton-provider: `spend-budget-usage`/`ton-provider-spend-budget-usage` report
  "daily: X of Y used (Z%)" / "monthly: X of Y used (Z%)" (today's/this
  UTC-month's receipted spend plus any open reservations) whenever a cap is
  configured, and SKIP when neither the daily nor monthly cap is set — the
  same posture the sibling receipt-ledger-readability check already takes for
  "nothing to report yet." `spend-budget-cap-config`/
  `ton-provider-spend-budget-cap-config` proactively FAIL when
  `CYPHER_BRAIN_MAX_SPEND_DAILY`/`_MONTHLY` (or their ton-provider
  counterparts) is set without the required positive
  `CYPHER_BRAIN_MAX_SPEND`/`CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND` —
  `spend-budget.ts`'s admission check already refuses every push in that
  family on this misconfiguration; `doctor` now catches it before a real
  (possibly unattended, nightly) push crashes on it.
- `estimate` (CLI and the MCP `estimate_cost` tool, which share the same
  computation) now warns — in both the human-readable `note` line and the
  machine-readable `warnings` array — when this upload's cost, added to what
  is already receipted/reserved today or this month, would exceed a
  configured cumulative spend cap. `estimate` remains a pure read-only,
  dry-run command: it never refuses, and the native cost/size/USD fields are
  unaffected either way.

Both surfaces reuse a new read-only `getSpendUsage()` export in
`spend-budget.ts` — the exact same day/month-window fold and open-reservation
accounting `reserveSpendBudget()`'s own admission check uses — so neither can
ever disagree with what a real push would compute. Unlike the admission
check, `getSpendUsage()` never fails closed on an unreadable/unpriceable
receipt or reservation line: it degrades to a WARN (an "undercount" caveat)
rather than a FAIL, the same data-quality posture `receipt-ledger-readability`
already takes.
