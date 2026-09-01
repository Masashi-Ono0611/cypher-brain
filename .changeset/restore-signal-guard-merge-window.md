---
'cypher-brain': patch
---

Fixes three signal-safety/UX gaps found during dogfooding round 4:

- `restore`'s signal guard now keeps tracking the plaintext scratch directory through
  the ENTIRE promotion step (`rename()` into a fresh `--out-dir`, or `mergeNoClobber()`
  into a pre-existing one), not just through decrypt+extract. Previously
  `setActiveRestoreScratchDir(null)` ran before `mergeNoClobber()` started, so a
  SIGTERM/SIGINT landing mid-merge left the sibling `${out}.restore-*` scratch
  directory — still full of decrypted plaintext — on disk forever, untracked by either
  guard (#721).
- The signal handler's own INCOMPLETE-sentinel write (dropped into a pre-existing
  `--out-dir` it cannot safely delete) now `lstat`s the target path first and skips the
  write unless it is an ordinary file or does not exist yet. Previously
  `writeFileSync()` could block forever opening a FIFO planted at that exact path (no
  reader ever attaches), wedging the signal handler and every cleanup step after it —
  SIGKILL was the only way out (#741).
- `verify --level quick`'s `level: quick` stdout line now prints only after `--in` has
  been checked for presence and existence, matching every sibling command's contract of
  printing nothing to stdout on a basic usage/argument error (#745).

New selftest coverage (`scripts/selftest-recovery.sh`, `scripts/selftest-verify-levels.sh`):
a SIGTERM sent mid-merge (many `--dir` sources, forced through the
pre-existing-`--out-dir` `mergeNoClobber()` path) now asserts no scratch dir is left
behind and the INCOMPLETE sentinel lands; the same setup with a FIFO pre-planted at the
sentinel path asserts the signal handler exits promptly (not hung) and leaves the FIFO
untouched; and `verify` with a missing/nonexistent `--in` asserts stdout stays empty.
All three reproduce their bug against the pre-fix code and pass against the fix.
