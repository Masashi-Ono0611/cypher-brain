---
'cypher-brain': patch
---

Three fixes to how snapshot and restore handle their own scratch trees and output
sidecars, from a security audit of the plaintext-cleanup and no-clobber paths.

**Restrictive source permissions no longer strand plaintext in `$TMPDIR` (#782).** A
source directory with no owner-write bit — mode `0500`, say — is recreated with that mode
inside snapshot's staging tree, and removing entries under it needs write on the *parent*
directory. The plain recursive remove that cleaned it up threw `EACCES`, so `snapshot`
failed outright *and* left the staged plaintext on disk indefinitely. The same applies to
restoring an archive that contains such a directory into an `--out-dir` that already has
content: the merge could not move it and the decrypted scratch tree survived. Every
plaintext-scratch cleanup now uses the chmod-and-retry removal the project already had, and
a directory's recorded mode is applied to the restored copy instead of blocking the restore.

**Snapshot sidecars are no-clobber, like `--out` itself (#783).** `<out>.digest`,
`<out>.recipients-fingerprint` and `<out>.minisig` were plain truncating writes with no
check at all. A symlink planted at one of them was followed, truncating whatever it pointed
at, with the run still reporting success. Worse, a `.minisig` left over from a *different*
artifact survived a run that did not sign — and `restore`/`verify` then refused the new,
perfectly good snapshot as tampered or forged, permanently. All three paths are now refused
up front (`CB-E009`, symlinks included) and written with an exclusive create. **If you
reuse an output name, clear its old sidecars along with the old `*.age`** — a run that
previously overwrote them silently now refuses and names the file in the way.

**Restore's merge cannot overwrite a destination that appears mid-merge (#784).** Merging
into an existing `--out-dir` checked each name with `lstat` and then moved onto it with
`rename`, which silently replaces an existing destination — so a file created in that
window was destroyed. Each entry kind now moves with a primitive that refuses an occupied
destination outright.
