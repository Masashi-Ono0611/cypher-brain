---
'cypher-brain': patch
---

Fixed a data-loss bug in `keygen --force` and `keygen --sign --force` (#786):
replacing an existing keypair writes the PRIVATE identity and its paired PUBLIC
recipient as two separate files, and the old order wrote the private identity
FIRST. If the second write then failed for any reason — the recipient path became a
directory, `EACCES`, disk full, a signal landing between the two writes — the old
private identity was already gone, replaced by the new one, while the old public
recipient survived untouched: every prior snapshot became permanently
unrecoverable, and any new snapshot pointed at the now-orphaned old recipient was
unrecoverable too.

Two fixes, both applied to `keygen`'s age identity and `keygen --sign`'s signing
identity:

- The public file is now written FIRST and the private identity LAST, so a failure
  in either write leaves the OLD private identity untouched — the write that
  replaces it only ever runs once the public file has already landed.
- A `--force` run that is about to replace an EXISTING identity now backs it up
  first, unconditionally, to a sibling `<path>.bak-<timestamp>-<random>` file
  (mode 0600) — printed as `old identity backed up to: ...` / `old signing
  identity backed up to: ...`. This is the safety net for the case both writes
  succeed (an ordinary, completed `--force` run still discards the old identity
  the instant it finishes, and the operator may not have manually copied it aside
  despite the existing "back up the identity file now" warning).

`doctor`'s existing `identity-recipient-pairing` check already detects the
resulting mismatch if it ever occurs (an identity and recipient that no longer
derive from each other) — no change needed there.
