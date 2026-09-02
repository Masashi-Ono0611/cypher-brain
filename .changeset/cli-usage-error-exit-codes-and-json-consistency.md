---
"cypher-brain": patch
---

Fixes #779: a mistyped nested sub-verb (`schedule statuz`, `wallet adress`) or an
enum-valued flag's bad value (`--level remtoe`, `--chain tona`, `--backend fille`) used
to exit 1, the same code as a genuine runtime failure — only the two hand-rolled
"unknown command"/"no command" replies exited 2. A new `UsageError` (`src/lib/errors.ts`)
now marks every parser-level refusal (an unrecognized command/flag, a flag a command does
not read, an unrecognized sub-verb, an out-of-range enum value) and `main()`'s single
error handler exits 2 for it — a script can now tell "you invoked this wrong" from a real
failure by exit code alone. The two hand-rolled replies now route through that same
handler too, so `cypher-brain bogus --json` prints a `{error, code, exit_code: 2}` object
instead of nothing (previously only the failure path, not the usage-refusal path, honored
`--json`). `schedule`'s own sub-verb/backend refusals are unchanged in this release.

Fixes #788: `recovery-kit`/`init`/`publish-latest --json` used to be format-by-outcome —
plain prose on success, but a JSON error object on failure, since none of the three ever
implements a JSON success document. All three now refuse `--json` upfront, matching
`push`/`pull`/`restore`/`keygen`/`snapshot`/`wallet address`/`wallet create` (#647, #722).

Fixes #790: `CB-E007`'s pattern (`/spends real funds/`) was broad enough to also match
two "the paid backend's spend cap isn't configured" refusals (`schedule install
--backend ton-provider`, and `push --backend ton-provider`'s own pre-flight check) that
`--yes`/`CYPHER_BRAIN_YES=1` cannot fix — an agent or human reading `code: CB-E007` off
either got the wrong remedy. CB-E007 is now anchored to the exact `--yes`-fixable consent
wording, and a new `CB-E024` covers the two spend-cap-not-configured messages.

Fixes #795: removes a dead branch in `restore.ts`'s `restoreImpl()` that built a
"did you mean --out-dir?" hint for a mistyped `restore --out` — that flag has been
refused upfront by the CLI's flag-relevance check since #277, before `restoreImpl()`
is ever reached, so the branch could never fire. The CLI-level hint (unchanged) is now
the only place that message lives.
