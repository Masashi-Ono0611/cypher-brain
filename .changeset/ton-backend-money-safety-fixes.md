---
"cypher-brain": patch
---

Fixes #639, #640, #643, #644: four money-safety and reliability fixes in the TON
backends.

- **#639**: a signed `push --backend ton-provider` deploys TWO independent StorageV1
  contracts (ciphertext, then its `.minisig` sidecar), each spending real TON. Before
  this fix, `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND` was checked against each deploy in
  isolation, so a push could spend well beyond the displayed pre-consent estimate (each
  deploy individually under the cap, their sum over it). `push` now tracks the combined
  spend across both deploys with a single shared budget, and the pre-consent estimate
  display shows the sidecar's own cost plus the combined total when a signed artifact
  is being pushed.
- **#640**: a transient tonapi lookup failure (network/timeout/5xx) while auto-signing
  a `ton-provider` deploy was silently treated the same as "wallet never used",
  selecting seqno 0 and risking a doomed on-chain transaction. The lookup failure now
  fails loudly instead of guessing.
- **#643**: the `ton` backend's idempotent re-push fast path only checked `completed`,
  not `completed && active` (the same gate the initial bag-creation path already
  waits for) — so re-pushing unchanged ciphertext against a bag the seeder still holds
  but has stopped actively seeding reported "already seeded" without actually
  restoring availability. It now re-creates/re-seeds the bag in that case.
- **#644**: `ton.ts`, `ton-provider.ts`, and `ton-dns.ts` each create ephemeral,
  potentially multi-gigabyte temp trees for a local tonutils-storage daemon, but never
  installed the process's signal guard or registered those directories with it — a
  SIGINT/SIGTERM/SIGHUP mid-fetch left the daemon's temp tree (and, without a handler
  installed at all, the daemon process itself) behind. All three now install the
  guard and register their temp directory, so a signal sweeps them the same way
  `snapshot`/`restore` already do for their own temp resources.
