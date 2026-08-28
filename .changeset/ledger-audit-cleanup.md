---
'cypher-brain': patch
---

Four fixes to `receipt.ts`/`audit.ts`/`ledger.ts`, all found during a dogfooding/
code-quality pass:

- **#484**: `push --backend ton-provider` now writes a receipt, same as `arweave`/
  `turbo`. `ledger`'s cumulative-cost tracking was arweave/turbo-only despite
  ton-provider being a real paid backend with its own `CYPHER_BRAIN_TON_PROVIDER_
  MAX_SPEND` cap — `doctor`/`audit`/`estimate`/`schedule install|status|uninstall`
  already treated ton-provider on par with the other backends; `ledger` was the one
  place it diverged. The receipt records the deploy amount actually locked into the
  confirmed on-chain transfer (storage cost + deploy buffer) in a new `nanoton` unit,
  authoritative the same way arweave's signed transaction reward is (not a pre-flight
  estimate like turbo's).
- **#460**: `ledger --backend <name>` and `audit --level <depth>` are now refused as
  unread flags (`does not read --backend`/`does not read --level`), instead of running
  normally and silently ignoring them — both flags belong to sibling commands
  (push/pull/restore/estimate's `--backend`, verify's `--level`) and a user reaching
  for them on `ledger`/`audit` got no indication the flag did nothing.
- **#459**: `ledger --help` now documents that every receipt line — CLI-written or
  hand-authored/migrated — must carry a top-level `cypher_brain_receipt_version` field,
  matching this build's version; a line missing it is rejected as unreadable, same as
  malformed JSON.
- **#503**: `receipt.ts`'s `readReceipts()` and `audit.ts`'s `readAuditLog()` shared
  near-identical JSONL-log-reading boilerplate (read → ENOENT-means-empty → other-errors-
  throw → split lines → skip blanks → parse-with-skippedLines → shape-validate). Factored
  the ~15 lines of scaffolding out into a new `readJsonlLog()` helper in `util.ts`, with
  each module supplying its own (deliberately different) per-entry shape validator —
  internal refactor, no behavior change.
