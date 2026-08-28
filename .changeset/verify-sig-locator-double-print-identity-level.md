---
'cypher-brain': patch
---

Four `verify --level` fixes found during dogfooding (2026-08-28, 3rd round):

- **#528 (P1, security-relevant)**: `verify --level remote/drill --sig-locator <id>
  --require-signature` silently dropped `--sig-locator` — the internal `pull()` call
  built its own `CliOptions` object literal without `sig_locator`, so the `.minisig`
  sidecar was never fetched. A user relying on bare `--locator`/`--backend` +
  `--sig-locator` (the exact pattern `pull --sig-locator` documents) got a
  false-negative `VERDICT: FAIL` on a signature that was actually valid and fetchable.
  `--level quick` now also refuses `--sig-locator` (it never fetches anything), same as
  `--locator`/`--backend`/`--from-locator-file` already were.
- **#530**: `verify --level drill` printed the same signature-check result twice — once
  from verify's own check, once again from drill's internal `restoreImpl()` call
  independently re-verifying. `restoreImpl()` now skips (and does not re-print) that
  check when told the caller already ran it, which only `verify --level drill`'s
  internal call ever does.
- **#531**: an explicitly-given `--identity <path>` that does not exist was silently
  treated the same as "no `--identity` given and no default identity found either" —
  `[SKIP]` + `VERDICT: PARTIAL`, masking a typo as an expected public-key-only-box
  result. An explicit nonexistent `--identity` path is now a hard error (`no identity at
  … — cannot decrypt without the private key`, CB-E015), matching `restore
  --identity`'s existing behavior; the legitimate PARTIAL when `--identity` is omitted
  entirely is unchanged.
- **#536**: `verify --level quick --json` output had no `"level"` key, unlike
  `remote`/`drill`. `quick` now includes `"level":"quick"` in `--json`, and its
  plain-text output starts with a `level: quick` first line, matching `remote`'s/
  `drill`'s own first line.
