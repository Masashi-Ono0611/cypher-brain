---
'cypher-brain': patch
---

`init`'s Profile step (6/7) is now a `select()` arrow-key menu, the same pattern the
backend step already used (#396 Phase B) — matching the issue's own framing that the
profile step deserved the same fix. Before this, a single typo (`obsidan` instead of
`obsidian`) threw `unknown profile "obsidan"` AFTER the primary identity, the offline
backup keypair and the signing keypair had already been written to disk, and the
wizard's own rollback then deleted all three: the user had to restart the entire
wizard from scratch, regenerating cryptographic keys, over one missing letter (#462).
A `select()` menu can only ever return one of the values it was given, so the typo
path is now structurally unreachable rather than caught-and-rolled-back.

As defense in depth — and to fully close the `--profile` did-you-mean gap #425 left
(#463) — `resolveProfilePaths()` (`src/lib/profiles.ts`), the validator every direct
`--profile <name>` CLI path (`snapshot`, `schedule install`, ...) goes through, now
offers a `nearestName()`/`didYouMean()` suggestion for a near-miss profile name, the
same idiom already generalized across `--backend`, `--chain`, `--level` and the
schedule subcommands: `snapshot --profile claude-cod` now says `(did you mean
claude-code?)` instead of only listing the valid names.
