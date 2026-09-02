---
'cypher-brain': patch
---

Several fixes to error handling and locking, found while auditing docs/behavior consistency
after the recent burst of merges:

- **`push --save-locator`'s lock now recognizes a symlinked path as the SAME lock as its
  target** (#806/#807's advisory lock). Previously only the locator's DIRECTORY was
  resolved through symlinks — a locator path that was itself a symlink to another name
  computed an independent lock key, so two pushes sharing a symlink-aliased
  `--save-locator` (or one held via a live-holder lock under the real path) were not
  recognized as contending for the same file and could both proceed. A hard link to the
  same file, or two spellings that differ only in case on a case-insensitive filesystem,
  still yield two independent locks — documented as a residual limitation rather than
  fixed, since neither can be resolved through the filesystem the way a symlink can.
- **A missing `--flag` value is now a `UsageError` (exit code 2)**, the same class as an
  unknown flag or a mistyped sub-verb, instead of a plain error (exit code 1)
  indistinguishable from a failure that happened while doing real work.
- **`CB-E023` ("--sign-recipient path does not exist") no longer mislabels a missing
  `--sign-recipient` VALUE** as a nonexistent-path problem. Its pattern used to match on
  the `--sign-recipient` prefix alone, which also matched the parser's unrelated
  "--sign-recipient requires a value" error and pointed at the wrong remediation.
- **`schedule install --backend rclone` / `--backend ton`** (both real, documented `push`
  backend names — they are just never schedule-installable, since both need
  operator-side setup a launchd/cron job cannot supply) now get their own distinct
  refusal message instead of being told they are an "unknown backend", which used to
  also mislabel them with the `CB-E013` (invalid `--backend` value) error code.
