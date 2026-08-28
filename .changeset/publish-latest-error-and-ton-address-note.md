---
'cypher-brain': patch
---

Two small docs/clarity fixes found during dogfooding (#482, #483).

`publish-latest --from-locator-file` now distinguishes a missing locator file
(`no such locator file: <path>`) from one that exists but has no locator line
(`<path> has no locator line — run a push with --save-locator first, and point
--from-locator-file at the file it wrote`), matching the clarity `pull` and
`recovery-kit` already give for the identical failure mode instead of the generic
`no locator line found in <path>` (#482).

`wallet create --chain ton` now notes that its printed address is the bounceable
(`EQ...`) encoding, and that some wallets/explorers may render the same account as
non-bounceable (`UQ...`) — both refer to the same address. Not a functional change
(tonapi already accepts both forms); just closes a first-time-TON-user terminology
gap (#483).
