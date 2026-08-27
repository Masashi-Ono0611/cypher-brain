---
'cypher-brain': patch
---

The MCP `schedule_status` tool now reports a specific `ERR_NOT_CONFIGURED` code when
called against a `CYPHER_BRAIN_HOME` with no schedule installed, instead of the generic
`ERR_INTERNAL` every unrelated failure falls back to (#440, a follow-up to #426).

`ScheduleNotInstalledError` (CB-E014) is already a real, `instanceof`-checkable
exception `doctor.ts`'s own [SKIP] handling and, post-#426, the CLI's `schedule status`
both treat as an expected, non-fatal precondition rather than a real failure — the MCP
tool was the one caller left funneling it into the same bucket as an actual internal
bug, leaving a client that branches on error codes no way to tell "nothing is
configured yet, go run schedule_install" from "the server is broken" without matching
on the inner message text.

This is a minimal fix to the error CODE only — the tool still errors (unlike the CLI's
`--json`, which now returns `{"installed":false}` with exit 0). The
`cypher-brain://schedule/status` resource serves the exact same `scheduleStatusReport()`
call and is documented to error when nothing is installed; matching that instead of
making the tool and the resource disagree on this one call was the smaller, safer
change. Any OTHER failure reading an existing schedule (a corrupt `schedule.json`, a
crontab/launchctl call that itself errored) still reports `ERR_INTERNAL`, unchanged.
