---
"cypher-brain": patch
---

`estimate --backend turbo` and `push --backend turbo` no longer print a bare,
unprefixed `bigint: Failed to load bindings, pure JS will be used (try npm
run rebuild?)` line before any of cypher-brain's own output (#422). That
message comes from `bigint-buffer` (pulled in transitively via
`@ardrive/turbo-sdk` → `@solana/spl-token` → `@solana/buffer-layout-utils`)
logging at module-load time when its native binding fails to load — harmless
(falls back to pure JS, which is all this project's use of the turbo SDK
needs) but indistinguishable from a real error on first read, since it
carries none of this CLI's own `error:`/`warning:` vocabulary. A new
`importQuietly()` helper (`src/lib/util.ts`) wraps the lazy `@ardrive/turbo-
sdk` import and swallows only that one known message text — every other
`console.warn` during the same call still reaches the real console.warn, so
this is not a blanket "hide turbo SDK warnings" switch.
