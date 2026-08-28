---
'cypher-brain': patch
---

`restore` no longer silently expands stale/unrelated data as if it were the fresh
snapshot (#527). A pre-existing file at a component's on-disk name (e.g.
`out-dir/srcA.tar.gz`) used to be skipped by the outer extract's no-clobber promise
while the auto-expand step blindly `tar xzf`'d whatever was actually on disk — with
`expanded/README.txt`'s mapping table claiming the result came from the manifest's
recorded source, and exit code 0. `restore` now compares each component archive's
freshly-decrypted bytes against any pre-existing file at that name (read from the
manifest sitting in the just-decrypted archive, not whatever might already be in
`--out-dir`) and refuses the whole restore, naming the colliding path(s), when they
differ — restoring the exact same snapshot into the same `--out-dir` a second time
still reproduces identical bytes and is unaffected. The comparison, and every step
downstream of it, is always keyed off the manifest THIS restore itself just
decrypted — never a manifest.json that might already be sitting in `--out-dir` (a
stale one, left untouched by the same no-clobber promise, used to drive both the
schema check and which components got auto-expanded), and a manifest that names a
component with no backing archive at all (only reachable via a forged/mismatched
manifest) no longer makes a pre-existing same-named file look safe to auto-expand
under that manifest's own recorded source. Separately, a component archive that
fails to expand for any other reason (e.g. it is not actually valid gzip) now makes
the overall restore exit non-zero instead of leaving a partial failure invisible to
a scripted caller's `$?` check.
