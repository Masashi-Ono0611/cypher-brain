---
'cypher-brain': minor
---

`init`'s backend prompt is now a `select()` menu (issue #396 Phase B), and `ton-provider`
(pay a live TON Storage market provider — see #396 Phase A) is offered alongside
`arweave`/`turbo`/`file` with a one-line hint per choice, instead of only being reachable
via `--backend ton-provider` on the command line. Picking a paid backend with its
prerequisites unset (no funded Arweave wallet, or no
`CYPHER_BRAIN_TON_PROVIDER_OWNER`/`CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`) still exits
cleanly with setup guidance before anything is touched, the same way arweave/turbo's
wallet check already worked.

`estimate --backend ton-provider` (and `push`'s own pre-upload preview) now also prints
an approximate USD line, sourced from tonapi's public rates endpoint — a rate failure
drops only that line, never the native nanoTON estimate. A `ton-provider` push runs an
advisory pre-deploy funds check against the owner address's on-chain balance (WARN only,
never a hard abort — the deploy is always signed by a human in their own wallet app, so
an actual shortfall gets its own unambiguous refusal there regardless); shares
`CYPHER_BRAIN_SKIP_FUNDS_CHECK=1` with `turbo`'s existing funds check. The wait for the
chosen provider to finish fetching the bag now prints a rate/ETA progress line, the same
shared module `turbo`'s upload and `rclone`'s transfers already use.

`--help`, `README.md`, and `docs/durability.md` now present `ton-provider` with the same
structural weight as `arweave`/`turbo` (a `## Backends` entry, a Quickstart-adjacent
Arweave-vs-TON comparison table, and an honest durability write-up distinguishing it from
both the self-hosted `ton` backend and Arweave's network-guaranteed permanence) — Arweave
remains the recommended default throughout.
