---
'cypher-brain': patch
---

Docs: `schedule install`'s `--index-file <path>` flag was listed in `--help`'s
synopsis but never explained in its body, README.md's mirror, or
MANAGEMENT.md's "Cadence" section (#699). `--help`'s `schedule install` body
now documents its purpose (overrides where the generated nightly runner
appends its index.tsv line) and default (`$CYPHER_BRAIN_HOME/schedule/index.tsv`).
README.md is regenerated from the same HELP text via `check:help-docs`.
MANAGEMENT.md's Cadence section now mentions the override next to the
`index.tsv` append it already walks through.
