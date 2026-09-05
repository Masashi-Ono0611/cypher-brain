---
"cypher-brain": patch
---

Security/correctness audit fixes across `config`/`plan`/`schedule`/`doctor`/`wizard`:

- `init`'s recovery-kit path prompt now refuses outright (not "confirm to overwrite")
  when the chosen destination is (or symlinks to) this run's own primary identity,
  recipient, signing, or backup key files — answering the existing overwrite prompt
  "yes" for one of these previously replaced a secret key with the kit's own
  plaintext, and since the primary identity is never inlined, overwriting it this
  way made the snapshot just pushed permanently unrecoverable.
- `init`'s concurrent-race backoff for a fresh keygen (issue #720) checked the wrong
  file: `keygenAt()`/`keygenSignAt()` write the recipient file first (issue #786
  reordered this after #720 was written), so the loser of a race threw `EEXIST` on
  the recipient path, not the identity path — the stale check never matched, so a
  losing process could fall through and delete the winning process's freshly-written
  identity. Fixed for the primary identity, and the same guard is now also applied
  to the backup and signing keypair generation steps, which never had it.
- `push --plan`'s plan-file reader no longer throws a raw `RangeError`/`TypeError`
  on a malformed `created_at` or a wrong-shaped `estimate.cost`/`estimate.unit` —
  both now produce the same clean `--plan ...` refusal every other malformed field
  already gets.
- `schedule install`'s `--ping-url` dead-man's-switch curl calls now pass the URL via
  `--url` instead of a bare positional, so a value starting with `-` can't be parsed
  as a curl option.
- `schedule`'s internal legacy-migration config reader now validates the parsed
  JSON's shape (reusing the same validator `schedule status` already applies)
  instead of crashing on a corrupt-but-valid-JSON `schedule.json` (e.g. `{}`), which
  contradicted its own "never treat this as an error" contract.
- `doctor`'s offline-backup-disk-separation check now stats the primary identity
  file itself instead of its containing `CYPHER_BRAIN_HOME` directory, matching
  what its own report message already claimed to compare.
- `doctor`'s issue-tracking now marks a check that escalated from `warn` to `fail`
  as newly-flagged (full penalty) rather than "carryover" (discounted penalty) —
  previously a genuine deterioration was scored as if nothing had changed.
- `CYPHER_BRAIN_AR_HTTP_TIMEOUT`, `CYPHER_BRAIN_PIPE_TIMEOUT`, and
  `CYPHER_BRAIN_AR_L1_MAX` now validate their overrides the same way every other
  numeric config override in this codebase already does (warn + fall back to the
  documented default) instead of silently producing `NaN` on a malformed value.
