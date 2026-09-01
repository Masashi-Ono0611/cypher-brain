---
'cypher-brain': patch
---

Hardens the passphrase-prompt and `--json` output paths against a downstream reader or
signal cutting a command off mid-write:

- `printJson()` (src/lib/ui.ts) now installs the same no-op EPIPE `'error'` guard on
  `process.stdout` it already had on `process.stderr` — a `--json` document (e.g.
  `ledger --json`, `audit --json`) piped to an early-closing consumer no longer crashes
  the process with an uncaught `write EPIPE` (#737).
- `promptHidden()` (src/lib/crypt.ts, backing `keygen --passphrase`/`restore`/`verify`)
  now restores the terminal's raw mode even when the process is torn down by
  SIGTERM/SIGHUP mid-prompt, or when stdin itself ends/closes/errors — previously
  restoration was only reachable from the normal Enter/Ctrl-C data path (#738).
- The same interactivity check in `promptHidden()` now requires `process.stderr` (where
  the prompt actually renders) to be a TTY, not just stdin — a redirected/piped stderr
  with an interactive stdin used to enter raw mode and wait on a prompt the user could
  never see (#739).
- `wizard.ts`'s `@clack/prompts` calls (`init`'s text/confirm/select prompts) share the
  same signal-driven raw-mode + cursor restoration as `promptHidden()` above, closing
  the same SIGTERM/SIGHUP-mid-prompt gap for `init` (#740).

Fixes #737, #738, #739, #740.
