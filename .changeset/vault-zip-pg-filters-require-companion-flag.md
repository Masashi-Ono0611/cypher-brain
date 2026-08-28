---
"cypher-brain": patch
---

`snapshot --vault <path>` without `--profile obsidian`, `snapshot --zip <path>`
without `--profile chatgpt-export`, and `--pg-table`/`--pg-filter`/
`--pg-exclude-table-data` without `--pg <conn>` are now refused up front instead
of being silently dropped (#525). Each of these flags is read only by the
specific code path its companion flag enables — given without it, the run used
to exit 0 having archived nothing from that source, with no mention anywhere in
the output or manifest that anything was skipped. This is the same "flag
accepted, never honored" bug class `--export`/`--profile o2b` was already
refused for (#206/PR #334); the new checks (`assertVaultRequiresObsidianProfile`,
`assertZipRequiresChatgptExportProfile`, `assertPgFiltersRequirePg` in
`src/lib/profiles.ts`) follow that exact pattern.

`schedule install` now runs the same checks before writing any runner/plist/cron
artifact (#526) — previously a nightly job installed with a dangling `--vault`/
`--zip`/`--pg-table` would silently skip that source on every unattended run,
forever, invisible in `schedule status`/`doctor`.

Also: the `profile obsidian requires --vault <path>` / `profile chatgpt-export
requires --zip <path>` errors now note when the OTHER (irrelevant) flag was also
given, e.g. `snapshot --profile obsidian --zip <path>` (forgot `--vault`) now
says so instead of leaving the given `--zip` unmentioned (#535).
