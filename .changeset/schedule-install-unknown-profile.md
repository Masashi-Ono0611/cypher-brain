---
"cypher-brain": patch
---

`schedule install --profile <typo>` no longer installs a nightly job that
would fail from the very first unattended run. `install()` never called
`resolveProfilePaths()` itself, so an unknown `--profile` name sailed
straight past every check and got baked verbatim into the generated
runner's `snapshot --profile '<typo>' ...` line — `install` exited 0,
printed "runner written"/"launchd plist written", and the nightly then
failed every night, silently, since nobody watches unattended job logs.
`snapshot --profile <typo>` (no schedule) already refused this the same
day it was typed.

`schedule install` now validates `--profile` against the known profile
list (`profiles.ts`'s new `assertKnownProfile()`, also used by
`resolveProfilePaths()` so both surfaces refuse with the identical
message) before writing the runner script, plist/cron entry, or
`schedule.json` — same fail-closed shape as the existing
`--export`-requires-`--profile o2b` and `--scan-secrets`-mode checks.
The refusal also offers a did-you-mean suggestion (e.g. `--profile
claude-cod` → `did you mean claude-code?`), reusing the existing
`nearestName()`/`didYouMean()` idiom the rest of the CLI already applies
to unknown flags/commands/backends.
