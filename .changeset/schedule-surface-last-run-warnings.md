---
"cypher-brain": patch
---

A scheduled nightly run's warnings (e.g. "snapshot encrypted to a SINGLE
recipient key — UNRECOVERABLE") no longer vanish after the run — both
`schedule status` and `doctor`'s schedule check now surface at least a WARN
when the last run had warnings, instead of a silent OK/PASS (#432). The
generated `nightly.sh` runner's trailing heartbeat line now records a
warning count (`OK rc=0 warnings=N` / `FAILED rc=N warnings=N`), counted
only from the lines the current invocation itself appended to the dated
log. `ScheduleStatusReport.last_run` gains `warning_count: number | null`
(`null` for a log written by an older runner, before this change, so an
unknown count is never conflated with a genuine zero) — the same shared
object the CLI, the `schedule_status` MCP tool, and the
`cypher-brain://schedule/status` resource all serve.

Known limitation: truly concurrent (not sequential-retry) invocations of
the same runner writing to the same dated log can mis-attribute which
warnings belong to which run. Fixing that would need real mutual exclusion
(`flock` isn't available on macOS by default) or a larger runner redesign,
out of scope for this fix.
