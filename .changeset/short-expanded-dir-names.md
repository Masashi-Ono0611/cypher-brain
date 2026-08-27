---
"cypher-brain": patch
---

`restore`'s auto-expanded component directories under `expanded/` are now short
and readable — `expanded/001-memory-a3f9c1e2b7d4f012/` instead of a
100+-character encoded copy of the full absolute source path (#423). The
numeric `<NNN>` index still guarantees two components from the same restore
never land in the same directory (#181); a 16-hex-char digest of the full
source path (SHA-256, truncated) is now appended too, so a collision between
two DIFFERENT sources sharing a basename — even across two SEPARATE restores
into the same `--out-dir`, where nothing ties their manifests' component
order together — is kept practically negligible (a truncated hash is never
an absolute guarantee, and `source` is attacker-controlled data, so the
digest is sized accordingly rather than claiming more than it can back up).
The full original absolute source path is still recorded, unambiguously, in
`expanded/README.txt`'s mapping table (and on restore's own stdout), same as
before.

This changes the on-disk directory-naming FORMAT of a restore's `expanded/`
output — not a breaking change to any programmatic contract (the
`manifest.json` schema, `--pg` flow, and `expanded/README.txt`'s columns are
all unchanged), but a script that greps `expanded/` for the old long encoded
names would need updating to match the new short `<NNN>-<basename>-<digest>`
form.
