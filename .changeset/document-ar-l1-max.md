---
'cypher-brain': patch
---

Docs: `--help`'s Storage section now lists `CYPHER_BRAIN_AR_L1_MAX` alongside
the other `CYPHER_BRAIN_AR_*` settings, documenting its default (10485760
bytes ≈ 10 MiB) and that `schedule install` bakes it into the generated
nightly runner like the other AR_* settings (#698). It was a real,
behavior-changing tunable (arweave.ts's raw-L1 size-limit error tells users to
set it) that was previously undocumented anywhere. README.md's CLI reference
is regenerated from the same HELP text via `check:help-docs`.
