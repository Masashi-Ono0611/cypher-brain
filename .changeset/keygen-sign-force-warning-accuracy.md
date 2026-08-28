---
"cypher-brain": patch
---

`keygen --sign --force`'s completion message no longer claims existing
`*.minisig` files "stay verifiable against the public key above regardless".
That was only true if the OLD `sign-recipient.pub` had been copied elsewhere
BEFORE running `--force` — an unstated precondition. `--force` overwrites
`sign-recipient.pub` IN PLACE at its default path, so `verify`'s default
lookup now resolves to the NEW key and signatures made with the OLD key
correctly FAIL against it (the cryptographic behavior was always correct;
only the warning text was misleading). The message now says the default
verification path was overwritten and, when the old key was saved elsewhere,
names `verify --sign-recipient <path-to-saved-old-pubkey>` as the way to
still verify old signatures. The warning only fires when the signing
*public* key at that exact path already existed before this run (a fresh
`--force` with nothing there yet, or a plain `keygen --sign`, gets the plain
backup reminder instead — and so does a `--force` re-run whose
`--sign-recipient` names a path that never existed, even if `--sign-identity`
happens to reuse an existing identity), and correctly scopes itself to a
custom path when `--sign-recipient` was passed to `keygen --sign` rather
than always claiming "the default path" (#532).
