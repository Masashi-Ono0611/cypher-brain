---
'cypher-brain': patch
---

Six small fixes to `estimate`/plan validation found during a code-quality audit and a
dogfooding pass, all touching `src/lib/estimate.ts` and/or `src/lib/plan.ts`:

- **#469** — `push --plan`'s `validatePlan()` now actually re-checks `recipients_fingerprint`
  against the `"<in>.recipients-fingerprint"` sidecar re-read fresh at push time. The field
  was recorded in every `plan.json` (specifically to detect a changed recipient set — a
  recovery key added or removed) but was write-only: a hand-edited or stale recorded value
  went completely unchecked, masked in practice only because re-snapshotting also changes
  `artifact_sha256`. Refuses (never warns) on any mismatch, following the same
  both-null-is-fine / any-other-combination-refuses convention `payer_address` already uses.
- **#501** — `estimate.ts`'s `estimateCostFor()` had its own hardcoded backend-name array
  (plus copies of the same pipe-joined string in two error/usage messages), duplicating the
  canonical set `backends/index.ts`'s `BACKEND_FACTORIES` exists specifically to centralize
  (after #435 caused this exact class of drift once already). A new SDK-free
  `STORAGE_BACKEND_NAMES` const in `types.ts` is now the single source both files read from.
- **#470** — `estimate --out` now refuses to silently overwrite an existing plan file,
  matching `snapshot --out`'s no-clobber posture (and reusing the same `already exists —
  refusing to overwrite` wording, so it picks up the existing CB-E009 error code). `--force`
  overwrites anyway.
- **#471** — An unsupported/future plan-schema version (`cypher_brain_plan_version` != 1) now
  gets its own `unsupported plan version N (expected 1)` message instead of the same generic
  "does not look like a cypher-brain plan file" text truly malformed input produces.
- **#472** — `wallet create`'s printed guidance no longer implies `CYPHER_BRAIN_AR_WALLET`
  must always be exported. `push`/`estimate`/`wallet address`/`wallet balance` already fall
  back to `$CYPHER_BRAIN_HOME/wallet.json` (the default `wallet create` path) when it is
  unset — the message (and the `--help` Env section) now says so, and only tells the operator
  to set the variable when `--out` actually moved the wallet somewhere else.
- **#481** — `estimate --backend ton`'s note no longer leaks its own internal source file
  path (`src/lib/backends/ton.ts`) into human and `--json` output — the latter also reaches
  MCP `estimate_cost` callers. No other backend's note referenced its own source file.
