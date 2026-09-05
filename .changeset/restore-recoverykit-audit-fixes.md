---
"cypher-brain": patch
---

Five approved correctness/security fixes from a full-file audit of `snapshot.ts`,
`restore.ts`, `recoverykit.ts`, `balance.ts`, and `estimate.ts`, hardened further across
two rounds of independent multi-model review:

- `restore --pg`'s `pg_restore` invocation added `--single-transaction`: without it,
  `--clean --if-exists` drops and recreates objects one DDL statement at a time outside
  any wrapping transaction, so a failure partway through (timeout, killed connection,
  OOM) left the target database in a mid-restore state — some objects dropped, the rest
  never recreated — with no atomic rollback. The whole restore now rolls back cleanly on
  any failure.
- `mergeNoClobber()`'s recursive descent into an existing subdirectory now re-`lstat`s
  that directory itself, fresh, immediately before EVERY entry in that level's own
  loop — not once per call, which review correctly flagged as not actually narrowing the
  loop-wide window it claimed to. This shrinks the exploitable gap from "however long the
  whole subtree merge takes" down to "however long one entry's own move/recurse takes",
  the smallest granularity available without fd-relative `openat`/`mkdirat` (`O_NOFOLLOW`,
  which Node does not expose). The residual (an ancestor of `dest`, rather than `dest`
  itself, being swapped) is documented rather than silently left, matching the existing
  residual note on `moveNoClobber()`'s directory-creation branch. The two external call
  sites (`expandComponents()`, `restoreImpl()`'s top-level promotion) are unaffected —
  this only applies to the function's own internal recursion, so a legitimate symlinked
  `--out-dir` still works.
- `expandComponents()`'s three defense-in-depth/no-op skip paths (an unsafe manifest
  component name, a component the manifest lists with no backing archive on disk, and a
  symlink squatting on an expanded-component directory name) are now all reported through
  `warn()` (the project's single chokepoint for warnings a human/agent relaying a run must
  see, #347) rather than a bare `console.error`: the missing-backing-archive case
  previously had NO runtime signal at all (only a code comment explaining why it was safe
  to skip), and all three are now also collected into one unmissable end-of-run summary
  line — without changing the deliberate "not an expand failure" exit-code posture the
  existing `scripts/selftest.sh` symlink-refusal cases already pin.
- `recovery-kit` now proves, at kit-generation time, that any identity it is about to
  EMBED (an inlined wrapped primary, or a `--backup-identity`) can actually decrypt the
  one backup this kit's own save-locator line points at — pulling that target once into a
  signal-tracked private scratch file (a new `ACTIVE_RECOVERY_KIT_VERIFY_DIR` slot in
  `signal-guard.ts`) and running the same decrypt-list positive control `verify` already
  runs for an identity already resident on the machine (`consStdout: 'ignore'`, so the
  decrypted archive listing never leaks onto `recovery-kit`'s own stdout). Previously only
  the identity FILE's format/wrap-shape was checked; a wrong `--backup-recipient` or a
  backup identity that was never added as a snapshot recipient for this push sailed
  through and printed a kit whose recovery steps would not work. Verification is bound to
  the EXACT bytes/locator this kit embeds and prints — the identity is checked from the
  same already-classified in-memory bytes (never a second path re-read, via a new
  `identitiesFromAtRest()` in `crypt.ts`), and the target is fetched by the `locator`/
  `backend`/`sha256` from a SINGLE read of `--from-locator-file` (the same text the
  printed SAVE-LOCATOR line is drawn from) rather than two independent reads that a
  concurrent push could have raced apart. The per-embedded-identity outcome
  (`verified`/`skipped`) is recorded into the kit itself as a "Decrypt-verified: YES/NO"
  note next to each identity block. When the check cannot be attempted non-interactively
  (a wrapped identity with no TTY and no `CYPHER_BRAIN_PASSPHRASE`), kit generation still
  succeeds but with a loud, explicit warning that the proof was skipped — mirroring
  `verify`'s own PARTIAL-verdict posture.
- `expandComponents()`'s per-component scratch directory (holding one component's
  freshly-decrypted plaintext while `tar` extracts into it) is now registered with
  `signal-guard.ts`'s cleanup tracking (a new `ACTIVE_EXPAND_SCRATCH_DIRS` set, following
  the existing `addActive*`/`removeActive*` pattern) — previously a signal landing during
  a component's extraction/merge left that scratch dir unswept, since `restoreImpl()`'s
  own `ACTIVE_RESTORE_SCRATCH_DIR` tracking is already cleared by the time component
  auto-expand runs.

Docs: `cypher-brain --help`'s `recovery-kit` entry (and README.md's regenerated CLI
reference, and MANAGEMENT.md's "Key recovery" section) now describe the new
decrypt-verification behavior — the network fetch it triggers, that it may prompt for a
passphrase, that a mismatched key refuses kit generation, and the "Decrypt-verified:
YES/NO" note — per AGENTS.md's "keep docs in sync with behavior changes" requirement
(flagged in review).

Verified: `typecheck`/`lint` pass; the full `scripts/selftest.sh` suite (100/100, re-run
after every round of fixes) plus `scripts/selftest-restore-toctou.mjs`,
`scripts/selftest-restore-security.sh`, `scripts/selftest-verify-levels.sh`,
`scripts/selftest-recovery.sh`, and `scripts/selftest-recovery-kit.sh` all pass. Manually
exercised the new recovery-kit decrypt-verification guard with both a positive control (a
real backup identity that IS a snapshot recipient — kit generates, `Decrypt-verified:
YES`, no stdout leakage) and a negative control (an identity that is NOT a recipient —
kit generation is refused with a clear error and no kit file is written), confirming the
guard actually fires in both directions.

Deliberately not touched (out of scope for this pass): `restore.ts`'s hard-link fallback
(an already-documented accepted tradeoff, not a bug), and test-coverage-only suggestions
on `balance.ts`/`estimate.ts`. A parallel finding — `init`'s wizard-printed kit
(`wizard.ts`) shares `buildRecoveryKit()` but never runs this decrypt-verification either
— was left for follow-up rather than folded in here, since it was not part of the
originally approved finding list.
