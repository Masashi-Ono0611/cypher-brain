---
"cypher-brain": patch
---

Fixes #677: `pull --remote <name>:<path>` used to be silently dropped for any
`--backend` other than `rclone` (only `rclone`'s own locator shortcut consumed it) —
the same "flag accepted, never honored, no signal" bug class #655 fixed for `push`.
`pull` now reuses `push`'s own refusal (`assertRemoteRequiresRcloneBackend()`) and
refuses up front with an actionable error instead of silently ignoring `--remote`.
`--help` text is updated to document the refusal, mirroring `push`'s own wording.
