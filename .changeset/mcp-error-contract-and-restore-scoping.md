---
"cypher-brain": patch
---

Three MCP surface fixes found by dogfooding (#558, #559, #560):

- `resources/read` and `prompts/get` now go through the same structured
  `{code, message, cb_code}` error contract every `tools/call` error gets
  (previously they threw directly and fell through to the SDK's generic,
  unclassified `-32603` — no `code`, no `cb_code`, no `[CB-E0xx]` suffix). The
  `cypher-brain://schedule/status` resource in particular now reports the same
  `ERR_NOT_CONFIGURED` / `CB-E014` the `schedule_status` tool already reports
  for an identical "nothing installed" condition, instead of disagreeing with
  it. The structured payload rides the JSON-RPC error's `data` field, since
  those two protocols have no `isError`/`structuredContent` slot of their own.
- `restore_now`'s `out_dir` now warns (non-blocking, via the result's
  `warnings[]`) when it resolves outside `CYPHER_BRAIN_HOME`, since it writes
  DECRYPTED plaintext there — unlike `wallet_create`'s `out`, which is hard
  scoped to `CYPHER_BRAIN_HOME`, `restore_now`'s destination is intentionally
  NOT hard-refused: restoring into an arbitrary location outside this server's
  own config directory is the tool's normal use case (its own smoke test
  round-trips that way), so a hard refusal would break legitimate recovery
  workflows rather than only an adversarial one.
- `wallet_address`'s `wallet`, `snapshot_now`'s `recipients`, and
  `restore_now`'s `out_dir`-collides-with-an-existing-file case now report
  `ERR_INVALID_INPUT` with a stable `cb_code` (`CB-E019`/`CB-E020`/`CB-E021`)
  instead of falling through to unclassified `ERR_INTERNAL` — the same
  treatment `requireCallerFile()` already gives a missing `file`/`identity`
  path on `verify_restore`/`restore_now`/`estimate_cost`.
