---
'cypher-brain': patch
---

Elevated-caution hardening across the key-handling and spend-tracking cluster
(follow-up to #846): `crypt.ts`'s `newEncrypter()` no longer echoes a rejected
recipient's full value into its error (redacted to length + a short prefix);
`promptHidden()` decodes passphrase input through a stateful `StringDecoder`
instead of per-chunk, so a multibyte character split across TTY reads no
longer corrupts it. `keys.ts`'s identity/backup writes are now fsync'd
(content and directory entry), `backupIdentityFile()`'s classify-then-read is
now done through a single non-blocking file descriptor (closing a TOCTOU
window and a FIFO-hang hazard), and `wrapInPlace()` re-verifies the identity
right before writing rather than trusting a read taken before the passphrase
prompt and the KDF. `minisign.ts`'s signing-identity backup inherits the same
fix via the shared `backupIdentityFile()`. `wallet.ts` no longer echoes raw
file content in a JSON-parse error and now validates a loaded TON mnemonic
(`mnemonicValidate()`) before deriving a wallet from it. `idempotency.ts`'s
cross-process log lock now uses an ownership token and a push-lock.ts-style
steal-with-re-verify instead of a bare mtime check, replaces a busy-loop on a
persistent lock-read error with bounded backoff, fsyncs the claim/result
files and their directory entries, and treats a malformed `recordedAt` as a
corrupted record rather than silently expired. `receipt.ts`'s `appendReceipt()`
is now fsync'd for durability consistency with the rest of this cluster.
`pushpull.ts`'s `--skip-unchanged` now also compares the rclone `--remote`
destination (an 8th save-locator field) so changing `--remote` can no longer
report a false SKIPPED, and an MCP idempotency replay whose locator matches
an existing richer save-locator record no longer downgrades it to a bare
3-field line.
