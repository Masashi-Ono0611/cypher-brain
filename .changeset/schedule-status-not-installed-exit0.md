---
"cypher-brain": patch
---

`cypher-brain schedule status` now exits 0 and reports "not installed"
(rather than a `CB-E014` error) when no schedule has been installed yet —
the same way `doctor` already treats this as an optional, non-fatal state
(`[SKIP]`), and the same way `schedule uninstall`'s own "nothing to remove"
already exits 0. `--json` now returns `{"installed":false}` in that case,
and `{"installed":true, ...}` (the same fields as before, plus the new
`installed` field) when a schedule exists — a script that wants to know
"is a schedule installed?" can now read one field instead of catching an
error. Any OTHER failure reading the schedule (a corrupt `schedule.json`,
a `crontab`/`launchctl` call that itself errored) still propagates as an
error exactly as before — only the specific "nothing installed" case is
downgraded.
