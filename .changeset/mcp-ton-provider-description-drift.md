---
'cypher-brain': patch
---

MCP tool descriptions for `snapshot_now`, `schedule_install`, and `estimate_cost` now
mention `ton-provider` as a paid backend — PR2 (#400) added it to `BACKENDS`/`PAID_BACKENDS`
but the prose describing them (found while dogfooding a testnet MCP e2e run of
`snapshot_now --backend ton-provider`) still only named `arweave`/`turbo`, leaving an
MCP-connected agent with no description of what pushing to `ton-provider` actually does
or costs. `schedule_install` also now spells out that `ton-provider`'s spend cap is a
separate, env-only mechanism (`CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`) rather than the
tool's own `max_spend` argument, which does not apply to it.
