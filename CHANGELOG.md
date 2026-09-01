# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project follows [SemVer](https://semver.org/spec/v2.0.0.html).

Entries from the first tagged release onward are **generated** by
[Changesets](https://github.com/changesets/changesets) (issue #227) from the
`.changeset/*.md` files each PR contributes — see
[CONTRIBUTING.md](CONTRIBUTING.md#changesets). `changeset version` prepends them
above the `[Unreleased]` section below, which stays as the hand-written summary
of everything before that point.

## [Unreleased]

`cypher-brain` has not yet cut a tagged npm release (`package.json` is still
at `0.0.1`); the OIDC trusted-publishing pipeline (`.github/workflows/publish.yml`)
is wired and ready for the first `vX.Y.Z` tag push. This entry summarizes the
project's major milestones so far, from the initial proof-of-concept to today.

### Added

- **Core encrypt/push/pull round-trip.** `age` (X25519 + ChaCha20-Poly1305)
  client-side encryption of a gbrain snapshot, with a pluggable storage
  backend behind one `push`/`pull` interface (`file` for dev/CI, `arweave`
  for permanent storage).
- **Bundled crypto — no external `age` binary.** The `age` implementation
  moved in-process via [typage](https://github.com/FiloSottile/typage)
  (`age-encryption`), byte-compatible with the reference `age` CLI in both
  directions (including scrypt passphrase wrapping), removing the external
  binary dependency.
- **Turbo/Arweave storage backend.** Uploads via a bundler
  ([Turbo](https://ardrive.io)), payable with ETH/USDC — no native AR
  purchase or exchange account needed. Multi-gateway HTTP reads for
  resilience, ANS-104 bundled-item support, streamed pulls with
  propagation `--wait`, and a durable locator so recovery survives
  `index.tsv` loss.
- **MCP server.** A stdio MCP entry point exposing spend-guarded tools on
  top of the library, for use from MCP-aware agents.
- **`--profile` support.** Built-in source profiles (`claude-code`,
  `obsidian`, `chatgpt-export`) beyond the default gbrain snapshot.
- **Interactive setup wizard + recovery kit generation** (`init`), and an
  unattended nightly cadence via `schedule install|uninstall|status`.
- **`verify` / recovery tooling**, including a `PARTIAL` verdict (never a
  false `PASS`) when run on a public-key-only box, and recipient pinning
  via `CYPHER_BRAIN_PIN_RECIPIENTS` to guard against silent re-keying.
- **TypeScript conversion** with a strict `tsc` gate on CI, and a
  `src/` + `Bun.build` bundle split with a `npm run verify` gate covering
  build, typecheck, and the full selftest suite (core, profiles, interop,
  storage, recovery, schedule, init, Arweave with and without optional
  deps) plus CLI and MCP smoke tests.
- **`doctor` / `ledger` / `audit` commands.** Read-only diagnostics:
  `doctor` is an environment health check (permissions, key/recipient
  pairing, schedule state, ...) with a PASS/PARTIAL/FAIL verdict and a
  health score; `ledger` is a cumulative cost report over every paid push's
  receipt; `audit` verifies the hash-chained log of every push/restore/verify
  run. All three support `--json`.
- **`keygen --sign` and `keygen --pq`.** `--sign` generates a separate,
  minisign-compatible Ed25519 signing keypair so `snapshot`/`push` can sign
  ciphertext and `verify`/`pull` can check it, adding authenticity on top of
  `age`'s confidentiality. `--pq` generates a post-quantum hybrid identity
  (ML-KEM-768 + X25519) instead of plain X25519, to mitigate
  "harvest now, decrypt later".
- **`rclone` backend.** `push`/`pull --backend rclone` delegate to the
  `rclone` binary, reaching any of its 70+ supported cloud providers without
  cypher-brain implementing their auth/protocol itself.
- **`ton` / `ton-provider` backends.** TON Storage support: `ton` seeds the
  ciphertext bag from your own always-on box over SSH; `ton-provider` pays a
  live third-party provider (mytonprovider.org) to hold it instead, signed
  either via a Tonkeeper deeplink or, with a configured local TON wallet,
  unattended.
- **`did-you-mean` typo suggestions** (#425, #435, #463) for unknown
  commands, flags, profile names, and `wallet`/backend arguments.
- **OpenTelemetry tracing**, opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`: every
  CLI command and MCP tool call becomes an exported span, bounded to a short
  timeout so an unreachable collector never delays a real command.
- **`config.env` config file.** Every `CYPHER_BRAIN_*` setting can live in
  `$CYPHER_BRAIN_HOME/config.env` instead of the environment, read by both
  the CLI and the MCP server.
- **`verify --level quick|remote|drill`.** restic/kopia-style verification
  depth: `remote` re-fetches the artifact from storage before checking it;
  `drill` additionally decrypts and extracts it as a full restore rehearsal.
- **`.cypherbrainignore`.** A gitignore-syntax file that filters what
  `snapshot --dir`/`--profile` archives, plus a `--dry-run` preview of the
  include/exclude file list and its approximate size before anything is
  written or paid for.
- **Minimal-recovery Postgres snapshots.** `snapshot`/`schedule install
  --pg-filter`/`--pg-exclude-table-data` pass through to `pg_dump`'s own
  filtering flags, for a smaller recovery-focused snapshot alongside the
  full one.
- **`recovery-kit` command.** Regenerates the printable recovery kit `init`
  prints once, pointed at the current latest push instead of the first one.
- **`publish-latest` command.** Opt-in: points a `.ton` DNS domain's storage
  record at the `ton` backend's latest bag id, so a fresh machine can
  discover it by a human-memorable name.

### Fixed

- **Security hardening pass** across key handling, storage, and process
  lifecycle: fail-closed `chmod` and atomic `--force` on key generation;
  no-clobber recipient/output files; SSRF-screened redirects and a
  User-Agent on Arweave gateway reads; JWK hygiene and passphrase-identity
  handling; atomic snapshot/restore writes with signal-safe cleanup on
  `SIGINT`/`SIGTERM`/`SIGHUP`; TOCTOU-race closure in the non-hardlink
  snapshot fallback; `lstat`-based manifest kind detection so symlink
  entries are recorded distinctly; a consent gate and timeout on
  `pg_restore`; and a cost-estimate fail-closed guard when a Turbo/Arweave
  spend cap is set. See closed `[Security]`-labeled issues in this repo's
  history for the full audit trail.

### Changed

- Bumped the Node floor to `>=22` (LTS) and moved CI to `actions/checkout`
  and `actions/setup-node` v5.
- Repositioned documentation to be Arweave-first (Turbo mainline) at the time
  this entry was written. TON Storage was reintroduced afterward as two
  full backends — self-hosted `ton` and provider-paid `ton-provider` — see
  the Backends section of README.md.
