---
"cypher-brain": patch
---

`pull --wait <seconds>` was a silent no-op for every backend except
arweave/turbo (#465): the retry loop only catches `util.ts`'s
`RetryableError`, and only `arweave.ts`'s `get()` (which `turbo.ts`
delegates to) throws it — `file`/`rclone`/`ton`/`ton-provider`'s
"not yet retrievable" errors are plain `Error`s, so a not-ready object
failed on the first attempt regardless of `--wait`, with nothing said
about it. Since `file` is the explicitly recommended backend for local
testing/dogfooding, this was an easy trap: simulating "not yet
retrievable" locally to sanity-check retry logic would look like `--wait`
itself was broken.

`pull` now warns (via the existing `warn()` chokepoint — it still prints
in the end-of-run summary and the MCP `warnings` array) when `--wait` is
set to a positive value for a backend that cannot retry, naming which
backends `--wait` actually applies to. The `--help`/README text for `pull`
now says so up front too. No behavior change for arweave/turbo, and no
behavior change when `--wait` is unset/0 for any backend.
