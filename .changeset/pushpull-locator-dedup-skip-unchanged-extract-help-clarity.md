---
"cypher-brain": patch
---

Fixes #502: `pull()`'s `--from-locator-file` handling reimplemented the same
read-file/find-first-non-comment-line/split-on-tab parsing that
`readSavedLocatorLine()` already provides (used by `push --skip-unchanged`), instead
of calling it. Now reuses the shared parser; the distinct "no such locator file"
(missing file) and "must contain ..." (malformed line) error messages are unchanged.

Fixes #510: `pushCore`'s self-contained `--skip-unchanged` three-signal comparison
(content digest / recipients fingerprint / signing state) is now its own
`resolveSkipUnchanged()` function instead of being inlined at the top of `pushCore`.
Pure extraction — the comparison logic, its ordering relative to the rest of
`pushCore`'s safety gates, and all observable behavior are unchanged.

Fixes #466: `pull --help` now documents that an explicit `--locator`/`--backend`
silently overrides the value recorded in a `--from-locator-file`, including when the
two conflict, rather than only being described as a self-contained alternative.

Fixes #467: `push --help`'s authenticity section now points to `snapshot --help` for
how to enable signing (`keygen --sign` + `--no-sign`) — previously `push --help` had
no pointer to how signing is turned on for what is about to be pushed.

No behavior change: `npm run build`, `npm run typecheck`, `npm run lint`, and the
pushpull.ts-covering selftests (`selftest:storage`, `selftest:recovery`,
`selftest:recovery-kit`, `selftest:minisign`, `selftest:push-partial-failure`,
`selftest:plan`, and `scripts/selftest-help-docs.sh`) all pass unchanged.
