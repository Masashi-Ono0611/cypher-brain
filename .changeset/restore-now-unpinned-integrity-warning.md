---
'cypher-brain': patch
---

`restore_now` now warns when a `locator`/`locator_file` pull comes from a
non-content-addressed backend (arweave/turbo) with no sha256 integrity pin —
matching the warning `verify_restore` already gave in the same situation (#689).
`resolveRestoreTarget()` (shared by both tools' dual-mode locator/file/locator_file
resolution) previously computed this check only on `verify_restore`'s copy of the
pull logic; `restore_now`'s copy silently dropped it. Concretely, an MCP caller
could call `restore_now({ locator: '<arweave-tx-id>', backend: 'arweave',
confirm_write: true[, pg: ... ] })` with no `sha256`, and the fetched bytes would
be decrypted, extracted, and — with `pg` — `pg_restore --clean --if-exists`'d over
a live database, with zero indication in the structured result that a gateway
rollback/substitution would have gone undetected. The new `warning` now rides
`resolveRestoreTarget`'s return value into `handleRestoreNow`'s `warnings` array,
and `RESTORE_NOW_TOOL`'s description carries the same "IMPORTANT" callout
`VERIFY_RESTORE_TOOL`'s already does.
