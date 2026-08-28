---
'cypher-brain': patch
---

Fix five operator-facing UX issues in `scripts/go/storage-v1-client` (the standalone
Go client for the live TON Storage StorageV1 provider market), found via dogfooding:

- `update-providers`/`withdraw` now run their local, network-free input validation
  (the `--gas-ton`/`--max-spend-ton` guard, `--span-days` overflow check, and the
  `withdraw` address cross-check) BEFORE the tonapi account-state lookup, so a typo
  in those flags fails fast instead of paying for a round trip and surfacing a
  misleading "contract not active"-style error (#564).
- Each subcommand's `--help` now shows only that subcommand's own usage/flags
  (plus the shared overview), instead of dumping all five subcommands' worth of
  text (#565).
- Missing required flags are now all reported together in one error, instead of
  one at a time across repeated fix-and-rerun attempts (#566).
- Clarified in `notify --help` that the exit-code 1 (unexpected failure) vs. 2
  (refused) distinction it documents is not currently acted on by this repo's only
  caller (`ton-provider.ts`'s retry logic treats every non-zero exit identically) —
  a documentation/intent fix, no behavior change (#567).
- The no-args case now prints its help text to stderr instead of stdout, matching
  its error-style exit code 2 (so `cmd 2>/dev/null` no longer shows a help dump for
  what was treated as an error); the unknown-subcommand path was fixed the same way
  for consistency (#568).
