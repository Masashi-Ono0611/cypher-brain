---
'cypher-brain': patch
---

`schedule uninstall` no longer crashes with an uncaught `ENOENT` if something else
removes an artifact (the launchd plist, cron entry file, runner, or config) in the
narrow window between its `exists()` check and its `rm()` call. Each of the four
`exists()`-then-`rm()` pairs in `uninstall()` now calls `rm(path, { force: true })`,
so a target that is already gone by the time the delete runs is treated the same way
`uninstall` already treats a target that was never there — reported as nothing to
remove, not an unhandled exception. This TOCTOU window is unlikely to be hit in
practice (it requires another process to delete the exact file during that exact
race), but the failure mode when it is hit was a hard crash instead of the graceful,
idempotent behavior `uninstall` is documented and tested to have.
