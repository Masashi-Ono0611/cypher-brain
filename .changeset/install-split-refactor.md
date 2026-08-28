---
'cypher-brain': patch
---

Internal: `install()` in `src/lib/schedule.ts` (#508) was a single ~365-line function
mixing five sequential concerns — input validation, environment probing (pg_dump/
gitleaks path resolution), building the resolved `ScheduleConfig`, writing the runner/
plist/cron/config artifacts + registering the launchd/cron trigger + migrating off a
legacy label/marker scheme, and printing the operational summary. Split into
`validateInstallInputs`, `resolveScheduleEnv`, `validateSpendCaps`,
`buildScheduleConfig`, `writeScheduleArtifacts`, `registerTrigger`, and
`printInstallSummary`, called from `install()` in the exact original order. Pure
refactor: every flag, error message, console.error line, and file write is unchanged —
verified against the full `scripts/selftest-schedule.sh` suite (identical PASS output)
and a direct MCP `schedule_install`/`schedule_status` round-trip.
