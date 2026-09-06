---
"cypher-brain": patch
---

`recovery-kit` now accepts `--wait <seconds>`, forwarded to the internal decrypt-verify
`pull()` its `--inline-identity`/`--backup-identity` paths run (#873/#876). Regression
fix: that internal pull had no `--wait`, so regenerating a kit right after the push it
points at could fail on nothing more than normal Turbo/Arweave gateway propagation delay
(a fresh upload can take ~5-8 min to become retrievable) — a "push then immediately
regenerate the kit" workflow that worked fine before decrypt-verify existed (the old code
never fetched the upload at all). `--wait` matches `pull`'s own flag exactly: unset stays
0 (fails fast, unchanged default behavior), and only has an effect for `--backend`
arweave/turbo (the locator file's recorded backend) — every other backend still fails
immediately regardless of the value, same as `pull`'s own `--wait`.

Docs: `cypher-brain --help`'s `recovery-kit` entry (and README.md's regenerated CLI
reference) describe the new flag.

Verified: `typecheck`/`lint` pass; `scripts/selftest.sh`, `scripts/selftest-recovery.sh`,
`scripts/selftest-recovery-kit.sh`, and `scripts/selftest-help-docs.sh` all pass. Added a
positive-control regression test to `scripts/arweave-roundtrip.mjs`: a real, mined
artifact sitting behind a delay proxy that 404s GET requests naming its tx id until
released (arlocal itself serves a just-posted tx's bytes immediately regardless of
mining, so an unmined tx would not reproduce "not yet retrievable") — confirms
`recovery-kit` without `--wait` still fails fast, naming the exact tx (unchanged default
behavior), and `recovery-kit --wait <bounded>` observes a real retry attempt against the
delayed artifact, then tolerates it and completes with `Decrypt-verified: YES` once
released.
