---
"cypher-brain": patch
---

`restore` now refuses a manifest.json declaring a `schema` newer than this
build understands, instead of silently expanding components against a shape
it was never taught to read (#225). Arweave storage is meant to outlive any
one build of this tool, so a future format change should fail loudly
("upgrade cypher-brain before restoring this snapshot") rather than have an
old binary guess at a changed/renamed field. `snapshot` now stamps
`manifest.json`'s `schema` field from a single `MANIFEST_SCHEMA_VERSION`
constant instead of a hand-typed literal, so the writer and the forward-compat
check in restore can never drift apart. No change for any existing (schema 1)
snapshot — restoring one is unaffected.
