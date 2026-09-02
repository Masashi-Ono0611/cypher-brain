---
'cypher-brain': patch
---

Fixes #838: `assertSnapshotPolicy()` in `src/mcp.ts` resolved each configured
`CYPHER_BRAIN_MCP_SOURCE_ROOTS` root via `realpathOfNearestAncestor()` — the same helper
used for a caller's `dirs` entries, where "resolve to the nearest EXISTING ancestor" is
the right behavior for a call-time typo. Reused for the ROOTS themselves, it meant a
typo'd or not-yet-created root (`CYPHER_BRAIN_MCP_SOURCE_ROOTS=["/Users/me/brian"]`)
never refused at all: it silently "resolved" to its nearest existing ancestor
(`/Users/me`) instead, and every `dirs` call under that broader directory was
authorized — for a caller this server's own threat model treats as untrusted.

A configured root must now exist on disk as a directory (fully realpath'd — a root that
is itself a symlink to a directory is accepted, its resolved target compared, same as
every other path this gate compares) or `assertSnapshotPolicy()` refuses the WHOLE call
with `ERR_POLICY_DENIED` / `CB-E025`, naming the offending root, rather than silently
authorizing just a narrower slice of what the operator meant. `dirs` entries are
unchanged — a call-time typo is still left to `snapshot()`'s own "no such directory"
error, not this gate.
