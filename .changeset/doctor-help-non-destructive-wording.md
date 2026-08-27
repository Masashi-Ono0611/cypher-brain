---
"cypher-brain": patch
---

`doctor --help`'s opening line now calls `doctor` "non-destructive" instead of
"read-only". `doctor` writes `$CYPHER_BRAIN_HOME/doctor-state.json` (check ids
and timestamps only) to track check history between runs — a fact the rest of
the same `--help` text already documented further down — so "read-only" was a
stronger promise than the command actually keeps. `doctor` still touches no
keys, config, or snapshots. Behavior is unchanged; only the opening wording
and the regenerated README.md CLI reference moved (#438).
