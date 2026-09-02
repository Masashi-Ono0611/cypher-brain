---
"cypher-brain": patch
---

Fixes #831: two parser-level refusals in `parseArgs()` (a command that takes no bare
positional, e.g. `doctor foo`; a `POSITIONAL_COMMANDS` command given more than one
sub-command word, e.g. `schedule install status`) still threw a plain `Error` and exited
1, the one gap #814's `UsageError` sweep missed — both now exit 2, and `--json` reports
`exit_code: 2` for them like every other parser-level refusal.

Fixes #833: `doctor` never checked #820's MCP snapshot policy — an operator running
`cypher-brain-mcp` for the first time could see a clean `doctor` report and still have
every `snapshot_now` call refused with `CB-E025` the moment they tried it. A new
`mcp-snapshot-policy` check WARNs (never FAIL — a CLI-only setup is fine) once an identity
exists and either `CYPHER_BRAIN_PIN_RECIPIENTS` or `CYPHER_BRAIN_MCP_SOURCE_ROOTS` is
missing or malformed, and validates the configured roots actually exist on disk once both
are set.

Fixes #834: the `init` wizard suggested a `CYPHER_BRAIN_PIN_RECIPIENTS` line but never
mentioned its MCP-only sibling, `CYPHER_BRAIN_MCP_SOURCE_ROOTS`. The wizard now also
suggests a JSON-array line naming the directories just chosen to back up, clearly labelled
as only needed for the MCP server.

Fixes #835: `keygen --force`/`keygen --sign --force`'s unconditional identity backups
(`<original>.bak-<timestamp>-<random>`, #786) accumulated on disk with no visibility.
`doctor`'s new `identity-backup-accumulation` check WARNs once at least one exists, naming
the count, the oldest one's date, and the exact condition under which it is safe to
delete; MANAGEMENT.md gained a matching "Cleaning up identity backups" section.
