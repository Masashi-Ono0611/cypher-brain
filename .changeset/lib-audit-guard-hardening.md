---
'cypher-brain': patch
---

Fixes six correctness/security bugs found in a full-file security audit of
`src/lib/util.ts`, `audit.ts`, `proc.ts`, `ui.ts`, and `ton-dns.ts`:

- `redactPgConn()` no longer leaves a Postgres password in the clear when the
  keyword/value DSN spells it `password = secret` (whitespace around `=`) or
  as an unquoted value containing a backslash-escaped space
  (`password=sec\ ret`) — both are valid libpq conninfo forms the old regex
  did not match.
- `rmrf()`'s permission-unlock fallback (used when a snapshot/restore scratch
  tree lands with a restrictive mode) no longer follows symlinks when
  chmod'ing — it previously could change the mode of an arbitrary file or
  directory a tree-internal symlink pointed at, and now also unlocks a
  directory whose own mode denied read/execute (previously left locked,
  contradicting this function's own documented intent).
- The audit-log's cross-process lock (`withAuditLogLock`) now enforces its
  wait deadline on every retry iteration; a stale lock whose steal attempt
  keeps failing used to bypass the deadline entirely and spin forever.
- `run()` (the shared subprocess helper) no longer lets a throwing
  `onStderrLine` callback crash the whole process as an uncaught exception —
  it now rejects the run instead — and stdout is decoded with the same
  chunk-boundary-safe `StringDecoder` stderr already used, closing a
  mangled-multi-byte-character bug on split UTF-8 output.
- `printJson()` no longer marks a JSON document as "written" before
  `JSON.stringify()` actually succeeds, so a value that throws on
  serialization no longer suppresses the top-level error handler's JSON
  error response.
- `publish-latest`'s tonapi client now rejects a non-object JSON response
  instead of crashing with an uncaught `TypeError`, and its
  `--from-locator-file` existence check now distinguishes "no such file"
  from a real I/O error (e.g. permission denied) instead of collapsing both
  into the same misleading message.

No user-facing behavior changes for the happy path; every fix is either a
previously-unreachable-safely edge case or closes an existing gap between
this code and its own documented intent.
