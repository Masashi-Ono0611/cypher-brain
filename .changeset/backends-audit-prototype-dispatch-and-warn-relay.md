---
"cypher-brain": patch
---

Two narrow fixes from a full-file security/quality audit of `src/lib/backends/`
(the storage backend implementations):

- `backendFor()` (`src/lib/backends/index.ts`) resolved `--backend` names
  through a bare `BACKEND_FACTORIES[name]` index. Since `BACKEND_FACTORIES`
  is a plain object, a name like `constructor`, `toString`, or
  `hasOwnProperty` resolved an `Object.prototype` member instead of
  `undefined` — silently "succeeding" with a non-functional object (for
  `constructor`, `factory()` returns `{}`, later failing with a confusing
  internal `TypeError` instead of this function's own clean "unknown
  backend" error) or throwing an unrelated `TypeError` (for
  `hasOwnProperty`). Now guarded with `Object.hasOwn()`, the same pattern
  already used for identical untrusted-name lookups in `mcp.ts` and
  `cli.ts`.
- The `ton` backend's seeder-fallback caveat ("P2P fetch failed... falling
  back to a direct copy from the seeder. P2P availability of this bag is
  NOT proven by this pull") was written with a raw `console.error`
  instead of `warn()`. Per `warn.ts`'s own contract (#347), only `warn()`
  is recorded into the CLI's end-of-run summary and an MCP tool result's
  `warnings[]` array — a raw `console.error` prints identically to a
  human terminal but is invisible to an agent relaying the run, exactly
  the failure mode #347 exists to close. `ton-provider.ts`/`arweave.ts`/
  `turbo.ts` already route their own safety-relevant caveats through
  `warn()`; `ton.ts` now matches.

Both are narrowly-scoped, behavior-preserving fixes (verified with
`bun run typecheck`, `bun run lint`, and the `storage`/`ton`/`ton-provider`/
`ton-dns`/`error-codes` selftests). Several higher-risk findings from the
same audit (rclone connection-string command injection, arweave/turbo
receipt-callback partial-success semantics, ton/ton-provider concurrent-push
races, and others) were deliberately left for human review — see the PR
description.
