---
'cypher-brain': patch
---

Six small `src/lib/` quality fixes from a dogfooding audit pass (#612-#617), all
maintainability/defense-in-depth with no user-facing behavior change beyond stricter
refusals:

- `idempotency.ts`'s `readAllRecords()` is now built on `util.ts`'s shared
  `readJsonlLog<T>()` instead of a third independent hand-rolled copy of the same
  read/parse/validate skeleton (#612).
- `crypt.ts`'s `encryptToFile`/`decryptToChild` now share a single `runChildPipeline()`
  helper for their ~70 lines of duplicated child-process pipeline state machine
  (ACTIVE_CHILDREN registration, timeout, SIGTERM→SIGKILL escalation, reject-after-death)
  instead of each hand-rolling its own copy (#613).
- `buildinfo.ts`'s `fromGit()` now applies the same "genuinely the source file it claims
  to be" guard `runbook.ts` already uses, so a bundled `dist/mcp.mjs`'s relative path
  resolution can never walk up and report an unrelated parent git tree's commit as this
  tool's own build provenance (#614).
- `minisign.ts`'s `loadSignIdentity()` now wraps a malformed PEM block's `createPrivateKey`
  failure with the same `${path}: ...`-prefixed error convention every other failure mode
  in that function already uses, instead of leaking a raw Node/OpenSSL error (#615).
- `plan.ts`'s `readPlanFile()` now refuses (rather than silently coercing to `null`) a
  wrongly-typed `recipients_fingerprint`/`payer_address`/`remote` field, matching the
  "refuses outright rather than silently proceeding" philosophy the file's required
  fields already follow (#616).
- `idempotency.ts`'s lock-wait timeout (`LOCK_MAX_WAIT_MS`) is now comfortably larger
  than its own staleness threshold (`LOCK_STALE_MS`), so a waiter racing a
  merely-slow-but-alive lock holder always gets a chance to detect and steal a
  genuinely stale lock before giving up (#617).
