---
'cypher-brain': patch
---

Docs-only sweep of five stale/inaccurate references found during dogfooding:

- README.md's `## Backends` prose no longer contradicts the comparison table on
  ton-provider auto-signing — it now documents `CYPHER_BRAIN_TON_WALLET`'s
  unattended auto-sign path alongside the Tonkeeper-deeplink default (#729).
- README.md documents the previously-undocumented `CYPHER_BRAIN_PULL_RETRY_MS`
  env var next to the other storage-backend env vars (#730).
- README.md's `wallet_create` MCP tool row no longer cites issue #439 as "still
  open as a design decision" — #439 was closed by PR #450, which resolved it by
  documenting the CLI-bootstrap-then-restart path (#757).
- CHANGELOG.md's `[Unreleased] > Added` section now uses the current
  `CYPHER_BRAIN_PIN_RECIPIENTS` spelling instead of the pre-rename
  `CIPHER_BRAIN_PIN_RECIPIENTS`, and correctly describes doctor's overall
  verdict as the 3-way `PASS/PARTIAL/FAIL` (matching `doctor.ts`'s
  `readonly verdict` type), not a 4-way enum that blends it with the separate
  per-check `PASS/WARN/FAIL/SKIP` status set (#758, #759).
- `commitlint.config.js`'s header comment now points at
  `.github/workflows/pr-hygiene.yml`, which actually defines the `commitlint`
  job, instead of `ci.yml`, which does not (#760).
