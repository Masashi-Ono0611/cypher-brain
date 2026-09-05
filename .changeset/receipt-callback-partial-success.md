---
"cypher-brain": patch
---

Fixes the receipt-callback partial-success finding left open by PR #847's
`src/lib/backends/` audit (`arweave.ts:742/786`, `turbo.ts:331/345`):

- **`onReceipt` callback failures could discard a confirmed, already-paid-for
  upload's locator** (`arweave.ts`, `turbo.ts`). Both backends called
  `opts.onReceipt?.(...)` unguarded right after a paid upload became
  irreversible, then returned (or threw a typed partial-success error naming)
  the locator. `pushpull.ts`'s own `persistReceipt()` — the only real caller
  today — already never throws (it catches its own failure and `warn()`s),
  but that safety lived entirely in the caller: a different or future
  `onReceipt` that isn't as careful would have turned a definitely-successful
  upload into an unclassified thrown `Error` with the locator lost entirely,
  reporting the whole push as failed when the ciphertext was already durably
  stored and billed. Both call sites in each backend now wrap `onReceipt` in
  its own `try`/`catch`, `warn()`-ing on failure without letting it override
  the correct, already-determined outcome.
- **`turbo.ts`'s `uploadFile()` failures (and malformed responses with no
  `id`) were reported as ordinary, unclassified errors**, unlike
  `arweave.ts`'s L1 path (`confirmAmbiguousPost`, #802/#818), which already
  distinguishes a confirmed spend, an uncertain spend, and a genuine failure.
  Turbo's ANS-104 data item id is only ever revealed in the (possibly-lost)
  upload response — the SDK signs it internally, and Arweave/RSA-PSS
  signatures are randomized, so there is no way to probe for it by id the way
  arweave.ts does. `turbo.ts` now throws a `PushUncertainSpendError` (a new
  `turbo_wallet_address` `UncertainSpendCheckKind`) naming the signer's own
  address — a local hash of its already-loaded public key, no extra network
  call — as the identifier an operator resolves the ambiguity with, via
  Turbo's own upload history / credit balance, instead of a single
  transaction id.

Verified with `bun run typecheck`, `bun run lint`, and the full existing
`arweave`/`arweave-nodeps`/`turbo-dep`/`ans104-sizing`/`storage`/`receipt`/
`push-partial-failure`/`mcp-uncertain-spend`/`error-codes` selftests (no
regressions). Added a new positive-control selftest
(`selftest:onreceipt-guard`) that calls `arweaveBackend().put()` directly
against a local `arlocal` gateway with a deliberately-throwing `onReceipt`,
confirming the confirmed tx id now survives the callback failure — reverting
the fix locally reproduces the failure this selftest catches (four of its
five assertions fail and the confirmed locator is lost, exactly the bug being
fixed).

**Known coverage gap**: the new selftest only covers arweave.ts's clean
(200/208) success path — the most severe case, where the upload is
unambiguously confirmed. It does not separately exercise arweave.ts's
probe-confirmed-ambiguous path (`confirmAmbiguousPost`) or either of
turbo.ts's new guards with a dedicated positive control: the former would
need a network-fault-injection harness (a proxy that lets the POST land on
arlocal but fails the client's response, along the lines of
`scripts/arweave-roundtrip.mjs`'s existing "drop server"/"blind server"
helpers) and the latter has no local mock Turbo upload service in this repo
to fail against at all (unlike arlocal for arweave). All four guards share
the identical `try { await onReceipt(...) } catch { warn(...) }` shape,
and the full existing `arweave` selftest continues to exercise the
probe-confirmed and uncertain-spend classification logic itself (just not
with a throwing `onReceipt`) with no regression.
