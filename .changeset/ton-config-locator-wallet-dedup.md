---
"cypher-brain": patch
---

Internal duplication cleanup found by a code-quality audit — no user-facing behavior
change, confirmed by the full `selftest-ton`/`selftest-ton-provider`/`cli-smoke`/
`selftest-init`/`selftest-plan`/`selftest-ton-dns` suites passing with identical output.

- `TON_HTTP_TIMEOUT_MS` (`src/lib/config.ts`) now reuses `parsePositiveMsOverride`
  instead of hand-rolling the same "positive integer ms, warn+default on invalid"
  validation the `TON_PROVIDER_*` overrides already share (#499).
- `src/lib/backends/ton.ts` and `src/lib/backends/ton-provider.ts` now build their
  `ton:v1:<bag-id>` / `ton-provider:v1:<bag-id>` locators through a shared
  `makeBagLocator(schema)` factory (`src/lib/util.ts`) instead of each hand-rolling an
  identical-shaped regex/builder/parser trio, so the two locator schemas can no longer
  drift apart in shape (#505).
- `wallet create` / `wallet create --chain ton` (`src/lib/wallet.ts`) now share a small
  `createKeyFile()` helper for the mkdir/chmod/writeKeyFile steps that were byte-for-byte
  identical between them. The credential-type-specific keygen (JWK vs mnemonic) and the
  exists+`--force` no-clobber check (different wording per credential, and must still run
  BEFORE keygen) stay exactly where they were — the codebase's own comments already
  explain why these two functions are deliberately not unified further (#506).
