---
'cypher-brain': patch
---

MCP-side UX cleanup for validation errors and tool descriptions, from round 4
dogfooding:

- `snapshot_now`/`schedule_install` no longer leak CLI-flag guidance
  (`--profile`/`--pg`/`--dir`, `--max-spend`, `--ping-url-fail`) into an MCP
  caller's error text — the shared `snapshot()`/`schedule()` validation is now
  translated to this tool's own JSON field names (`dirs`/`pg`, `max_spend`,
  `ping_url_fail`) and reclassified from the generic `ERR_INTERNAL` to
  `ERR_INVALID_INPUT` (#726).
- The `[CB-E0xx]` doc pointer now resolves to a full GitHub URL
  (`https://github.com/Masashi-Ono0611/cypher-brain/blob/main/MANAGEMENT.md#error-codes`)
  instead of a bare `MANAGEMENT.md#error-codes` relative filename, which is not
  part of the published npm package (#727).
- An unknown MCP tool name now gets the same `nearestName()`/`didYouMean()`
  suggestion undeclared arguments and out-of-enum values already do (#728).
- `backend`'s "missing entirely" refusal (`requireBackend`) and "present but
  wrong" refusal (`assertDeclaredEnums`) now render the same quoted,
  comma-joined allowed-value list via a shared `formatAllowedValues()` helper,
  instead of two structurally different shapes for the same underlying rule
  (#753).
- `schedule_install`'s free-backend/`max_spend` refusal no longer ends in a
  dangling `— see below` cross-reference; the actual alternative
  (`CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`) is already named right before it
  (#754).
- Every MCP enum-violation error's long design-rationale sentence is replaced
  with a short "refused rather than ignored" note, so the accepted-value list
  is the message's clear final takeaway instead of being buried mid-paragraph
  (#755).
- The repeated "how to bootstrap a TON wallet" tangent across 5 MCP tool
  descriptions (`snapshot_now`, `estimate_cost`, `schedule_install` x2,
  `wallet_create`) is now a single canonical explanation on `wallet_create`,
  with the other tools pointing at it instead of repeating it (#756).
