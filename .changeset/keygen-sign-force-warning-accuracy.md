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
still verify old signatures. A fresh (non-`--force`) `keygen --sign` prints a
plain backup reminder instead, since no prior signatures exist to reason
about (#532).
