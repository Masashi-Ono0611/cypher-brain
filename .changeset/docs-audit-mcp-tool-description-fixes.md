---
'cypher-brain': patch
---

Three MCP tool-description accuracy fixes, found while auditing docs/behavior consistency
after the recent burst of merges — no behavior change, only what the tools *say* about
themselves (which an agent driving this server reads to decide what to do):

- **`snapshot_now`'s description now states the idempotency TTL's one permanent
  exception**: it used to say every cached result expires after
  `CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS`, without mentioning that a paid push whose
  outcome is UNCERTAIN records a PERMANENT tombstone (`ERR_PUSH_OUTCOME_UNCERTAIN`) that
  never expires (the `idempotency_key` parameter's own description already covered this
  in full — only the tool's top-level summary was missing it, #822).
- **`schedule_install`'s description now says all THREE paid backends** (arweave, turbo,
  AND `ton-provider`) get `CYPHER_BRAIN_YES=1` baked into the generated runner for
  unattended consent — it used to say only arweave/turbo did, even though the code
  (`schedule.ts`'s `NEEDS_UNATTENDED_CONSENT`) always included `ton-provider` too. The
  runtime `ERR_CONFIRM_REQUIRED` refusal text now also branches its spend-cap wording
  correctly: "capped at max_spend" for arweave/turbo, "capped by
  `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`" for `ton-provider` (whose deploys `max_spend`
  does not apply to and is refused for).
- **`schedule_status`'s description no longer claims its result is the CLI's printed
  lines "verbatim"** — it returns the same STRUCTURED object `schedule status --json`
  does (`README.md`'s own MCP tool table already said so correctly; only the tool's own
  schema description had drifted).
