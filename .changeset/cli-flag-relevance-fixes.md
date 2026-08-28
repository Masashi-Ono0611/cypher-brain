---
'cypher-brain': patch
---

Three CLI flag-handling inconsistencies found by an agentic audit of `src/cli.ts`:

- `restore --sha256 <hex>` was accepted but never actually checked (#645) —
  `restoreImpl()` never read `o.sha256` back, so a rollback/substitution attack that
  swapped in a different, still-validly-encrypted, still-correctly-signed ciphertext at
  the same `--in` path restored anyway. It is now checked right after the file is
  confirmed to exist, before authenticity and any decryption — a mismatch refuses the
  restore outright, the same fail-closed contract `pull --sha256` and `verify --sha256`
  already had.
- `estimate --json --out` could print a success-shaped `CostEstimate` JSON object on
  stdout and then still exit 1 if the plan-file write failed afterwards (e.g. an
  existing plan file without `--force`) — a script parsing `--json` output by "did I get
  valid JSON" rather than the exit code would misread the failure as success (#646).
  Every plan-file check now runs BEFORE the report is printed, so the documented
  `{error, code, exit_code}` object reaches stdout on failure instead.
- `push`, `pull`, and `wallet address` accepted `--json` without ever implementing a
  JSON success path — `push` printed a bare locator string, `pull` printed nothing on
  success, and `wallet address` always printed a bare address string, while the
  top-level error handler still treated `--json` as a request for JSON-shaped error
  output on failure (#647). All three now refuse `--json` upfront via the CLI's
  flag-relevance deny-list, the same "clear error" that `restore --out` already gets —
  `wallet balance --json`, which genuinely implements JSON output, is unaffected.
