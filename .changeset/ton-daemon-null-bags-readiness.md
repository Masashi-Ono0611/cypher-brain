---
"cypher-brain": patch
---

The `ton` backend's ephemeral local daemon readiness probe now accepts a healthy,
bag-less `tonutils-storage` answer. `startLocalTonDaemon()`'s `#858` hardening required
`/api/v1/list`'s `bags` field to be an array before trusting the probe, but a freshly
started daemon with no bags yet (upstream's `var bags []Bag` with no `append()` calls)
marshals that field as JSON `null`, not `[]` — confirmed against
`xssnick/tonutils-storage`'s `handleList()`. The stricter check rejected every genuinely
ready daemon in that normal startup state, timing out and forcing `ton` pulls onto the
SSH fallback instead of the primary P2P path. The readiness check now accepts `bags`
being either an array or `null`, while still rejecting any other shape (missing field,
string, number, ...) so the guard against an unrelated HTTP 200 answering on the probed
port stays intact.

`scripts/mock-tonutils.mjs`'s `/api/v1/list` handler now mirrors this real-daemon
behavior (returns `null` for `bags` while it holds zero bags, an array otherwise), so
`selftest-ton.sh`'s ephemeral local daemon exercises the null-bags state on every run
instead of only ever returning `[]`.
