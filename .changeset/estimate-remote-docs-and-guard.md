---
"cypher-brain": patch
---

`estimate --help` (#468): documented `--remote <name>:<path>` — accepted by
`estimate --out` for the `--backend rclone` case (mirroring `push`/`pull`'s
own `--remote` flag) but never listed in `--help`, so a reader had no way to
discover it from documented usage alone. Also: `estimate --out --backend
rclone` now REFUSES up front when `--remote` is missing, instead of quietly
writing a plan with `remote: null` — such a plan can never validate against
`push --plan` (which always compares against a real `--remote` for that
backend), so it used to fail later, mid-push, with a "re-run estimate --out"
suggestion the reader had no documented way to act on.
