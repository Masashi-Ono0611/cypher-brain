---
"cypher-brain": patch
---

`src/lib/wisdom.ts`'s file header and `printWisdomQuote()`'s own doc comment now
say the precursor quote fires on a successful push to any of the arweave/turbo/
ton-provider PAID backends, matching the actual dispatch condition in `src/cli.ts`
(`ton-provider`, added by #396, was missing from both comments — #694). No
functional change.
