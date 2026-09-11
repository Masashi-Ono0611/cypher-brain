---
"cypher-brain": patch
---

Fix a security gap in `witness verify`'s fork detection (#941): `verifyWitnessChain()`
authenticated the signature on whatever bytes a storage backend returned for a given
locator, but never checked that those bytes were actually the entry recorded under
that specific locator. A malicious or compromised backend/gateway could not forge a
new signature, but it COULD answer a request for a competing fork's locator by
replaying a different, genuinely-signed, earlier entry's own bytes instead — that
signature checks out fine (it genuinely is the earlier entry's own valid signature
over its own bytes), so the replayed entry got folded together with the honest one it
impersonated and a real fork was reported as `confirmed` instead of `conflicting`.

Arweave/Turbo locators are not content hashes of the uploaded bytes (they are tx/data-
item ids assigned by the network from the signed transaction/data-item structure, not
recomputable locally from the locator string alone), so this can't be closed by
re-deriving an expected hash from the locator. It IS closed by noticing that two
different locators legitimately resolving to byte-identical, hash-identical entry
content is not an expected outcome of this codebase's publish path (every published
entry carries a fresh timestamp) — `verifyWitnessChain()` now tracks, for the run, the
first locator each authenticated entry hash was observed under, and treats a second,
different locator resolving to the same hash as a possible substitution rather than a
coincidence, forcing the run to `freshness-unknown` (never `confirmed`) instead of
silently accepting the replay. This check is independent of the local hint file's own
fields (which remain untrusted, per the existing fork-with-poisoned-hint/hint-forgery
behavior) — it only compares what was independently fetched and cryptographically
authenticated for each locator actually asked of the backend.

Added a regression test (`fork-replay-substitution` in
`scripts/selftest-witness.mjs`) that reproduces the original vulnerability with a
mocked replaying backend and confirms it red/green against the fix.
