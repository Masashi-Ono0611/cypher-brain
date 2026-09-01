---
'cypher-brain': patch
---

Fixed a temp-directory leak in `mcp.ts`'s `snapshot_now` handler under concurrent
`--scan-secrets` scans. `signal-guard.ts` tracked the gitleaks report temp dir in a single
scalar slot (`ACTIVE_SCAN_REPORT_DIR`), unlike the sibling `ACTIVE_MCP_FETCH_DIRS` and
`ACTIVE_TON_TMP_DIRS`, which are `Set`s specifically so two concurrent MCP calls cannot
clobber each other's tracked resource. `snapshot_now` only takes an idempotency lock when
a caller supplies an `idempotency_key`, so two concurrent calls (no key, or two different
keys) could race: the second scan's registration silently evicted the first's dir, and the
first scan's own cleanup then cleared the slot out from under the second — a SIGINT/
SIGTERM/SIGHUP arriving while the second scan was still running found nothing tracked and
left its gitleaks report directory behind under `os.tmpdir()` forever.

`ACTIVE_SCAN_REPORT_DIR` is now a `Set` (`ACTIVE_SCAN_REPORT_DIRS`), with matching
`addActiveScanReportDir`/`removeActiveScanReportDir` functions mirroring the existing
`addActiveMcpFetchDir`/`removeActiveMcpFetchDir` pattern, and the signal handler now
iterates and erases every tracked scan report dir instead of a single slot.
