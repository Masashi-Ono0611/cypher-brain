---
"cypher-brain": patch
---

`init` regression fixes found via a whole-session accumulated-diff Codex review of
`src/lib/wizard.ts` (elevated-caution key-handling cluster; relates to prior PRs
#846/#869):

- `init`'s concurrent-keygen race backoff only recognized an `EEXIST` on the
  RECIPIENT path as "another process already won, back off untouched" — the shape
  two concurrent PLAIN `keygen`/`init` calls produce. `keygen --force` is a separate
  code path that overwrites both files unconditionally instead of via the same
  exclusive-create ordering, so a concurrent `keygen --force` could complete both of
  its writes in the gap between this run's own RECIPIENT write succeeding and its
  IDENTITY write running — failing THAT write with `EEXIST` on IDENTITY instead,
  which fell through to the unconditional rollback and deleted the concurrent
  `keygen --force`'s freshly-written identity/recipient pair. The same fix (and the
  same sibling gap) is applied to the SIGNING keypair's own race guard
  (`keygen --sign --force`) and the offline BACKUP keypair's own race guard
  (a second sibling, found in a follow-up review pass). A pre-existing symlink
  (dangling or not) at the colliding path is now also distinguished from a genuine
  winning race — an exclusive-create `open()` throws the identical `EEXIST` for a
  symlink regardless of a real winner, so this no longer misreports it as "another
  process just won" for any of the three keypairs. The symlink check itself runs
  synchronously (`lstatSync`, not an `await`) so classifying an `EEXIST` never opens
  a new window for a fatal signal to land mid-classification and have the
  synchronous signal-rollback delete a concurrent winner's files before the async
  classification above it can finish protecting them.
- `init`'s push-error classification recognized only `PushPartialSuccessError` as
  "the ciphertext already durably succeeded — preserve keys, don't roll back".
  `backends/turbo.ts` can now throw `PushUncertainSpendError` instead for a signed
  push's ".minisig" sidecar upload, carrying a `confirmedCiphertextLocator` when the
  ciphertext's own upload already durably succeeded — that confirmed-locator shape
  is now treated the same as `PushPartialSuccessError`. A genuinely UNCONFIRMED
  `PushUncertainSpendError` (the ciphertext's own upload is what went ambiguous) is
  also now preserved rather than rolled back, with an honestly-worded message that
  never claims success — absence of confirmation is not proof the upload never
  happened, and deleting the only keys able to decrypt it if it did would be worse
  than a blocked retry. That message's own "if it turns out nothing happened, remove
  these yourself" advice never lists a signing keypair this run only REUSED (rather
  than generated) — other backups may still depend on it, the same protection the
  ordinary rollback path already gave it, spelled out explicitly so the omission
  reads as deliberate rather than an oversight.
