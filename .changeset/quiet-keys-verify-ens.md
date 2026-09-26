---
'cypher-brain': minor
---

Add `ens-verify` and `ens-set-text`, completing the ENSv2 agent-wallet story started
in #966–#968 (ETHGlobal Tokyo 2026 Epic #972).

`ens-verify --name <label> --text-key <key> --expected-value <locator> --rpc-url <url>`
proves the agent wallet's ENSv2 grant is actually scoped, not just claimed: it reads
back the published text record and compares it to `--expected-value` (positive check),
then simulates a `setText` call against a different, out-of-scope text key and requires
it to revert with the resolver's own `EACUnauthorizedAccountRoles` error, decoded and
matched on resource/role/account rather than string-matched (the negative check is
simulation-only and never broadcasts).

`ens-set-text --name <label> --text-key <key> --value <text> --rpc-url <url>`
independently writes any already-granted ENS text key with the agent wallet — not just
the push locator `push --publish-ens` writes. This is what lets an agent publish
self-description records (ENSIP-26's `agent-context` / `agent-endpoint[protocol]`,
for example) once the owner has granted that specific key with `ens-setup`.
`ens-publish.ts`'s writer is now a single shared implementation (`prepareEnsTextWriter`)
used by both `push --publish-ens` and `ens-set-text`, so the resolver re-check,
simulate-before-broadcast, and confirmation-prompt safeguards apply identically to
both call sites. The confirmation prompt now shows the exact value being signed
(control characters and bidi overrides escaped, with a sha256 fingerprint of the full
value alongside a length-capped display) instead of asking for blind approval, and the
resolver is re-checked both before the interactive confirmation prompt and again
immediately before broadcasting, closing the window a human reading the prompt would
otherwise leave open.
