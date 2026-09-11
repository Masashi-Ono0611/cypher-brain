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
  machine-readable `warnings` array — when a fresh push would push cumulative
  spend over a configured cap. This compares against the configured
  single-push cap (`CYPHER_BRAIN_MAX_SPEND`/`CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`),
  not this estimate's own displayed cost: `reserveSpendBudget()` reserves that
  whole per-push cap for a fresh push (not the shown estimate, which can go
  stale), so it can conservatively refuse a cheaper upload — the warning
  reflects that same conservatism rather than under-warning on it. It also
  warns (separately) when the per-push cap itself is missing while a
  daily/monthly cap is set (the same misconfiguration `spend-budget-cap-config`
  flags) and when the underlying spend data is degraded. `estimate` remains a
  pure read-only, dry-run command: it never refuses, and the native
  cost/size/USD fields are unaffected either way.

Both surfaces reuse a new read-only `getSpendUsage()` export in
`spend-budget.ts` — the same day/month-window fold and open-reservation
accounting `reserveSpendBudget()`'s own admission check uses, kept as one
answer to "how much has this family spent" rather than a second, independently
re-derived one. Unlike the admission check, `getSpendUsage()` never fails
closed on an unreadable/unpriceable receipt or reservation line: it degrades
to a WARN (an "undercount" caveat) rather than a FAIL, the same data-quality
posture `receipt-ledger-readability` already takes.
