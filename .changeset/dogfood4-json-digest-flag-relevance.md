---
'cypher-brain': patch
---

Two more CLI flag-handling inconsistencies found by dogfooding round 4:

- `restore`, `keygen`, `snapshot`, and `wallet create` accepted `--json` without ever
  implementing a JSON success path — each printed plain text on success while the
  top-level error handler still treated `--json` as a request for JSON-shaped error
  output on failure (#722). Same bug class `push`/`pull`/`wallet address` had (#647) —
  the fix's deny-list was never extended to these four sibling commands. All four now
  refuse `--json` upfront via the CLI's flag-relevance deny-list, the same "clear
  error" `push`/`pull`/`wallet address` already get; `wallet balance --json`, which
  genuinely implements JSON output, is unaffected.
- `push --digest <hex>` given without `--save-locator` parsed fine and was then
  silently dropped — both of its readers (the `--skip-unchanged` comparison, and the
  content_digest this push records for a *later* `--skip-unchanged` run to compare
  against) require `--save-locator` (#723). Refused upfront via a dedicated guard
  (the same "flag accepted, never honored" shape `--remote`'s own `--backend rclone`
  requirement already refuses), rather than through the flag-relevance table:
  `--digest --save-locator` *without* `--skip-unchanged` is a real, working
  invocation — it seeds the recorded digest for a future `--skip-unchanged` run on a
  push that has no previous locator to compare against yet — so the guard requires
  `--save-locator` specifically, not `--skip-unchanged`, to avoid refusing that
  working case.
