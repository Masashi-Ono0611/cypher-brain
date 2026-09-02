---
'cypher-brain': minor
---

The MCP server's `snapshot_now` tool is now fail-closed (#800), and needs two settings
before it will run. This changes the default behaviour of an existing MCP setup; the CLI
`snapshot` is untouched.

`snapshot_now` is the one tool where the caller — an AI agent this server's own threat
model treats as untrusted — picked both the plaintext (`dirs`) and the key it is
encrypted to (`recipients`), over a free `file` backend that crosses no consent gate.
Two operator-set environment variables take those halves back:

- `CYPHER_BRAIN_PIN_RECIPIENTS` must resolve to at least one `age1…` key, or every
  `snapshot_now` call is refused — and every recipient a call names must be on it.
  (`cypher-brain init` already offers to write it.) `snapshot` already enforced this and
  still does; the MCP server checks it again so an `idempotency_key` replay cannot return
  a result recorded under a pin the operator has since narrowed.
- `CYPHER_BRAIN_MCP_SOURCE_ROOTS` — new, a JSON array of absolute paths — declares which
  directories may be snapshot sources. Every `dirs` entry must resolve, after following
  symlinks, to one of those roots or inside it. Unset, empty or malformed roots refuse
  every call naming `dirs`; a pinned `pg`-only call still works with no roots at all.

The check runs before the idempotency lookup, the output file, the secret scan, the
snapshot and the upload, so a refused call leaves no artifact, no stored object and no
idempotency record — and a stored `idempotency_key` cannot be replayed past a policy that
would now deny it. Refusals come back as `ERR_POLICY_DENIED` with the new stable code
`CB-E025` and name the variable to set. If your MCP host suddenly gets `CB-E025`, set both
variables in the server's environment and restart it — MANAGEMENT.md's "MCP snapshot
policy" has the recipe.
