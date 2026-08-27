---
"cypher-brain": patch
---

`restore`'s auto-expanded component directories under `expanded/` are now short
and readable — `expanded/001-memory/` instead of a 100+-character encoded copy
of the full absolute source path (#423). The numeric `<NNN>` index alone
already guaranteed two components never land in the same directory (#181), so
the directory NAME no longer also needs to carry the full path; the full
original absolute source path is still recorded, unambiguously, in
`expanded/README.txt`'s mapping table (and on restore's own stdout), same as
before.

This changes the on-disk directory-naming FORMAT of a restore's `expanded/`
output — not a breaking change to any programmatic contract (the
`manifest.json` schema, `--pg` flow, and `expanded/README.txt`'s columns are
all unchanged), but a script that greps `expanded/` for the old long encoded
names would need updating to match the new short `<NNN>-<basename>` form.
