---
'cypher-brain': patch
---

Fixes two issues left for human judgment in a prior security audit
(`src/lib/audit.ts`, `scripts/dev-shim-reexec.mjs`):

- The hash-chain audit trail (`push`/`restore`/`verify`) no longer records an
  artifact digest by reopening `--in` by path after the command has already
  fully settled — `recordAudit()` now requires the caller to pass through a
  digest it already computed from its own read of the artifact. `restore`
  and `verify` reuse the same baseline digest their existing pinned-
  descriptor read already produces; `push` now reads the digest immediately
  before the actual upload (`backend.put()`), narrowing (though not fully
  closing — see `pushCoreLocked`'s own comment) the previous window, which
  used to span the entire upload, a paid backend's network price query, and
  the consent gate. A `--level quick` verify without `--sha256` now
  correctly records no digest at all, rather than one from an unrelated
  reopen, since forcing one would cost an unconditional extra full-file
  read.
- The dev-mode shim's (`bin/cypher-brain.mjs`/`bin/cypher-brain-mcp.mjs`)
  `ERR_MODULE_NOT_FOUND` re-exec trigger is narrowed to the one scenario it
  exists for (the top-level entrypoint import itself needing the dev
  TS-resolve loader), instead of firing on any `ERR_MODULE_NOT_FOUND` —
  including one from a genuinely unrelated missing import several layers
  deep in `src/cli.ts`/`src/mcp.ts`, which used to trigger a pointless extra
  re-exec attempt before the real error finally surfaced.
