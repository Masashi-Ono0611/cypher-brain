---
"cypher-brain": patch
---

`CHANGELOG.md`'s `[Unreleased]` section is a hand-written summary (its own
header says so) meant to stand in for `changeset version` until the first
tagged release, but its `Added` list had drifted far behind what actually
shipped: the `doctor`/`ledger`/`audit` CLI commands, `keygen --sign` and
`keygen --pq`, the `rclone` backend, `did-you-mean` typo suggestions,
OpenTelemetry tracing, `config.env`, `verify --level`, `.cypherbrainignore`,
`--pg-filter`/`--pg-exclude-table-data` minimal-recovery snapshots,
`recovery-kit`, and `publish-latest` were all missing (#579). The `ton`/
`ton-provider` backends were mentioned only in passing in `Changed`, never
listed in `Added`. Added a bullet for each, verified against `--help` output
and source. No code changes.
