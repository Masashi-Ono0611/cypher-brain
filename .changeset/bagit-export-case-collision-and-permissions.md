---
'cypher-brain': minor
---

`bagit-export` now refuses upfront (#943) when two `--from-restored-dir` filenames
would collapse onto the same path on a case-insensitive or
Unicode-normalization-insensitive destination filesystem (the default on macOS/APFS) —
naming both conflicting files. Without this, `copyFile()`'s default overwrite silently
dropped one file's content, and since `manifest-sha256.txt` is built by re-listing
`data/` AFTER all copies finish, the bag reported success with a passing checksum and
zero indication anything went missing. The check is a pure comparison on the source
filenames (lowercased, THEN NFC-normalized — that order matters for some
decomposed-uppercase forms, see `findNormalizedNameCollisions()`'s own doc comment),
not a runtime probe of `--out-dir`'s actual filesystem — filesystem-independent, and
correct regardless of what `--out-dir` turns out to be. **Narrow breaking change**: an
invocation whose `--from-restored-dir` happens to contain two such filenames, which
previously "succeeded" by silently losing one of them, now refuses instead. This is a
simple case-fold, not full Unicode case-folding — a handful of context-sensitive
special-casing pairs (e.g. Greek "Σ"/final-form "ς") are a known, documented residual,
same posture as this file's existing `pathsOverlap()` symlink residual.

`bagit-export`'s staging directory and its `data/` subdirectory (#944) are now created
mode `0700` instead of inheriting the process umask (typically `0755`) — this staging
tree briefly holds a full plaintext copy of the restored payload, and a permissive
umask previously exposed it to other local users even when the source directory was
deliberately locked down to `0700`. The published `--out-dir` inherits this mode via
`rename()`, which preserves a directory's own permissions across the publish step.
