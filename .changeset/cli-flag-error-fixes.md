---
"cypher-brain": patch
---

Fix two bugs in `src/cli.ts`'s CLI parsing/help found by a Codex audit:

- The "did you mean" message for a mistyped `--flag=value` (this parser only
  accepts the space-separated form) echoed the offending value verbatim,
  including in the JSON error object under `--json`. For `--pg=<connection
  string>`, that connection string can carry a plaintext password
  (`postgresql://user:pass@host/db`), so a typo'd `=` could leak a database
  credential to stderr/stdout logs. `--pg`'s value is now redacted in that
  message; every other flag's message is unchanged.
- `<command> --help`'s scoped help was missing the "Config file:" paragraph
  for every command except `schedule` — a boundary bug in where the shared
  trailer (Config file/Env/Storage/Spend/Consent) was considered to start.
  All commands' scoped help now include the full shared trailer, matching
  the code's own stated intent.
