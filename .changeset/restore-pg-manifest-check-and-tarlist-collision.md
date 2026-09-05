---
"cypher-brain": patch
---

`restore --pg` now refuses to `pg_restore` a `db.dump` in `--out-dir` unless the
current snapshot's own manifest actually declares a pg component. A `db.dump` left
behind by an unrelated prior run (preserved by `--out-dir`'s no-clobber promise) used
to be restored into the target database with no warning; it is now a hard refusal that
explains the manifest/pg-component mismatch, before `pg_restore` ever runs (#859).

`snapshot`'s internal tar-list scratch filename (`.tarlist-<name>`) is now
collision-proof: it folds in the process id and a random suffix instead of being
derived solely from the component's own name. A `--dir`/`--profile` source whose
basename happened to collide with that literal (e.g. `.tarlist-<other component's
name>`) could silently clobber and then delete another component's already-finished
archive during staging, dropping it from the snapshot with no error (#860).
