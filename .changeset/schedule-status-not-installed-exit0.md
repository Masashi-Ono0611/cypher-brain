---
"cypher-brain": patch
---

`cypher-brain schedule status` now exits 0 and reports "not installed"
(rather than a `CB-E014` error) when no schedule has been installed yet —
the same way `doctor` already treats this as an optional, non-fatal state
(`[SKIP]`), and the same way `schedule uninstall`'s own "nothing to remove"
already exits 0. `--json` now returns `{"installed":false}` in that case.
An installed schedule's `--json` output (CLI, the `schedule_status` MCP
tool, and the `cypher-brain://schedule/status` resource all serve the same
object) now always carries `"installed":true` too, so a caller can branch
on that one field regardless of which shape it got back, instead of
catching an error. Any OTHER failure reading the schedule (a corrupt
`schedule.json`, a `crontab`/`launchctl` call that itself errored) still
propagates as an error exactly as before — only the specific "nothing
installed" case is downgraded.
