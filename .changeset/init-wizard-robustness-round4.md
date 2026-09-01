---
'cypher-brain': patch
---

`init` wizard robustness fixes from round-4 dogfooding (issues #717, #718, #719, #720,
#731, #732, #733, #734, #735, #736, #747, #761, #762) plus a `keys.ts` typo (#746):

- Recovery kit default path is now scoped to the run's own `CYPHER_BRAIN_HOME` instead
  of the OS-level `~` — two identities sharing one machine no longer suggest the same
  default path — and the wizard now warns and asks for confirmation before overwriting
  ANY existing file at the chosen kit path, defaulting to "no" (#717).
- Stdin reaching EOF mid-wizard (a closed pipe, Ctrl-D) now cancels and rolls back the
  same way a Ctrl-C does, instead of silently exiting 0 with orphaned key material
  (#718).
- Rollback no longer deletes a signing keypair this run only REUSED (as opposed to
  generated) — a pre-existing pair now survives every rollback path, sync (signal) and
  async alike (#719).
- Two concurrent `init`/`keygen` processes racing the same empty `CYPHER_BRAIN_HOME`:
  the loser now detects it lost the identity-creation race and backs off without
  touching anything, instead of deleting the winner's identity out from under it
  (#720).
- A chosen paid backend's missing prerequisites now make `init` return a distinct
  "did not complete" result: `cypher-brain init`'s CLI exit code is non-zero and the
  happy mascot/founder's note are skipped, instead of looking identical to a fully
  completed, pushed run (#731).
- A typo'd directory dropped from the comma-separated backup list now goes through
  `warn()` so it survives into the end-of-run warning summary, instead of a
  console.log line invisible to that curated block (#732).
- `snapshotOutPath` (and the rollback that reads it) is now recorded before calling
  `snapshot()`, and the rollback also covers the `.minisig` sidecar — a durable
  ciphertext artifact `snapshot()` promoted before later throwing (e.g. the minisign
  sidecar write itself failing) is no longer left untracked (#733).
- A fatal signal (Ctrl-C, SIGTERM) during the long snapshot/push phase now runs the
  wizard's own synchronous key rollback before re-raising, instead of leaving
  freshly-generated keys behind with no snapshot pushed (#734).
- The paid-backend wallet precheck now honors the same default wallet path
  (`CYPHER_BRAIN_HOME/wallet.json`) that `wallet create`'s own guidance documents,
  instead of only recognizing `CYPHER_BRAIN_AR_WALLET` (#735).
- Reusing an existing signing keypair now verifies the private and public halves
  actually correspond via a cheap sign→verify round trip AND a key-id comparison,
  instead of silently baking a mismatched (or key-id-disagreeing) public key into the
  recovery kit (#736).
- Completion summary's "signing public key:" line padding now aligns with the other
  six lines (#747).
- The per-day snapshot filename now uses the operator's own local calendar day
  instead of UTC (#761).
- The recipient-pin confirm() question now reads `config.env` (the actual filename)
  instead of "the config file", which no longer wraps awkwardly between "config" and
  "file?" at narrow terminal widths (#762).
- `keygen --sign`'s "signing identity (PRIVATE, keep offline):" line no longer has a
  double space after the colon (#746).

New/updated scoped tests in `scripts/selftest-init.sh` cover every fix above,
including new positive controls: (u2) seeds a REAL, non-empty, previously-generated
recovery kit and proves declining the new overwrite confirmation leaves it
byte-for-byte untouched; (v) forces `TZ=Pacific/Kiritimati` (UTC+14) to reproduce the
exact UTC-vs-local divergence #761 describes; (w) proves a pre-existing file at
today's dated snapshot path survives rollback untouched when `snapshot()`'s own
no-clobber check refuses; (r2) proves a signing pair whose keys cryptographically
match but whose recorded key ids disagree is still refused. A new
`scripts/drive-init-eof.mjs` driver (a sibling of `drive-init.mjs`) closes the
child's stdin mid-wizard instead of answering a prompt, for #718's regression test.
Three existing tests ((c2), (n)/(o), (o2)) had their exit-code assertions inverted to
match #731's fix.

A first-pass multi-model review (`codex exec`) additionally caught and fixed, before
merge: `snapshotOutPath`/the recovery-kit overwrite confirmation both needed a
pre-existence guard to avoid deleting/clobbering something this run never created
(#733, #717); the new `installStageSignalGuard()` call needed to happen as soon as
the rollback is registered, not left to whenever `snapshot()` gets around to it, so
steps 2-6 are also covered (#734); an in-flight write tracker was added so a signal
landing between `keygenAt()`/`keygenSignAt()`'s own two sequential writes is also
rolled back (#734); and the signing-keypair consistency check needed to also compare
the minisign key id, not just the cryptographic keys (#736).
