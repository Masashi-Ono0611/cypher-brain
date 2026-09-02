---
'cypher-brain': patch
---

Five MCP-server fixes, all of them about a caller-supplied path or a claim made to the
caller.

`last_snapshot_status` no longer reads an arbitrary local file. Its `locator_file` /
`index_file` must now resolve — after following symlinks — to a regular file inside
`CYPHER_BRAIN_HOME`, and a file that does not parse is described ("its first non-comment
line has 1 field") rather than quoted back verbatim. Previously, pointing this read-only
tool at `~/.ssh/id_ed25519` or a `.env` returned that file's first line in the error.

`snapshot_now`'s `locator_file` is scoped the same way. `push --save-locator` renames a
temp file over the path it names, so an unscoped value could replace a shell rc file or
`authorized_keys` — through the free `file` backend, which needs no `confirm_paid`. It
must now sit inside `CYPHER_BRAIN_HOME` (where the documented cadence already puts it)
and, if something is already there, be an existing save-locator file.

`restore_now` refuses a symlinked `out_dir`. Its "this is outside `CYPHER_BRAIN_HOME`"
warning compared paths lexically while the restore itself followed symlinks, so an
in-home symlink pointing elsewhere got no warning and the decrypted plaintext landed
outside home while the result reported the in-home path. Ancestor symlinks are still
followed, and now reported as `out_dir_resolved` when they change the destination.

`verify_restore` no longer loses its verdict — or its error — to a failed temp-dir
cleanup. It returned from inside a `try` whose `finally` removed the scratch directory,
and a throw there replaced both. Cleanup failures now ride the result as a warning, the
way `restore_now` already handled them.

`snapshot_now`'s paid-backend consent message now describes the backend being paid for.
It hard-coded "a PAID, PERMANENT Arweave store" for every paid backend, so a
`ton-provider` push claimed permanent Arweave storage at the moment consent to spend was
requested — its durability actually depends on a provider continuing to renew and serve
the contract.

The `scan_secrets` schema text on `snapshot_now` and `schedule_install` also stopped
claiming that omitting it means no scan; since the gitleaks gate became a default it
resolves to `warn` whenever there is a `dirs` entry and gitleaks is resolvable.
