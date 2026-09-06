---
'cypher-brain': patch
---

Fixes a regression from #871's fsync discipline: `writeKeyFile()`'s `--force` branch
(`src/lib/keys.ts`, shared by `keygen`, `keygen --sign`, and `wallet create`) only
cleaned up its sibling `<path>.<pid>.<hex>.tmp` scratch file around the final
`rename()` call — a failure in `fh.sync()` (or, in principle, `fh.close()`) after the
secret payload was already written to `tmp` closed the handle via its own
try/finally but propagated past the rename's catch block, leaving a complete,
unencrypted secret (an age identity, a minisign signing key, or an Arweave JWK)
sitting on disk indefinitely — untracked by `signal-guard.ts`'s cleanup-on-signal
mechanism, which never knew the file existed. Found via a post-merge Codex regression
review of the accumulated session diff.

The cleanup scope now covers every step from `open(tmp, ...)` through the rename
(write, sync, close, AND rename), and the tmp file is registered with
`signal-guard.ts` (a new `ACTIVE_KEY_SCRATCH_FILES` set, mirroring the existing
`add*ScratchDir` pattern) for its entire on-disk lifetime, so a SIGINT/SIGTERM/SIGHUP
landing mid-write is swept the same way every other scratch resource in this codebase
already is. New fault-injection selftests (`selftest:keyfile-fsync-cleanup`) reproduce
the pre-fix leak in isolation, confirm the real `writeKeyFile()` cleans up and still
propagates the error, and confirm signal-guard's own SIGTERM handler (not
`writeKeyFile()`'s unreachable catch/finally) is what sweeps the file when a real
signal lands mid-`fh.sync()`.
