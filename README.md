# cypher-brain

```text
  /\        /\
 | [10]==[01] |    hi — I encrypt your second brain so only YOUR key opens it.
 |     -      |    ( sunglasses stay on for verify PASS, slip for FAIL,
 '.__________.'      one lens shifts for PARTIAL — see `verify` below )
```

[![CI](https://img.shields.io/github/actions/workflow/status/Masashi-Ono0611/cypher-brain/ci.yml?branch=main&label=CI&logo=github)](https://github.com/Masashi-Ono0611/cypher-brain/actions/workflows/ci.yml)

> **OpenSSF Best Practices:** the technical prerequisites (SECURITY.md,
> private vulnerability reporting, branch protection, dependency updates —
> see [#149](https://github.com/Masashi-Ono0611/cypher-brain/issues/149),
> [#184](https://github.com/Masashi-Ono0611/cypher-brain/issues/184),
> [#185](https://github.com/Masashi-Ono0611/cypher-brain/issues/185),
> [#186](https://github.com/Masashi-Ono0611/cypher-brain/issues/186)) are in
> place. Registration on [bestpractices.dev](https://www.bestpractices.dev/)
> itself (creating an account, filling out the self-assessment) is a manual
> step still pending for the maintainer — this line will become the actual
> badge once that's done.

> **For AI agents:** see [`llms.txt`](llms.txt) for a quick, machine-friendly orientation.

Encrypt your growing second brain — the AI memory, conversation history, and
knowledge store you build up over years — so that **only you** can read it,
then park the ciphertext **permanently on Arweave**: pay once at upload, and
the network's endowment keeps the bytes replicated with no server of yours to
keep alive. Recovery is deliberately minimal: a fresh machine restores with
just the locator and your identity file — the pull is a plain HTTP gateway
fetch, no wallet, no npm package. (*gbrain* is the second brain this was built
for: a local knowledge store under `~/.gbrain` that re-synthesizes nightly. It
runs on either of two engines — **PGLite**, its zero-config default, which keeps
the whole database as a directory on disk, or a **Postgres** server.)

This repo is the **Cipher layer** of Cypher Brain: the part that turns your
growing second brain into a single encrypted artifact. Storage is a pluggable
backend behind one `push`/`pull` interface, and it only ever sees ciphertext.
Arweave via the **`turbo`** backend is the recommended mainline; a local
`file` backend covers dev and CI (see [Backends](#backends)).

> Status: proof-of-concept for [issue #1](https://github.com/Masashi-Ono0611/cypher-brain/issues/1).
> The round-trip is validated end-to-end against real gbrain data (see below).

**What cypher-brain isn't:**

- Not a general-purpose backup tool — it targets one shape: encrypt a snapshot
  (gbrain, Claude Code memory, an Obsidian vault, a ChatGPT export) client-side and
  park it durably. See [`--profile`](#usage) for the sources it knows about.
- Not a key management service — there is no server holding your keys. The
  identity file is yours to keep offline; lose it and the snapshots are
  unrecoverable (see Threat model below).
- Not gbrain itself — gbrain is the second-brain product (`~/.gbrain`, on PGLite
  or Postgres) that produces the plaintext. cypher-brain only ever touches it
  long enough to encrypt.
- Not a crypto wallet or exchange integration — an Arweave upload goes through a
  bundler ([Turbo](https://ardrive.io)) paid with **ETH/USDC**; no native AR
  purchase and no exchange account are needed (see [Backends](#backends)).

## Threat model — "the key is only mine"

`cypher-brain` uses [age](https://age-encryption.org) (X25519 + ChaCha20-Poly1305)
with an **asymmetric** keypair. The crypto runs in-process via
[typage](https://github.com/FiloSottile/typage) (`age-encryption`, by age's
author), bundled into the CLI — no external `age` binary is required, and every
format stays byte-compatible with it (CI asserts both directions, including
scrypt passphrase wrapping):

- **identity** (private key) — lives off your always-on machine; the *only* thing
  that can decrypt. Lose it and the snapshots are unrecoverable.
- **recipient** (public key) — all the snapshotting machine needs.

So the always-on box that runs gbrain (e.g. a Mac mini) holds **only the public
key**. It can produce snapshots forever but can never read them back: the
**snapshots it writes, and anything the storage backend ever sees, are ciphertext
only** — that is the property this design guarantees.

Three honest caveats, since this is a security tool. (1) That box also *runs* gbrain,
so the live plaintext (`~/.gbrain`, plus a Postgres server if that is the engine in
use) is on it regardless — cypher-brain
protects the snapshots you ship off-box, not the source machine; keep it
full-disk-encrypted. (2) A box that can rewrite `recipient.txt` (or inject an extra
`--recipient`) could silently re-key *future* snapshots to an attacker while your own
restore still works. Pin the allowed recipients with `CYPHER_BRAIN_PIN_RECIPIENTS`
(snapshot refuses any recipient not on the list), and prove restorability where the
identity lives — `verify` on a public-key-only box reports **PARTIAL**, never PASS.
(3) age gives **confidentiality** and AEAD **tamper detection**, but not
**authenticity**: a recipient's public key is not a secret — by design, it can be
shared for key recovery (see "Key recovery" in `MANAGEMENT.md`) — so anyone who
obtains it can forge ciphertext that decrypts cleanly with your identity, claiming to
be a real snapshot. `keygen --sign` addresses the **forged-ciphertext** half of this
gap: it generates a separate, [minisign](https://jedisct1.github.io/minisign/)-compatible
Ed25519 signing keypair; `snapshot` then writes a detached `*.minisig` signature over
each ciphertext it produces, and `restore`/`verify` check that signature **before
decrypting**, refusing outright on a tampered/forged one. By default this is optional
and additive — a snapshot with no `*.minisig` (a pre-existing backup, or `snapshot
--no-sign`) restores exactly as before, so `keygen --sign` alone does NOT close the
**stripped-signature** half: an attacker who can substitute your ciphertext can also
just delete the `*.minisig` sidecar instead of forging one, and by default that looks
identical to a legitimate unsigned/pre-`keygen --sign` backup (both WARN and proceed).
Add `--require-signature` to `restore`/`verify` once you have run `keygen --sign` and
expect every artifact to carry a valid signature, to turn a missing/unverifiable
signature into a hard failure too — that is the recipe that actually closes the full
gap. See the CLI reference's `keygen`/`snapshot`/`restore`/`verify` entries below for
the flags.

The same "anyone holding a recipient's public key can forge ciphertext" point applies
one layer down, to the tar payload age decrypts to: `restore` inspects every tar entry
— absolute paths, `..` traversal, FIFO/device/socket entries, a hardlink whose target
escapes the archive tree, or a symlink another entry is nested under (the classic tar
path-traversal-through-symlink attack) — and refuses the whole archive before
extracting a single byte, into an isolated scratch directory only promoted into
`--out-dir` once fully vetted (#218). This is defense-in-depth alongside #198's
equivalent guard for manifest.json's `name`/`source` fields, not a fix for a known
exploited vulnerability.

Permanence adds a fourth caveat: **harvest now, decrypt later.** Ciphertext parked
on a permanent public network can never be recalled — anyone can copy it today and
wait for the cryptography to fail. age's plain X25519 recipient scheme is **not
post-quantum secure**, and rotating keys cannot protect snapshots already pushed:
the old ciphertext stays public forever. Weigh what you park against that horizon.

`keygen --pq` mitigates this: it generates a **post-quantum HYBRID keypair**
(ML-KEM-768 + X25519, via [typage](https://github.com/FiloSottile/typage)'s
`generateHybridIdentity()` — no external age plugin needed) instead of plain
X25519. A hybrid identity/recipient/ciphertext is much bigger than its X25519
counterpart (recipient ~1.9KB vs ~62 bytes; ciphertext carries a fixed ~1.4KB
per-recipient overhead), but that's negligible next to a real snapshot. It
combines normally with the existing multi-recipient mechanism (a hybrid primary +
an X25519 backup, or vice versa — either identity restores) and with
`CYPHER_BRAIN_PIN_RECIPIENTS`.

A different risk lives in the plaintext sources themselves, not the crypto:
`snapshot --scan-secrets warn|deny|off` runs [gitleaks](https://github.com/gitleaks/gitleaks)
over each `--dir`/`--profile` source's staged plaintext *before* it is
archived+encrypted, and `deny` refuses the whole snapshot if a component has
findings. Because Arweave/Turbo are write-once, un-deletable backends, an
accidentally-committed API key/token/password can never be scrubbed out after
the fact — the ciphertext sealing it stays parked there permanently, exposed
to whatever might compromise the identity down the line.

**It defaults to `warn`** (#301) whenever there is a `--dir`/`--profile` source and
gitleaks is resolvable. On a machine without gitleaks nothing scans, nothing errors,
and no new dependency appears — that implicit skip is the one path allowed to stay
quiet, because nobody asked for a gate and nothing claims one ran. An *explicit*
`--scan-secrets` that cannot scan still refuses. `off` turns the default off out
loud, which is the point: it is a decision you record, not the absence of one.

The gate is reachable from every surface that can take a snapshot, not just the
interactive one (#307): `schedule install --scan-secrets warn|deny|off` bakes it into
the unattended nightly (and refuses to install if gitleaks cannot be resolved,
rather than registering a schedule that cannot scan), and the MCP `snapshot_now`
and `schedule_install` tools take the same `scan_secrets` field. `schedule install`
bakes the **effective** mode even when you pass nothing, so a nightly never re-derives
a default from whatever is on `PATH` at 03:30 months later. It scans `--dir`/`--profile` staged
plaintext, so asking for it with no such source (a `--pg`-only snapshot, whose
dump it does not scan) is **refused**: a caller told a scan ran when it inspected
nothing is worse off than one told it did not run at all.

Know what it does not cover, so the gate is not mistaken for a guarantee: gitleaks
reads files as they are and does not look **inside archives**, so a zip/tar source
— notably `--profile chatgpt-export`, which archives the export zip as-is — is
scanned only as opaque bytes, and a secret inside it is not found even though the
run reports the mode. Extract such an export and snapshot the directory if you
want the gate to cover its contents. `--profile o2b`'s bundle is plain JSON, not an
archive, so gitleaks does read its actual text content the same as any other file.

### There is no delete

cypher-brain has no `forget`, `prune` or `delete` command, and will not grow one
(#301). Once a snapshot is pushed to `arweave`/`turbo` it is parked permanently, and
destroying your identity is not an escape hatch either: the backup recipient this
project tells you to keep — and the printable recovery kit, if it carries one — still
decrypts everything. **Recoverability was chosen over erasability, deliberately.** A
per-snapshot key would buy [cryptographic erase](https://csrc.nist.gov/pubs/sp/800/88/r2/final)
at the cost of the recovery story this tool exists for, and that trade was declined.

What is parked is *ciphertext*. A secret that reaches a snapshot is not published — it
is sealed to your key, and stays exposed only to whatever might compromise that key
later. That is the honest shape of the risk, and it is exactly why the one preventive
measure now runs by default rather than on request: the only workable answer is to not
seal the secret in the first place.

The naming discipline is borrowed from [restic](https://restic.readthedocs.io/), whose
docs are explicit that `forget` alone removes nothing and that `prune` is the separate
step that does. A command that *sounds* like deletion while the ciphertext stays public
would be worse than not having one. The position itself is
[Perkeep's](https://perkeep.org/doc/principles) — a permanent store is allowed to say it
does not delete, as long as it says so before you push rather than after you leak.

## Install

Install from the registry (requires node >= 22.6.0 — the age crypto layer is
bundled, nothing else to install):

```sh
npx cypher-brain --help            # zero-install, one-off
npm install -g cypher-brain        # or on PATH permanently: `cypher-brain`, `cypher-brain-mcp`
cypher-brain --version             # which build you ended up with (bare version on stdout)
```

The packaged bins are the bundled `dist/` artifacts — self-contained single
files that run on plain Node.

Or run from source (the committed `bin/` shims run straight off `src/`, no
build step — this dev path needs Node >=22.6.0, the release that added the
`--experimental-strip-types` flag the shims re-exec under):

```sh
git clone https://github.com/Masashi-Ono0611/cypher-brain
cd cypher-brain && npm install
node bin/cypher-brain.mjs --help   # bin/cypher-brain-mcp.mjs is the MCP server
```

To expose the `cypher-brain` / `cypher-brain-mcp` commands from a checkout,
build first — the package `bin` entries point at the gitignored `dist/`
bundles, so a bare `npm link` silently creates no commands ([Bun](https://bun.sh)
required for the build):

```sh
npm run build && npm link
```

Before opening a PR: `npm run lint` (biome, `--error-on-warnings` — also gated
in CI) and `npm run verify` (build + typecheck + the full selftest suite +
CLI/MCP smoke) should both pass. `npm run format` applies biome's formatting.

**Prerequisites for `--pg`:** the `pg_dump`/`pg_restore` client tools (e.g.
`brew install libpq` or your distro's `postgresql-client`) — without them the
headline `--pg` flow fails with a cryptic `spawn pg_dump ENOENT`. If they are not
on `PATH`, point `CYPHER_BRAIN_PG_BIN` at their directory. `tar` is assumed
present. For the paid **upload** backends: `--backend turbo` needs
`@ardrive/turbo-sdk`, which ships as an `optionalDependency` — a normal
registry or from-source install already carries it, with the package manager
resolving its transitive tree (#363; an install run with `--omit=optional`
falls back to the CLI's own install advice). `--backend arweave` still needs
its optional peer next to your project: `npm install arweave` (a from-source
checkout already has it from its `npm install`). Recovery pulls from an
Arweave gateway need no extra dependency.

## Usage

### Quickstart

New here? `cypher-brain init` is the recommended starting point: an interactive
wizard that walks keygen, an offline backup key, passphrase-wrap,
`CYPHER_BRAIN_PIN_RECIPIENTS`, a `--profile`, a `--pg` dump when it detects a local
gbrain config, and the first snapshot + push in one sitting, ending in a printable
recovery kit (see MANAGEMENT.md's "Key recovery" section for what each step means).

```sh
cypher-brain init
```

That's it. The manual flow below is exactly what it wraps — useful once you know
what you want, or for scripting/automation `init` itself refuses (it is
interactive only).

`init` finishing, and each successful paid `push` to arweave/turbo/ton-provider (never a
`--skip-unchanged` no-op, and never the free `file` backend), print a short
STDERR-only note (a note from the person who built this, or a cited quote from an
encryption/privacy precursor) alongside the mascot — decoration only, never mixed
into `--save-locator`/stdout or the MCP server's output.

#### Choosing a paid store: Arweave vs. TON Storage

`init`'s wizard presents both as a straight choice (a `select()` prompt, one hint
line per option) — this is the same tradeoff spelled out:

| | Arweave (`turbo`) | TON Storage (`ton-provider`) |
|---|---|---|
| **Pay** | Once, at upload | Once per deploy, to a provider who must keep renewing |
| **Durability** | Network-guaranteed permanence | Depends on the chosen provider staying up (see [`docs/durability.md`](docs/durability.md)) |
| **Signing** | Local JWK wallet — fully unattended, works under `schedule install` | A human signs a Tonkeeper deeplink each push by default; a local TON wallet (`wallet create --chain ton`, `CYPHER_BRAIN_TON_WALLET`) auto-signs instead, making it fully unattended and `schedule install`-eligible too |
| **Cost preview** | `estimate --backend turbo` (winc + USD) | `estimate --backend ton-provider` (nanoTON + USD) |
| **Recommended for** | Most users — the default | An explicit TON-network choice |

Both are real, working "pay once, don't run your own server" options — see
[Backends](#backends) for the full mechanics of every backend, including the
self-hosted `ton` seeder mode this table deliberately leaves out (that one needs
an always-on box of your own, so it isn't part of the wizard's default choice).

### Manual flow

```sh
cypher-brain keygen                 # one-time: creates ~/.cypher-brain/{identity.age,recipient.txt}
# cypher-brain keygen --pq          # or: a post-quantum HYBRID keypair (ML-KEM-768 + X25519) —
#                                     mitigates harvest-now-decrypt-later, see Threat model above

# encrypt a gbrain snapshot (pg_dump + the ~/.gbrain dir) to your PUBLIC key.
# Add a second --recipient (an OFFLINE backup public key) so losing one identity
# never loses the brain — single-key snapshots warn on stderr. See MANAGEMENT.md.
#
# This example is a POSTGRES-backed gbrain. On PGLite (gbrain's default engine)
# there is no server: the database is a directory at the configured database_path,
# so drop --pg and let --dir cover that path. snapshot then warns that a running
# cluster's files are being copied without pg_dump's point-in-time consistency, so
# the copy may be inconsistent — stop gbrain first when you can. See MANAGEMENT.md
# "Avoid the write window", which also states how deep the detection looks.
# --dir here assumes the default ~/.gbrain. If gbrain's OWN GBRAIN_HOME env var
# relocates its home elsewhere, gbrain actually lives at $GBRAIN_HOME/.gbrain —
# use that path instead (cypher-brain doctor/init already detect this).
cypher-brain snapshot \
  --pg "postgres://user@localhost:5432/gbrain" \
  --dir ~/.gbrain \
  --recipient ~/.cypher-brain/recipient.txt \
  --recipient ~/.cypher-brain-backup/recipient.txt \
  --out brain-2026-06-27.age

cypher-brain verify --in brain-2026-06-27.age      # real ciphertext? wrong key rejected?

cypher-brain estimate --in brain-2026-06-27.age --backend turbo   # preview the cost — uploads nothing

# park the ciphertext permanently on Arweave (storage only ever sees ciphertext).
# push pays a one-time bundler fee (<100 KB free) and needs a JWK wallet;
# pull is a plain gateway fetch — no wallet, no npm package.
cypher-brain wallet create                 # one-time: writes ~/.cypher-brain/wallet.json (0600)
cypher-brain wallet address                # prints the address — fund THIS one (crypto or a card;
                                            # see docs/arweave-upload-runbook.md), then push:
TX=$(CYPHER_BRAIN_AR_WALLET=~/.cypher-brain/wallet.json \
  cypher-brain push --in brain-2026-06-27.age --backend turbo --yes)  # prints the locator (tx id)
cypher-brain pull --locator "$TX" --backend turbo --out got.age \
  --wait 1200    # fetch it back, anywhere (a fresh upload takes minutes to hit gateways)

# later, on the machine that holds your PRIVATE identity:
# (a PGLite brain has nothing to pg_restore — drop --pg and point gbrain at the
# extracted store directory. If it will not open, gbrain's own
# "gbrain pglite-repair" targets a torn write-ahead log and is worth trying against
# the extracted copy, never a live store — no guarantee it fixes every case. See
# MANAGEMENT.md "Restore runbook".)
cypher-brain restore \
  --in got.age \
  --out-dir ./restored \
  --pg "postgres://user@localhost:5432/gbrain_restore"

# make it nightly + unattended: generates the runner and the launchd/cron trigger
# (paid backends require --max-spend so an unattended run can never spend uncapped)
# --ping-url adds a healthchecks.io-style dead man's switch: the runner pings it on
# success, <url>/fail on failure, so a silently-stopped schedule gets noticed.
cypher-brain schedule install --backend turbo --pg "postgres://user@localhost:5432/gbrain" \
  --dir ~/.gbrain --max-spend 500000000 --ping-url https://hc-ping.com/<uuid>
cypher-brain schedule status   # last run + rc, next scheduled run, ping-url config

# any time: a read-only health check of the setup above (permissions, identity/recipient
# pairing, an empty CYPHER_BRAIN_PIN_RECIPIENTS, an offline backup on the same disk, the
# last scheduled run) — each problem comes with the exact command that fixes it.
cypher-brain doctor
```

`verify`, `estimate`, and `schedule status` each also take `--json` for a
single machine-readable object instead of the printed report — the same
fields the equivalent MCP tool (`verify_restore`/`estimate_cost`/
`schedule_status`, see below) returns, so scripts and the MCP server never
disagree. `doctor --json` is the same idea (one machine-readable object,
documented in `cypher-brain doctor --help`) but has no MCP tool yet.

### Profiles

Not running gbrain? `--profile` is a one-flag entry point for the common
sources — it resolves to the same `--dir` assembly (extra `--dir` flags are
appended after the profile's paths) and records the profile name in the
manifest:

```sh
# Claude Code: every ~/.claude/projects/*/memory/ + ~/.claude/CLAUDE.md
# (whichever exist; errors if none do)
cypher-brain snapshot --profile claude-code --out claude-memory.age

# Obsidian: the whole vault (must contain .obsidian/; --force-vault to override)
cypher-brain snapshot --profile obsidian --vault ~/Vaults/main --out vault.age

# ChatGPT: the official data-export zip, archived as-is (never extracted)
cypher-brain snapshot --profile chatgpt-export --zip ~/Downloads/chatgpt-export.zip --out chatgpt.age

# Open Second Brain: the "o2b brain bank-export --out <path>.json" bundle, archived
# as-is (never extracted; must end in .json)
cypher-brain snapshot --profile o2b --export ~/bank-export.json --out o2b.age
```

Restoring one of these is the same `cypher-brain restore --in <file.age> --out-dir <dir>`
as any other snapshot — no `--pg` needed. `restore` auto-expands every component into
`<out-dir>/expanded/<NNN>-<source basename>-<digest>/`, keyed to its original absolute
source path, so many same-basename sources (e.g. dozens of claude-code project
`memory/` dirs) still land in separate directories — even across two separate restores
into the same `--out-dir` — instead of an undifferentiated pile of `memory.tar.gz` /
`memory-1.tar.gz` / etc — see MANAGEMENT.md's Restore runbook.

### Excluding files (`.cypherbrainignore`)

A `.cypherbrainignore` file at the root of a `--dir` (or a `--profile`-resolved
directory) filters what gets archived from that directory, using the same syntax
as `.gitignore` (matched by the well-known [`ignore`](https://www.npmjs.com/package/ignore)
npm package, not a hand-rolled glob):

```
# .cypherbrainignore, dropped at the root of the --dir you're backing up
node_modules/
.git/
*.log
!important.log
```

`node_modules/`, build caches, and other churn you'd never want tar'd, encrypted,
and — on a paid backend — permanently stored no longer have to ride along just
because they live under a backed-up tree. No `.cypherbrainignore` present =
unchanged behavior (every path archived, exactly as before). A single-file `--dir`
source (a `--profile` file/zip) has no tree to filter and is always archived as-is.

Preview the effect before spending anything:

```sh
cypher-brain snapshot --dir ~/some/big/project --dry-run
```

`--dry-run` prints, per `--dir`, whether a `.cypherbrainignore` was found and the
include/exclude file list with an approximate byte total for each side, plus the
largest contributors (up to the top 10 by bytes, aggregated one directory level
deep, with each one's share of the total; beyond 10 the rest are folded into one
`other (N more)` remainder line so every byte of the source is accounted for
across what's shown plus that line — the percentages are rounded to one decimal
place and are not guaranteed to sum to exactly 100%) — with or without a
`.cypherbrainignore`, so you can see what you are about to pay to store
permanently before you have written a filter for it. No `--out`, staging, or
encryption happens.

### Staging & env vars

Each component (the `pg_dump`, each `--dir` archive) is staged into a private
(0700) temp dir, then the bundle is streamed `tar -> age`, so the final ciphertext
never loads into memory. The staged plaintext is erased even on failure, so it
doesn't linger — but staging needs scratch space about the size of the snapshot,
so point `TMPDIR` at a disk with room for large brains. The Postgres connection
string is passed as a process argument; for password auth use `~/.pgpass` or
`PGPASSWORD` so secrets stay out of the process list. Binary paths are overridable
for non-PATH installs: `CYPHER_BRAIN_PG_BIN` (dir holding
`pg_dump`/`pg_restore`), `CYPHER_BRAIN_HOME`. Storage backends read
`CYPHER_BRAIN_FILE_DIR` (file backend object store).

### CLI reference

The full `cypher-brain --help` output, kept byte-for-byte in sync with the
`HELP` text in `src/cli.ts` by `scripts/check-help-docs.mjs` (CI-enforced —
issue #227; this section drifting out of date from real CLI behavior is what
issue #40 hit before this check existed). The `${IDENTITY}` line below shows a
fixed, synthetic `CYPHER_BRAIN_HOME` path (`/home/user/.cypher-brain`), not
your actual home directory — that keeps this block identical on every
machine, including CI.

After changing `HELP`, regenerate this block and commit the diff:

```sh
node scripts/check-help-docs.mjs --write
```

<!-- HELP-START: auto-generated by scripts/check-help-docs.mjs — do not edit by hand -->

```text
cypher-brain — encrypt a gbrain snapshot so only you can read it

  cypher-brain --version
      Print the version this build was packaged with (the "version" field of the
      installed package.json) on stdout and exit 0 — nothing else, so it can be
      captured straight into a variable. "-V" is the same thing.

  cypher-brain <command> --help
      Print just that command's section of this reference (plus the Env/Storage/
      Spend/Consent block below, which applies to every command). Plain
      "cypher-brain --help" prints the whole thing, as it does here.

  cypher-brain init
      Recommended for a FRESH setup: an interactive wizard that walks keygen -> an
      offline backup keypair (optional) -> passphrase-wrap (optional) -> a
      CYPHER_BRAIN_PIN_RECIPIENTS suggestion -> --profile selection -> the first
      snapshot + push, ending in a printable plain-text recovery kit (the backup
      identity + latest locator + exact recovery commands). Refuses if an identity
      already exists (init is for a fresh setup, not overwriting one — use keygen
      --force, or drive the commands below by hand, to redo it) and requires a TTY
      on stdin (it is interactive, not automatable).

  cypher-brain keygen [--passphrase] [--force] [--pq] | keygen --wrap-in-place | keygen --sign
      Create your age keypair: identity (PRIVATE) + recipient (PUBLIC).
      --passphrase wraps the identity at rest with a scrypt passphrase (prompted on the
      TTY); restore/verify then prompt for it. Identity = /home/user/.cypher-brain/identity.age
      --pq generates a POST-QUANTUM HYBRID keypair (ML-KEM-768 + X25519, via typage's
      generateHybridIdentity()) instead of plain X25519 — mitigates "harvest now,
      decrypt later" against a future quantum computer (see README Threat model), at
      the cost of a MUCH bigger recipient/identity and per-recipient ciphertext
      overhead (recipient ~1.9KB vs ~62 bytes for X25519; negligible next to a real
      snapshot). Combines normally with --recipient (a hybrid primary + an X25519
      backup, or vice versa, both work — pick whichever identity "restore" is called with).
      --wrap-in-place passphrase-protects the EXISTING identity WITHOUT generating a new
      keypair (unlike --force, which always creates a brand-new one and makes every prior
      snapshot unrecoverable) — use this if you skipped the passphrase step during "init"
      or a bare keygen and want to add one later. Refuses if the identity is already
      wrapped, or if none exists yet.
      --sign (#214) generates a SEPARATE minisign-compatible Ed25519 SIGNING keypair
      instead of an age keypair — an independent mode (like --wrap-in-place; the two are
      mutually exclusive), so it can add authenticity to an existing setup without
      touching the age identity at all. age gives confidentiality + tamper detection but
      NOT authenticity (a recipient's public key is not secret — anyone holding it can
      forge ciphertext that decrypts cleanly); signing the *.age ciphertext and verifying
      BEFORE decrypt (see restore/verify below) closes that gap. Writes
      $CYPHER_BRAIN_HOME/sign-identity.key (PRIVATE) and sign-recipient.pub (PUBLIC, in
      the reference minisign CLI's own wire format — verifiable with a real
      "minisign -V -p sign-recipient.pub"). --passphrase/--force apply to it the same way
      they do to the age identity above; --wrap-in-place does not (age-only).

  cypher-brain wallet create [--out <path>] [--force] [--chain arweave|ton]
      Generate a fresh signing credential. --chain arweave (default) generates an
      Arweave JWK for the arweave/turbo storage backends (needs the 'arweave' package —
      a peerDependency, same as those backends). Defaults to $CYPHER_BRAIN_HOME/wallet.json;
      --out picks a different path. Prints the wallet path (PRIVATE) and its derived
      address (PUBLIC — fund THIS one). Refuses to overwrite an existing wallet file
      (same no-clobber posture as keygen); --force to replace it. Written 0600, same
      fail-closed handling as the age identity.
      --chain ton generates a TON wallet (a 24-word BIP39 mnemonic, WalletContractV4 —
      needs the '@ton/ton'/'@ton/crypto' packages, both optionalDependencies) for the
      ton-provider backend's auto-signing mode (issue #396 PR2). Defaults to
      $CYPHER_BRAIN_HOME/ton-wallet.json; same --out/--force/0600 posture as the arweave
      form. Set CYPHER_BRAIN_TON_WALLET to the written path afterward so 'push --backend
      ton-provider' signs and broadcasts deploys itself instead of printing a Tonkeeper
      deeplink for a human to approve — see push's --backend ton-provider section below.
      The printed address is the bounceable ("EQ...") encoding; some wallets/explorers
      may show the same account as its non-bounceable ("UQ...") counterpart — both refer
      to the same address (issue #483).

  cypher-brain wallet address [--wallet <path>] [--chain arweave|ton]
      Derive and print the address a wallet spends from, without uploading/deploying
      anything. --wallet defaults to CYPHER_BRAIN_AR_WALLET (--chain arweave, the
      default) or CYPHER_BRAIN_TON_WALLET (--chain ton), then to the matching 'wallet
      create' default path. Use this to confirm you are funding the SAME wallet
      cypher-brain will sign with (for --chain ton, this is also the address that
      becomes the StorageV1 contract's owner — see push's --backend ton-provider
      section).

  cypher-brain wallet balance [--wallet <path>] [--address <addr>] [--json] [--chain arweave|ton]
      --chain arweave (default): print what an address can actually spend on the turbo
      backend: its OWN Turbo Credit balance, its SPENDABLE balance (own + Credit Share
      Approvals delegated to it), and every approval received/given with the winc
      remaining on it and when it expires. Answers the three questions a top-up asks —
      did my purchase land, did the share to this wallet land, how much is left — which
      otherwise need a hand-written @ardrive/turbo-sdk script. A plain unauthenticated
      GET against the payment service keyed on a PUBLIC address: no '@ardrive/turbo-sdk'
      install, no signature. --address queries ANY address without a key or wallet file
      (this is how you check the browser/MetaMask wallet you bought credits on — the one
      whose JWK this machine by definition does not have). Without it, the address is
      derived from the JWK, with the same --wallet / CYPHER_BRAIN_AR_WALLET /
      $CYPHER_BRAIN_HOME/wallet.json fallback 'wallet address' uses. Warns when a
      received approval exists but CYPHER_BRAIN_AR_PAID_BY does not name its payer — a
      push cannot draw on an approval it is not told about, so credits that look
      spendable here would not be. --json prints the same fields as one JSON line on
      stdout instead.
      --chain ton: print the address's on-chain nanoTON balance (tonapi, no key needed
      with --address) plus an approximate USD line (tonUsdRate). --json emits
      {address, balance_nanoton, status} as one JSON line instead — nanoTON only, no USD
      figure (the human-readable form's USD line is a display-time convenience, not a
      persisted field).

  cypher-brain doctor [--json]
      Non-destructive environment health check (#201): inspects the EXISTING setup for the
      permission/config problems several past issues were filed for (the running
      build's provenance — which commit it was built from and how many days old that
      is, WARNing past 90 days; a hand-copied deployment once ran 5+ weeks stale with
      documented features silently absent, #348 — plus: age identity 0600,
      $CYPHER_BRAIN_HOME 0700, an Arweave JWK wallet's permissions, an identity/recipient
      pairing mismatch (including an unexpected EXTRA recipient in recipient.txt that the
      identity does not derive), an empty CYPHER_BRAIN_PIN_RECIPIENTS fail-closing every
      snapshot, any recipient.txt entry missing from that same allowlist (not just the
      primary one), an offline backup keypair sharing a disk with the primary identity at
      its default location, the last scheduled run's outcome, the audit log's hash-chain
      integrity, and the receipt ledger's readability — #456) and reports
      PASS/WARN/FAIL/SKIP per check, each FAIL/WARN paired with the exact command that
      fixes it. Nothing not yet set up (no wallet, no schedule, ...) is treated as a
      failure — it SKIPs instead, EXCEPT a path explicitly configured via an environment
      variable (e.g. CYPHER_BRAIN_AR_WALLET) pointing at nothing, which is a FAIL. A
      permission-denied path, a symlink loop, or an unexpected file type (e.g. a FIFO) is
      its own FAIL rather than folded into the same result an absent path gets.
      audit-chain-integrity/receipt-ledger-readability (#456) reuse 'audit'/'ledger''s
      own reading+verification logic (never a re-implementation), so doctor can never
      report a healthy score in a $CYPHER_BRAIN_HOME where those commands themselves
      report a problem: a broken audit-log hash chain, or any unreadable line in it that
      could hide a deleted/altered entry, is a FAIL (a security-critical trust-boundary
      break); an unreadable line in the receipt ledger is only a WARN (a data-quality
      issue — 'ledger' totals may undercount, nothing security-critical). Neither file
      existing yet is SKIP, same posture every other not-yet-set-up check above takes.
      Keeps a small bookkeeping file ($CYPHER_BRAIN_HOME/doctor-state.json — check ids and
      timestamps only, never key material) between runs so a WARN/FAIL you have already
      seen is marked "known" rather than re-surprising you every time you run this, while
      a genuinely NEW one is marked with a "new" marker and costs MORE against
      health_score than a known, still-unfixed one — a discount, not a full exclusion (a
      lingering FAIL still pulls the score down, so it can never read a healthy 100/100
      next to VERDICT: FAIL), so the score mostly answers "did anything get WORSE since I
      last looked" rather than "have I fixed literally everything yet" (which would sit
      low forever for a risk you have deliberately accepted). Written only when
      $CYPHER_BRAIN_HOME already exists — doctor never creates it just to leave this file
      behind on a machine with nothing set up yet.
      VERDICT: PASS (exit 0, no WARN/FAIL) / PARTIAL (exit 2, WARN only) / FAIL (exit 1,
      any check FAILs) — same three-way convention as "verify".
      --json prints one JSON object to stdout instead of the human-readable report
      (checks: [{id, status, message, remediation?, marker, since?}], resolved: [...],
      health_score, new_count, carryover_count, verdict, state_path, state_saved) — the
      SAME computation as the human-readable report, never a re-implementation.

  cypher-brain ledger [--json] [--csv]
      Read-only cumulative-cost report (#232): every "push --backend arweave|turbo|
      ton-provider" that actually spent money writes a RECEIPT ($CYPHER_BRAIN_HOME/
      receipt-ledger.jsonl, or CYPHER_BRAIN_RECEIPT_LEDGER — an append-only JSONL file,
      one object per upload, INCLUDING a separate entry for the .minisig signature
      sidecar upload when a signed artifact is pushed — that is its own paid upload too)
      — the best available native-unit cost figure alongside the backend's own response:
      for the raw arweave L1 backend and for ton-provider, the authoritative amount
      actually committed (arweave's signed transaction reward; ton-provider's storage
      cost plus deploy buffer, confirmed on-chain before push returns); for turbo, the
      pre-flight estimate that gated that specific upload (Turbo's SDK response has no
      separately-confirmed charged-amount field to read back — not a confirmed post-hoc
      debit, the best figure available). This is deliberately separate from "estimate"'s
      pre-flight forecast (never conflated) — it answers "what did we actually spend" and
      "how much cumulatively", not "what would this cost". file/rclone/ton pushes never
      write a receipt (nothing paid, or no receipt object to persist) and so never appear
      here. With no receipts yet, prints one line saying so (exit 0 — an empty ledger is
      a normal state, not an error). A ledger line that cannot be read at all (malformed/
      wrong-shape/future-version) is skipped and WARNS on stderr with a count — never
      silently treated as "no receipts" (a genuinely missing/never-created ledger file
      still reports zero receipts with no warning). If EVERY line was unreadable (0
      receipts survived, but at least 1 was skipped), the human report prints a visibly
      DIFFERENT line than the true-empty case, naming the skipped count, so "no receipts"
      is never confused with "no receipts COULD BE READ" (#457).
      Human report (default): total receipt count, cost summed BY BACKEND, BY MONTH and
      BY DAY (UTC, most recent 14 shown) — each sum kept separate PER NATIVE UNIT
      (winston/winc/nanoton are different currencies, never added together). A receipt
      with no priceable cost is "unpriced" (excluded from every sum); one with a priced
      cost but an unparseable timestamp is "undated" (still counted in by-backend,
      excluded only from by-day/by-month) — the two are reported as distinct counts,
      never conflated.
      --json prints one object ({total_receipts, unpriced_receipts, undated_receipts,
      skipped_lines, by_backend, by_day, by_month, receipts: [...every receipt...]}) —
      the same computation as the human report, plus the full receipt array for a script
      to reprocess without a second call.
      --csv prints one row per receipt (timestamp, backend, locator, artifact_sha256,
      size_bytes, payer_address, cost, unit, raw — RFC 4180 minimal quoting) instead of
      an aggregate — wins over --json if both are given (a raw export, not a summary).
      Every receipt line — CLI-written or hand-authored/migrated — must ALSO carry a
      top-level "cypher_brain_receipt_version" field equal to this build's receipt
      version (currently 1); it is omitted from the --csv/--json field lists above
      because the CLI always stamps it itself and it never varies per receipt, but a
      line missing it (or with a mismatched value) is rejected as unreadable, same as
      malformed JSON — not silently defaulted or dropped from the count.

  cypher-brain audit [--json]
      Read-only hash-chain verification (#226): every "push"/"restore"/"verify" run
      (success OR failure) appends an entry to $CYPHER_BRAIN_HOME/audit-log.jsonl (or
      CYPHER_BRAIN_AUDIT_LOG — an append-only JSONL file), each entry's hash bound to the
      PREVIOUS entry's hash. This is a local integrity check against accidental or casual
      tampering, not a cryptographically authenticated log — same trust boundary as any
      other file under $CYPHER_BRAIN_HOME (the identity key included): someone who can
      already write there can also rewrite the whole chain consistently. It is a
      different concept from both the MCP idempotency log (replay detection) and "ledger"
      above (cost data, paid backends only) — this one covers every command, records no
      cost, and never mutates or drops a past entry on its own. This command recomputes
      and checks the chain; it never writes to the log itself. With no entries yet,
      prints one line saying so (exit 0 — a fresh machine has an empty, valid,
      trivially-passing chain).
      A log line that cannot be read at all (malformed/wrong-shape/future-version, or a
      field whose type doesn't match what this version writes) is skipped, WARNS on
      stderr with a count, and — unlike "ledger"'s own unreadable-line handling — makes
      the OVERALL verdict FAIL: an unreadable line is exactly what deleting or badly
      corrupting an entry looks like, so it is treated as a possible tamper, never a
      benign gap to silently subtract from the total.
      Human report (default): total entry count, the last entry's timestamp/command/
      exit code, and VERDICT: PASS or FAIL (exit code 1 on FAIL, naming the reason —
      a broken chain link and/or unreadable lines, either one alone is sufficient to fail).
      --json prints one object ({total_entries, chain_valid, broken_at_index,
      skipped_lines, last_entry, entries}) — chain_valid reflects ONLY whether the
      entries that COULD be read form a valid chain among themselves; combine it with
      skipped_lines yourself for the same overall PASS/FAIL the human report and exit
      code use (chain_valid && skipped_lines === 0). "entries" is every readable entry
      in log order (oldest first — index N lines up with broken_at_index when set), the
      full trail to list/browse via the CLI (#458) without reading audit-log.jsonl
      directly; "last_entry" is kept too (entries[entries.length-1]) for scripts already
      reading it.

  cypher-brain snapshot --out <file.age> [--profile <name>] [--pg <conn>] [--pg-table <t>]...
                         [--pg-filter <file>] [--pg-exclude-table-data <t>]... [--dir <path>]...
                         [--recipient <pubkey|file>]... [--dry-run] [--scan-secrets warn|deny|off]
                         [--no-sign] [--sign-identity <file>]
      Bundle a pg_dump and/or directories, encrypt to the PUBLIC recipient(s).
      A ".cypherbrainignore" file (gitignore-compatible syntax; the "ignore" npm package
      does the matching, not a hand-rolled glob) at the ROOT of a --dir (or a --profile-
      resolved directory) filters what gets archived from that directory — node_modules,
      caches, credential files etc. never need to be tar'd, encrypted or paid for. No file
      -> unchanged behavior (every path is archived, exactly as before #216). The pre-rename
      name ".cipherbrainignore" is still read when no ".cypherbrainignore" exists. A single-file
      --dir source (a --profile file/zip) is archived as-is; it has no tree to filter.
      --dry-run previews --dir/--profile filtering WITHOUT writing, staging or encrypting
      anything (--out is not required): prints, per --dir, whether a .cypherbrainignore was
      found and the include/exclude file list with an approximate byte total for each side,
      PLUS the largest contributors (up to the top 10 by bytes, aggregated one directory
      level deep, with each one's share of the total; beyond 10 the rest are folded into
      one "other (N more)" remainder line so every byte of the source is accounted for
      across what's shown plus that line — the percentages are rounded to one decimal
      place and are not guaranteed to sum to exactly 100%) — with or without a
      .cypherbrainignore, so you can see what you are about to pay to store permanently
      before you have written a filter for it — the "capacity difference" a
      --recipient/--pg pipeline never touches until you drop --dry-run and
      actually run the snapshot.
      Also records a deterministic PLAINTEXT content digest (mtime-independent) in the
      manifest and in a "<out>.digest" sidecar, PLUS a recipients fingerprint (the
      effective age1… recipient set actually encrypted to) in a
      "<out>.recipients-fingerprint" sidecar — push --skip-unchanged reads BOTH
      sidecars and only skips when neither the content nor the recipient set changed,
      so it never re-pushes unchanged content to a paid store, and never skips past a
      changed --recipient set.
      Pass --recipient more than once (a primary + an offline backup key) for key
      recovery: any one of those identities can restore. The snapshotting machine
      never needs a private key.
      --profile is a one-flag source preset (recorded in the manifest); extra --dir
      flags are appended after the profile's paths:
        claude-code                  ~/.claude/projects/*/memory/ + ~/.claude/CLAUDE.md
                                     (whichever exist; errors if none do)
        obsidian --vault <path>      the vault directory (must contain .obsidian/;
                                     --force-vault to snapshot a vault-less dir anyway)
        chatgpt-export --zip <path>  the official ChatGPT export zip, archived as-is
                                     (never extracted)
        o2b --export <path>          an Open Second Brain bank-export bundle
                                     ("o2b brain bank-export --out <path>.json"), archived
                                     as-is (never extracted; must end in .json)
      --vault/--zip/--export are each refused unless --profile matches the one that reads
      them (--vault only with --profile obsidian, --zip only with --profile chatgpt-export,
      --export only with --profile o2b) — passing one without its matching --profile is an
      error, not a silently-ignored flag (#525/#526).
      --pg-filter <file> and --pg-exclude-table-data <table> are a thin, literal pass-through
      to pg_dump's OWN standard flags (--filter / --exclude-table-data) — cypher-brain does
      no SQL parsing or filtering of its own; pg_dump does exactly what it would if you ran
      it by hand with the same flags. Use them to build a "minimal recovery profile" snapshot
      alongside your normal full one: exclude large/low-value tables (raw conversation logs,
      embedding caches, tool-run logs) while keeping table structure and everything else.
      --pg-filter <file>            pg_dump --filter <file>: a file of one
                                     "{include|exclude} {table|schema} PATTERN" line per
                                     entry (repeatable in --pg-table); requires pg_dump >= 17.
                                     Docs: https://www.postgresql.org/docs/current/app-pgdump.html#PG-DUMP-FILTERING
                                     Example file:
                                       include table conversation_summaries
                                       exclude table conversation_logs
                                       exclude table embedding_cache
      --pg-exclude-table-data <t>   pg_dump --exclude-table-data <t> (repeatable): keep the
                                     table's SCHEMA in the dump but drop its ROWS — e.g. a
                                     large cache table you want restorable-empty rather than
                                     absent entirely.
      Both are additive to --pg-table and to each other; omit them and --pg behaves exactly
      as before (a full pg_dump, no filtering).
      --pg-table/--pg-filter/--pg-exclude-table-data are each refused when --pg <conn> is
      not also given (or is given empty) — they only filter what pg_dump dumps, so without
      --pg they would otherwise be silently ignored (#525/#526).
      --scan-secrets warn|deny|off (#215) runs gitleaks (install via
      https://github.com/gitleaks/gitleaks) over each --dir/--profile source's staged
      plaintext BEFORE it is archived+encrypted — Arweave/Turbo are write-once,
      un-deletable backends, so an accidentally-committed API key/token/password can
      never be scrubbed after the fact. DEFAULT (#301): warn, whenever there is a
      --dir/--profile source AND gitleaks is resolvable; otherwise nothing scans,
      nothing errors, and no new dependency appears. This is the only path that may
      skip quietly — you did not ask for a gate, so nothing claims one ran. An
      EXPLICIT --scan-secrets that cannot scan always refuses instead.
      warn: log any findings (rule ID + count only — never the matched
      secret, file path, or line) and proceed. deny: refuse the whole snapshot if
      any component has findings. off: do not scan, said out loud — the way to turn
      the default off without uninstalling gitleaks.
      Drop a .gitleaks.toml into a scanned source to
      customize/allowlist rules, same as you would for a git repo. It covers
      --dir/--profile sources only — a --pg dump is not scanned — so a snapshot with
      neither is REFUSED rather than reporting a scan that inspected no component.
      For the same reason it cannot be combined with --dry-run, which stages no
      plaintext for gitleaks to look at.
      KNOWN LIMIT, so you can judge what the gate is worth for your sources: gitleaks
      reads files as they are and does NOT look inside archives, so a zip/tar source
      (notably --profile chatgpt-export, which archives the export zip as-is) is
      scanned only as opaque bytes — a secret inside it will NOT be found, even
      though the run reports the mode. Extract such an export and snapshot the
      directory if you want the gate to actually cover its contents. --profile o2b's
      bundle is plain JSON, not an archive, so gitleaks DOES read its actual text
      content the same as any other file.
      Authenticity (#214): whenever a signing identity exists (default
      $CYPHER_BRAIN_HOME/sign-identity.key, from "keygen --sign"; --sign-identity picks
      a different one), snapshot ALSO writes a detached "<out>.minisig" signature over
      the ciphertext — automatic, no separate flag needed. restore/verify then check it
      BEFORE decrypting. --no-sign skips this even when a signing identity is present.
      No signing identity at all -> unchanged pre-#214 behavior (no *.minisig written).

  cypher-brain restore --in <file.age> --out-dir <dir> [--identity <file>] [--pg <conn>] [--yes] [--no-expand-components]
                        [--sha256 <hex>] [--sign-recipient <file>] [--require-signature] [--verbose]
      Decrypt with the PRIVATE identity. Extraction never clobbers a file already
      present in --out-dir: an existing file is left untouched, the rest of the
      archive still extracts around it, and the collision itself is not an error.
      That is restore's own behavior, not a flag you pass — it uses tar's own
      --skip-old-files on GNU tar and --keep-old-files on bsdtar, which are those
      two tars' spellings of the same thing.
      #527: one exception — a component's own <name>.tar.gz archive (the file the
      auto-expand step below re-reads and reports as coming from a specific manifest-
      recorded source) is compared byte-for-byte against what this restore just
      decrypted. If a pre-existing file at that name does NOT match, restore refuses
      the WHOLE run instead of silently expanding stale/unrelated data below and
      reporting it as if it came from that source. Restoring the exact same snapshot
      into the same --out-dir again still matches and proceeds normally. Nothing else
      in --out-dir gets this treatment (a mismatched manifest.json, db.dump, etc. keeps
      the plain no-clobber behavior above). Separately, a component archive that fails
      to auto-expand for any other reason (e.g. it does not actually parse as gzip)
      makes restore's own exit code non-zero, never masked behind a "restored
      components into ..." success line. This check is skipped entirely under
      --no-expand-components below: the danger it guards against is auto-expand
      mis-attributing stale data, and that step never runs in that mode, so a stale
      collision there is just the plain no-clobber case above (--no-expand-components
      still means exactly the pre-#181 behavior it always has).
      Every --dir/--profile component's staged tarball is then auto-expanded into
      "<out-dir>/expanded/<NNN>-<source basename>-<digest>/", keyed to the component's
      ORIGINAL absolute source path (from manifest.json) rather than its on-disk name —
      so components with a colliding basename (e.g. many claude-code project memory/
      dirs) still land in separate directories, even across two SEPARATE restores into
      the same --out-dir. A "expanded/README.txt" (and the same mapping on stdout)
      records which expanded directory came from which FULL source path. Nothing is
      ever written back to that original absolute path — this only ever
      creates NEW directories under --out-dir. Re-running restore into the same
      --out-dir does not clobber a prior expansion (same no-clobber posture as the outer
      extract). --no-expand-components skips this step, leaving only the raw *.tar.gz
      files (the pre-#181 behavior).
      --pg additionally pg_restore's the db.dump into that connection, independently of
      the expand step above (pg_dump's component has no "source" field, so the two never
      touch the same thing). pg_restore --clean --if-exists DROPS and replaces objects
      in the target database — an irreversible operation — so it requires --yes or
      CYPHER_BRAIN_YES=1 to confirm, same as push's paid-backend guard below. Bounded by
      the same pipe timeout as the decrypt/extract step (CYPHER_BRAIN_PIPE_TIMEOUT).
      --sha256 <hex> pins --in to an expected hash, checked FIRST — before authenticity
      and before any decryption. A mismatch refuses the restore outright (#645); this is
      the same out-of-band integrity pin pull() and verify() already fail-closed on.
      Authenticity (#214): checked next, still before any decryption. If "<in>.minisig"
      exists AND a signing public key is configured (default
      $CYPHER_BRAIN_HOME/sign-recipient.pub; --sign-recipient picks a different one),
      an INVALID signature refuses to restore outright (nothing is decrypted or written).
      An absent signature (unsigned/legacy artifact) or an absent signing public key on
      this box only warn and proceed — this never breaks a pre-#214 backup. --require-
      signature turns that warn into a refusal too: an attacker who simply DELETES the
      .minisig sidecar (rather than forging one) no longer silently succeeds either.
      By default (#436), the console output is a short summary: which components were
      auto-expanded and where they landed under expanded/ (see --no-expand-components
      above), not the full manifest.json backing it. --verbose additionally prints that
      raw manifest.json — tool, schema, created_at, and two fields worth knowing about
      before turning it on: host (the hostname of the machine that ran "snapshot" — not
      necessarily this one) and every component's original absolute SOURCE path on that
      machine. Leave it off unless you actually need those fields (e.g. debugging a
      manifest itself).

  cypher-brain verify --in <file.age> [--identity <file>] [--sha256 <hex>] [--sign-recipient <file>] [--require-signature] [--json]
                       [--level quick|remote|drill] [--verbose]
      Assert it is real age ciphertext, a wrong key cannot open it, AND (when the
      private identity is on this box) that YOUR key decrypts it into a well-formed
      bundle. --identity overrides the default identity path
      ($CYPHER_BRAIN_HOME/identity.age) — an EXPLICITLY-given --identity path that does
      not exist is a hard error (a typo, same as restore's own --identity), never the
      silent PARTIAL/[SKIP] a genuinely absent private identity gets when --identity is
      omitted entirely and the default path is also absent (#531). --sha256 also pins
      the artifact to an expected hash. Authenticity (#214):
      if "<in>.minisig" exists and a signing public key is configured (default
      $CYPHER_BRAIN_HOME/sign-recipient.pub; --sign-recipient overrides), verifies it
      too — an INVALID signature is a hard FAIL and skips the positive-control decrypt
      below (an artifact already known to be tampered/forged proves nothing by
      decrypting); no signature or no configured public key just [SKIP]s this check
      by default. --require-signature upgrades that [SKIP] to a hard FAIL too — use it
      once you have run "keygen --sign" and expect every artifact you verify to carry
      a valid signature; without it, an unsigned/legacy artifact still reaches PASS.
      VERDICT: PASS (exit 0) / FAIL (exit 1) / PARTIAL (exit 2 — decryptability not
      proven, e.g. public-key-only box).
      --level (issue #209) picks how deep the check goes, restic/kopia-style — each
      level is a strictly deeper (slower, more expensive) proof than the one before:
        quick  (default, unchanged): everything above, against the LOCAL --in file —
               no network access. Refuses --locator/--backend/--from-locator-file/
               --sig-locator (those name something to FETCH; quick never fetches
               anything).
        remote: pulls the artifact by --locator <id> --backend <name> (or
               --from-locator-file <path>, same contract as "pull") into a scratch temp
               file, then runs the SAME checks above against THAT — proving the object
               is still actually retrievable from storage and unchanged, not merely
               that a local copy still parses. Rejects --in (remote fetches instead).
               --sig-locator <id> (or the 6th --from-locator-file field, read
               automatically — same contract as "pull") ALSO fetches the "<in>.minisig"
               authenticity sidecar before running the checks above, so the signature
               check (and --require-signature) has something to verify against; omit it
               and remote/drill behave exactly as before #214 (ciphertext only).
        drill:  does everything remote does, and — only once those checks reach
               PASS — ALSO decrypts and extracts the pulled artifact into a scratch
               out-dir (the same code path "restore" runs), the full
               pull -> decrypt -> extract rehearsal MANAGEMENT.md's restore runbook
               describes. Refuses --pg (a verification drill must never run
               pg_restore against a live database); the scratch directory is always
               removed afterward, success or failure. Its non-JSON output is, by
               default, the same short component-expansion summary restore itself
               prints (#436) rather than the full manifest.json — pass --verbose
               (alongside --level drill) to see that manifest too. --verbose has no
               effect on --level quick/remote (neither ever reads a manifest.json) or
               on --json (already a single alternate machine-readable report, #211).
      A failed remote/drill fetch reports VERDICT: FAIL (exit 1) rather than a raw
      error — retrievability itself is what those two levels test.
      --json prints one JSON object to stdout instead of the human-readable report.
      quick: {file, size_bytes, checks: {age_header, sha256_match, signature,
      wrong_key_rejected, positive_control}, level, verdict, exit_code} — the SAME
      checks computed above, so it never disagrees with the human-readable report or the
      MCP verify_restore tool ("level" is "quick" — #536, matching remote/drill below;
      the plain-text report's first line is "level: quick" for the same reason). remote
      adds {pulled: {backend, locator, sha256_pin, fetched}} alongside checks. drill
      replaces positive_control's role with a {full_restore: true|false|"skip",
      full_restore_error?} pair once the pulled checks reach PASS. The exit code is
      unchanged either way. If the command ERRORS
      instead (#270 — a missing file, an unreadable identity), stdout carries an error
      object ({error, code, exit_code}) rather than nothing, so a --json caller never
      has to fall back to scraping stderr; "code" is the CB-E0xx identifier when the failure
      matches a known one (MANAGEMENT.md#error-codes), null otherwise.

  cypher-brain push --in <file.age> --backend <file|arweave|turbo|rclone|ton|ton-provider> [--remote <name>:<path>] [--yes] [--plan <path.json>] [--save-locator <path>] [--skip-unchanged] [--digest <hex>] [--force]
      Upload ciphertext to storage. Prints ONLY the locator to stdout
      (file: store path; arweave: tx id; turbo: ANS-104 data item id; rclone: the
      --remote value itself; ton: "ton:v1:<bag-id>"; ton-provider: "ton-provider:v1:<bag-id>").
      Storage sees ciphertext only.
      Transfer progress (#283) is printed to stderr on the backends that can actually be
      slow: turbo uploads (from the SDK's own progress events), rclone transfers (rclone's
      periodic stats, translated), an arweave gateway READ during pull, and ton-provider's
      wait for the chosen provider to finish fetching the bag over P2P (bytes downloaded
      so far, from its own self-reported status). file is a local copy and the L1 arweave
      upload is capped at ~10 MiB, so neither reports anything. How OFTEN depends on
      whether stderr is a terminal — roughly every 2s when a human is watching, roughly
      every 30s when it is a nightly log or an MCP tool result, both of which keep
      everything they are given.
      arweave/turbo are paid permanent stores — require --yes or CYPHER_BRAIN_YES=1;
      both print a native-unit cost estimate (winston/winc) before uploading, plus an
      approximate USD line when a USD/AR rate is fetchable — a rate failure drops that
      line only, never the native estimate. Preview the same estimate beforehand
      without pushing anything via "cypher-brain estimate".
      --plan <path.json> (#231): re-validate a plan file written by "estimate --out"
      against the CURRENT state before proceeding — refuses (before any consent prompt)
      if the artifact (sha256), backend, --remote, price (beyond a 10% drift tolerance),
      the configured payer address, or the recipients fingerprint (#469 — a recovery
      key added or removed) no longer match what was reviewed when the plan was made,
      or if the plan has expired (15 minutes after creation, not configurable).
      ADDITIVE to --yes/CYPHER_BRAIN_YES, not a replacement — a validated
      plan still has to clear that consent gate too, and CYPHER_BRAIN_MAX_SPEND (#105),
      enforced separately inside the upload itself, remains the actual cap on spend.
      A plan.json is a plain local file, not cryptographically signed — the same trust
      boundary as the wallet/identity key files already on disk, not a defense against
      someone who already has access to those. Works with any --backend (free backends
      just validate artifact/backend/remote/expiry; there is no price to drift). See
      "estimate" below for how a plan is created.
      --backend rclone --remote <rclone-remote-name>:<path> shells out to the
      rclone binary (rclone copyto <in> <remote>), delegating auth/protocol for
      any of rclone's 70+ supported providers to your own rclone config — cypher-
      brain implements none of them itself. Free (like file); needs rclone on
      PATH and a remote already set up via 'rclone config' (or a config-less
      on-the-fly remote, e.g. --remote ":local:/path"). --remote is required.
      --remote only applies to --backend rclone — every other backend ignores it, so
      passing --remote with a different --backend is refused up front rather than
      silently doing nothing (#655).
      No-clobber for rclone (#533): refuses to upload when an object already
      exists at that exact --remote path — unlike file's <sha256>.age locator
      (content-addressed, so a same-path "overwrite" is always byte-identical)
      or arweave/turbo's (assigned fresh after upload), an rclone --remote is an
      operator-named, free-form destination (NON_CONTENT_ADDRESSED_BACKENDS in
      src/lib/config.ts), so reusing one across two DIFFERENT snapshots would
      otherwise silently replace the earlier one. Pass --force to overwrite it
      anyway — the SAME flag --skip-unchanged's digest override uses below (both
      mean "push despite this safety net"); does not apply to any other backend.
      --backend ton stores the ciphertext as a TON Storage bag SEEDED FROM YOUR OWN
      always-on box (the "seeder": a machine running tonutils-storage, reached over
      SSH — CYPHER_BRAIN_TON_SSH_HOST etc., see Settings below). The bag is created
      ON the seeder (the machine that must retain it), the locator is
      "ton:v1:<64-hex-bag-id>", and re-pushing unchanged ciphertext is idempotent
      (same bytes -> the recorded locator, no re-upload). Free per upload (your
      seeder's running cost is the cost) — but NOT permanent storage: a bag is
      retrievable only while at least one reachable seeder retains it. Pull's
      primary path is a real P2P download (no SSH key needed on the restoring
      machine); the seeder is only a loud, explicit fallback.
      --backend ton-provider pays a LIVE THIRD-PARTY provider (self-registered on
      mytonprovider.org, the current Go/StorageV1 scheme) to hold the bag instead of
      seeding it yourself — no always-on box of your own required. Requires
      CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (a nanoTON spend cap; a StorageV1 deploy
      spends real funds, same posture as arweave/turbo's spend cap). The contract's
      owner comes from ONE of two places: if CYPHER_BRAIN_TON_WALLET is configured (a
      local TON wallet — 'wallet create --chain ton', issue #396 PR2), that wallet's own
      address is used and it auto-signs+broadcasts the deploy itself, no human involved
      — the same "runs unattended" shape arweave/turbo's JWK signer already has, which
      is what lets this run under 'schedule install' and MCP too. Otherwise
      CYPHER_BRAIN_TON_PROVIDER_OWNER (a plain address, no local key) is required, and
      push prints a Tonkeeper deeplink for a HUMAN to sign in their own wallet app
      instead. (If BOTH are set and disagree, push REFUSES outright rather than picking
      one silently — auto-signing requires sender==owner on-chain, so there is no safe
      way to guess which address the operator actually meant; unset
      CYPHER_BRAIN_TON_PROVIDER_OWNER, or fix it to match the wallet's own address, and
      re-run.) Before signing/printing the deeplink it runs an advisory pre-deploy
      funds check against the owner address's own on-chain balance (see Spend below) —
      a WARNING only, never a refusal, for either path: whichever one actually spends —
      the human's wallet app, or the auto-sign broadcast itself — already gives its own
      unambiguous refusal on a real shortfall; this just saves the trip through the wait
      below on a spend that was always going to fail. Notifying the chosen provider
      shells out to a locally built scripts/go/storage-v1-client binary
      (CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN) — an ADNL/RLDP query with no mature
      TypeScript implementation — and the wait for it to report a full download is what
      the Transfer progress paragraph above covers. The locator is
      "ton-provider:v1:<64-hex-bag-id>"; pull is the same P2P download ton uses, with
      no seeder-SSH fallback (this backend never operates a seeder of its own).
      --save-locator writes "<locator>\t<backend>\t<sha256>[\t<content_digest>[\t
      <recipients_fingerprint>[\t<sig_locator>[\t<sign_key_id>]]]]" to a file (rewritten
      atomically each push, so it always holds the LATEST + an integrity pin; legacy
      3/4/5/6-field files are still accepted everywhere). Back this file up off-box next
      to your identity: it is the durable pointer a fresh machine needs to find the most
      recent snapshot. (For the file backend the locator is a LOCAL store path —
      arweave/turbo locators are
      always portable to another machine; an rclone locator is portable too, PROVIDED
      the same remote name is configured there — a config-less ":local:/path" remote
      is as machine-local as the file backend.)
      Authenticity (#214): if "<in>.minisig" exists (snapshot writes one automatically
      when a signing identity is present — see "snapshot" above), it is ALSO uploaded to
      the SAME backend right after the ciphertext, under the SAME already-granted
      consent — its own locator becomes the 6th --save-locator field above, so pull can
      fetch it back automatically, and the signing key id inside it becomes the 7th
      (#250, see --skip-unchanged below). Unchanged behavior when no sidecar exists.
      push has no --sign flag of its own — to enable signing for what you are about to
      push, see "snapshot --help" (a signing identity from "keygen --sign" makes
      snapshot write the "<in>.minisig" this section auto-uploads; --no-sign opts out).
      --skip-unchanged (requires --save-locator): skips ONLY when ALL THREE of (a) the
      snapshot's PLAINTEXT content digest — read from the "<in>.digest" sidecar
      snapshot writes, or given as --digest <hex> — equals the content_digest recorded
      in the save-locator file for the same backend, (b) the recipients
      fingerprint — read from the "<in>.recipients-fingerprint" sidecar — equals the
      recipients_fingerprint recorded there too, AND (c) the SIGNING state matches:
      an unsigned artifact where the last push was unsigned too, or a "<in>.minisig"
      whose signing key id equals the sign_key_id recorded there. Requiring (b) means a
      re-snapshot of unchanged plaintext under a CHANGED --recipient set (a newly added
      recovery key, a removed/revoked key) is never skipped; requiring (c) means turning
      signing ON ("keygen --sign") or ROTATING the signing key is never skipped either —
      otherwise the store would keep an unsigned, or stale-key-signed, copy of content
      you now expect to be signed with the current key. When all three match: print
      SKIPPED + the previous locator and exit 0 WITHOUT contacting storage or spending.
      Any missing piece on EITHER side (no sidecar, a legacy 3/4-field file, a signed
      push recorded before #250 added the 7th field, a different backend)
      just pushes normally: skip is an optimization, never a gate. --force uploads even
      when unchanged. (The digest is plaintext-side by necessity: age's ephemeral file
      key makes identical content encrypt to different ciphertext bytes every run.)

  cypher-brain estimate --in <file.age> --backend <file|arweave|turbo|rclone|ton|ton-provider> [--json] [--out <path.json>] [--remote <name>:<path>] [--force]
      Read-only preview: print what pushing --in to --backend would cost WITHOUT
      uploading anything. turbo/arweave show the native unit (winc/winston) plus
      an approximate USD line when a USD/AR rate is fetchable; ton-provider shows
      the native unit too (nanoTON, a real mytonprovider.org priced query) plus its
      own approximate USD line when a USD/TON rate is fetchable (tonapi's public
      rates endpoint — a rate failure drops that line only, same posture as
      turbo/arweave). file, rclone and ton are always reported as free (rclone's
      actual transfer/storage cost, if any, is whatever the operator's own cloud
      contract for that remote charges — cypher-brain cannot query it; ton's is the
      operator's own seeder box). Sizes --in the same way push does (a real byte count
      off disk). The SAME computation backs the MCP estimate_cost tool, so the two
      never disagree.
      --json prints the same CostEstimate object as one JSON line on stdout
      (backend, size_bytes, cost, unit, approx_ar, usd_estimate, note) instead of
      the human-readable report — field-for-field identical to what estimate_cost
      returns. All seven keys are ALWAYS present (#268): a backend with no native
      unit, or a query that could not run, reports null rather than dropping the key,
      so the object shape does not depend on which backend was asked about. On an
      ERROR, stdout carries {error, code, exit_code} instead (#270 — see verify).
      --out <path.json> (#231): ALSO write a "plan" pinning this exact estimate to the
      artifact (sha256 of --in), --backend, --remote (rclone only, null otherwise), the
      configured payer address (if any wallet is set up for this backend — null
      otherwise), and an expiry 15 minutes from now. Additive to the normal report
      above (stdout/exit code unchanged either way). Refuses if --out already exists
      (same no-clobber posture as "snapshot --out", #470) — pass --force to overwrite
      it anyway. Feed the path to
      "push --plan <path.json>" to have push refuse instead of proceeding if the
      artifact, backend, remote, price, payer, or recipients fingerprint (#469) drifted
      since the plan was made — the Terraform plan/apply pattern, binding what push
      actually validates before its consent gate to what "estimate --out" reviewed
      (see "push --plan" above for what that guarantee does and does not cover).
      --remote <name>:<path> (rclone only; the SAME value push/pull's --remote takes —
      see "push" above): REQUIRED alongside --out when --backend rclone, since the
      plan written above pins whatever --remote was given (null when omitted), and a
      null remote can never validate against "push --plan" (push always has a real
      --remote to compare it to for that backend) — omitting it here refuses up front
      with an error, rather than writing a plan that is a dead end until re-run with
      --remote (#468). Without --out, --remote has no effect on the estimate itself
      (rclone's cost is always free regardless of destination).

  cypher-brain pull (--locator <id> --backend <…> | --remote <name>:<path> --backend rclone | --from-locator-file <path>) --out <file.age> [--wait <seconds>] [--sha256 <hex>] [--sig-locator <id>] [--force]
      Fetch ciphertext by locator into --out. --from-locator-file reads the locator, its
      backend AND the saved sha256 from a file written by push --save-locator (the recovery
      path: identity + this file are all a fresh machine needs; the saved sha256 is applied
      as the integrity pin automatically). --from-locator-file can be combined with an
      explicit --locator/--backend — either one, if also given, OVERRIDES the value
      recorded in the file (a --backend that conflicts with the file's recorded backend is
      not refused; the explicit flag wins silently, so double-check the two agree before
      combining them). --wait retries while the item is not yet
      retrievable (a fresh Turbo/Arweave upload takes ~5-8 min to propagate); default 0.
      Only has an effect for --backend arweave/turbo — file/rclone/ton/ton-provider fail
      a not-yet-retrievable object immediately regardless of --wait (a warning is printed
      if you set it for one of those anyway).
      --sha256 fail-closes the fetch: the bytes must match the expected hash (sourced
      out-of-band from a trusted index) or pull errors, having written nothing to --out.
      No-clobber by default: refuses to overwrite an existing --out (the recovery steps
      above reuse a fixed filename, so a second pull could otherwise destroy the first
      one's result) — pass --force to overwrite it anyway.
      --backend rclone accepts --remote <name>:<path> in place of --locator (the
      rclone backend's locator IS that string — see push's rclone section above);
      an explicit --locator still wins if both are given. A locator/--remote with
      no object at it fails with a clean "no object at <locator>" error (#539) —
      not rclone's own raw, 3x-repeated retry-loop text (which used to mislabel a
      missing FILE as a missing "directory").
      --remote only applies to --backend rclone — every other backend ignores it, so
      passing --remote with a different --backend is refused up front rather than
      silently doing nothing, mirroring push's own refusal (#655/#677).
      Authenticity (#214): --sig-locator <id> (or the 6th --from-locator-file field,
      read automatically) ALSO fetches the "<in>.minisig" sidecar push uploaded, into
      "<out>.minisig" — best-effort, never fails the pull itself (restore/verify treat a
      missing sidecar as a warning, not a failure). Omit it and pull behaves exactly as
      before #214 (ciphertext only).

  cypher-brain publish-latest --domain <name>.ton --from-locator-file <path> [--yes] [--wait <seconds>]
      Opt-in: point your OWN .ton DNS domain's "storage" record at the ton backend's
      LATEST bag id (read from --from-locator-file, a file push --save-locator wrote —
      the same recovery pointer pull reads), so a fresh machine can discover the newest
      encrypted-backup bag from a human-memorable name instead of needing that file
      itself. NEVER run automatically by 'schedule install' — a deliberate,
      operator-invoked action, because it also makes your snapshot cadence and current
      bag id PUBLIC (docs/durability.md: DNS is a discovery pointer, never the integrity
      source — the sha256 pin still lives in the locator file, and a pull should still
      verify it).
      --domain must be a lowercase .ton domain (dot-separated [a-z0-9-] labels ending in
      ".ton", e.g. "myname.ton") — anything else is refused up front rather than
      travelling all the way to a confusing tonapi 404.
      Refuses a locator file whose backend is not "ton", or whose locator does not match
      "ton:v1:<64-hex-bag-id>".
      Availability gate (required, before anything is printed): spins an ephemeral local
      TON Storage daemon and probes the bag id on the real P2P network (metadata found
      via DHT AND at least one byte served — a PROBE, not a full download; the whole
      probe, daemon startup included, shares one ~180s budget — under 4 minutes worst
      case). A bag that is not reachable right now is refused with "DNS must never point
      at an unavailable bag", rather than publishing a domain that resolves to nothing.
      Resolves --domain's NFT item address via tonapi (CYPHER_BRAIN_TON_TONAPI_URL,
      default https://tonapi.io) and builds the on-chain change_dns_record message body
      (a dns_storage_address record over the bag id) — but cypher-brain NEVER signs it.
      tonapi is the ONLY source for that NFT address (there is no independent on-chain
      domain -> NFT-address resolver to cross-check against), so the resolved address is
      printed alongside a tonviewer.com link and a warning: confirm the recipient
      Tonkeeper shows equals the printed address before approving anything.
      Prints the domain, the resolved NFT address, the bag id, and (gated behind --yes /
      CYPHER_BRAIN_YES, since acting on it spends ~0.02 TON gas from your wallet) a
      Tonkeeper transfer deeplink (https://app.tonkeeper.com/transfer/...) to stdout:
      open it yourself, review the transaction in your own wallet, and approve it there —
      this command only prepares the link.
      --wait <seconds> (default 0, max 86400/24h, a non-negative whole number — anything
      else is refused): after printing, poll tonapi's DNS resolution until the domain's
      storage record equals the published bag id, then report CONFIRMED or NOT-YET.

  cypher-brain recovery-kit --from-locator-file <path> [--out <file>] [--force]
                            [--inline-identity] [--backup-identity <path>] [--backup-recipient <age1…|file>]
      Regenerate the printable recovery kit "init" prints once — pointed at the CURRENT
      latest push instead of the first one (#364: every push changes the locator/sha the
      kit exists to carry, so a printed kit goes stale each cycle). Renders through the
      SAME builder init uses, from --from-locator-file (a file push --save-locator wrote)
      plus the standard key layout under CYPHER_BRAIN_HOME (deliberately no per-file
      identity override: the kit pairs the identity with recipient.txt, and swapping one
      half per-flag could claim a recipient the embedded key cannot satisfy). Prints to
      stdout by default; --out writes 0600 via an exclusive-create temp and an ATOMIC
      no-clobber promote (same primitive as pull's --out) — --force replaces instead.
      --inline-identity ALSO embeds the primary identity — accepted only when the file
      really is a passphrase wrap (age ciphertext whose first stanza is scrypt; classified
      from the bytes, not a marker sniff). A bare private key in a printable,
      paste-anywhere document is refused outright; a BINARY wrap is re-armored to the
      printable age -p -a encoding. The wrap passphrase is never part of the kit.
      --backup-identity <path> inlines a backup identity the way init's wizard does (the
      kit IS how a backup key goes off-box). An unwrapped one is accepted but warned about
      loudly; a wrapped one is re-armored if binary and needs --backup-recipient
      <age1…-or-path>, since its public recipient cannot be derived without the
      passphrase. PQ hybrid identities (AGE-SECRET-KEY-PQ-1…) classify and derive the
      same as X25519 ones.
      A regenerated kit marks the profile/Postgres columns "unknown" rather than guessing —
      the locator file does not record them.
      CLI-only by design: no MCP tool exposes this (the kit can embed PRIVATE key blocks,
      which must never land in an agent's tool-result context or logs).

  cypher-brain schedule install --backend <file|arweave|turbo|ton-provider> [--at HH:MM] [--max-spend <n>] [--no-load]
                                [--profile <name>] [--pg <conn>] [--pg-table <t>]...
                                [--pg-filter <file>] [--pg-exclude-table-data <t>]... [--dir <path>]...
                                [--recipient <pubkey|file>]... [--vault <path>] [--zip <path>] [--export <path>]
                                [--save-locator <path>] [--index-file <path>]
                                [--ping-url <url>] [--ping-url-fail <url>]
                                [--scan-secrets warn|deny|off]
      Make the nightly snapshot+push unattended. Writes a runner script
      ($CYPHER_BRAIN_HOME/schedule/nightly.sh) composing the snapshot/push pipeline from
      the SAME flags those commands take — dated outputs, --save-locator, an index.tsv
      append — plus the platform trigger (macOS: a launchd plist in ~/Library/LaunchAgents;
      Linux: a crontab entry), and registers it. Default --at 03:30: run well after the
      source re-synthesizes overnight so the DB and files are captured from the same
      settled state (MANAGEMENT.md, "Avoid the write window"). Paid backends
      (arweave/turbo) REQUIRE --max-spend <n>: the runner gets CYPHER_BRAIN_YES=1 for the
      unattended consent, so it must also get a CYPHER_BRAIN_MAX_SPEND cap — an uncapped
      unattended spender is refused. --no-load writes the artifacts without registering.
      Each run logs to $CYPHER_BRAIN_HOME/schedule/logs/nightly-YYYY-MM-DD.log, ending
      "OK rc=0" or "FAILED rc=N".
      --ping-url <url> adds a healthchecks.io-style dead man's switch: the runner curl's
      <url> (best-effort, 10s timeout, never affects the run's own outcome) on every
      successful run, and <url>/fail on every failed run — so a schedule that silently
      stops running (a wedged launchd/cron, a box left off) gets noticed even without
      anyone running 'schedule status'. --ping-url-fail overrides the failure URL
      (default: <url>/fail — a plain string append, not URL-aware: pass --ping-url-fail
      explicitly if your ping URL has a query string or a trailing slash); it requires
      --ping-url to also be set.
      --scan-secrets warn|deny|off bakes snapshot's gitleaks gate (see 'snapshot' above)
      into the generated runner, so the unattended nightly — the run nobody is watching —
      is gated too. The EFFECTIVE mode is always baked, including when you pass nothing:
      install resolves the same default snapshot would (warn if there is a --dir/--profile
      source and gitleaks is resolvable, otherwise off) and writes it in explicitly, so the
      nightly cannot start scanning — or stop — because of what lands on PATH months later.
      Install RESOLVES gitleaks now and PINS the absolute path into the runner
      as CYPHER_BRAIN_GITLEAKS_BIN (launchd/cron do not inherit your PATH, same reason
      --pg bakes CYPHER_BRAIN_PG_BIN; pinning rather than extending PATH so a different
      gitleaks on the scheduler's PATH cannot take its place), and REFUSES to install if
      it cannot be resolved — a schedule that cannot scan is never installed as if it
      could. An explicit CYPHER_BRAIN_GITLEAKS_BIN is resolved and validated the same way,
      not taken on trust: a bare name or a stale path there would be just as unusable to
      the scheduler. Same --dir/--profile requirement as 'snapshot': a
      --pg-only schedule is refused rather than reporting a scan of no component.
      Fail-closed at run time too: if gitleaks later disappears, the nightly FAILS rather
      than silently skipping the scan.
      Same companion-flag-required checks as 'snapshot' (see above), enforced here too so
      the two commands never disagree: --vault/--zip/--export are each refused unless
      --profile matches (obsidian/chatgpt-export/o2b respectively), and
      --pg-table/--pg-filter/--pg-exclude-table-data are each refused unless --pg <conn> is
      also given — install REFUSES rather than baking a nightly that would silently drop
      the flag on every run (#525/#526).

  cypher-brain schedule status [--json]
      Report the configured time + backend, whether a dead man's switch ping-url is
      configured, the trigger load state, the last run log and its final rc line, and the
      next scheduled run.
      --json prints one JSON object to stdout instead of the human-readable report
      (configured, runner, ping, trigger: {type, loaded, legacy, ...}, last_run,
      next_run) — the SAME state read above, so it never disagrees with the
      human-readable report or the MCP schedule_status tool. "not installed" is an
      ordinary state to poll for, not an exception, so it too answers in JSON on
      stdout ({error, code: "CB-E014", exit_code}) instead of prose on stderr (#270).

  cypher-brain schedule uninstall
      Unregister the trigger and remove the generated runner/plist/cron entry (idempotent;
      logs, snapshots and index.tsv are kept — they are your data). macOS: if the launchd
      plist this home recorded as installed (schedule.json's trigger.path, exactly where
      install would have written it) is ALREADY gone — deleted manually, or by another
      tool — that is reported as a ⚠ warning ("was already missing on uninstall") rather
      than silently dropped from the "removed:" list, still exits 0 either way, the end
      state (no plist, no bookkeeping) is reached regardless (#529). A plist found at a
      DIFFERENT recorded path (CYPHER_BRAIN_LAUNCHD_DIR changed since install, or a
      pre-#114 legacy scheme) is a "legacy launchd plist" removal instead, never a drift
      warning — that file is still right where it was left.

Config file: every setting below can also live in $CYPHER_BRAIN_HOME/config.env (KEY=value
     per line, "#" comments) instead of the environment — the same names, one place, read by
     the CLI and the MCP server alike. An explicit environment variable always WINS over the
     file. CYPHER_BRAIN_HOME is the one exception: this file is found INSIDE it, so it cannot
     set it (a file that tries is warned about, not silently obeyed). An unknown CYPHER_BRAIN_*
     key is an ERROR rather than a no-op — a "CYPHER_BRAIN_MAXSPEND" typo would otherwise
     silently drop your spend cap. ONLY CYPHER_BRAIN_* settings (or their pre-rename
     CIPHER_BRAIN_* spelling — the same setting under both is refused as ambiguous) are
     applied: any other key in the file (TMPDIR, a proxy variable, ...) is read but never
     put into the environment, so
     the file cannot reach through into the processes cypher-brain spawns.
     Secrets are allowed (it warns if the file is group/other-readable — chmod 600 it).
     'schedule install' BAKES the values in effect at install time into the runner AND makes
     that runner skip this file, so editing it never retunes — or breaks — an already-
     installed nightly run; re-run install to pick changes up. 'schedule status' names the
     file it loaded.
Env: CYPHER_BRAIN_HOME (default ~/.cypher-brain; an existing ~/.cipher-brain is used while no
     ~/.cypher-brain exists), CYPHER_BRAIN_PG_BIN (dir of pg_dump/pg_restore). Every variable
     below is also read under its pre-rename CIPHER_BRAIN_* spelling (the CYPHER_BRAIN_* one
     wins when both are set).
     CYPHER_BRAIN_SCHEDULE_DIR (schedule artifacts/logs dir; default $CYPHER_BRAIN_HOME/schedule).
     CYPHER_BRAIN_LAUNCHD_DIR (macOS only: where 'schedule install' writes the launchd plist;
     default ~/Library/LaunchAgents — a REAL system dir, NOT scoped to CYPHER_BRAIN_HOME, written
     even under --no-load; override to sandbox a --no-load preview run).
     CYPHER_BRAIN_PASSPHRASE (non-interactive passphrase for a wrapped identity — automation/CI; otherwise prompted on the TTY).
     CYPHER_BRAIN_PIN_RECIPIENTS (snapshot: allowlist of age1… pubkeys, inline or a file — refuse to encrypt to any other recipient).
     CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 (init: bypass its TTY requirement — automation/CI only, e.g. this repo's own selftest; a human just runs init directly in a terminal).
Storage: CYPHER_BRAIN_RECEIPT_LEDGER (default $CYPHER_BRAIN_HOME/receipt-ledger.jsonl — every arweave/turbo push's actual-cost receipt, #232; see 'ledger' above, and 'doctor's receipt-ledger-readability check, #456).
         CYPHER_BRAIN_AUDIT_LOG (default $CYPHER_BRAIN_HOME/audit-log.jsonl — hash-chained record of every push/restore/verify run, #226; see 'audit' above, and 'doctor's audit-chain-integrity check, #456).
         CYPHER_BRAIN_FILE_DIR (file);
         CYPHER_BRAIN_AR_{HOST,PORT,PROTOCOL,WALLET,GATEWAY,GATEWAYS,HTTP_TIMEOUT,USD_RATE_URL,TURBO_RATES_URL,BALANCE_URL,L1_MAX} (arweave; CYPHER_BRAIN_AR_WALLET is a path to a JWK key file — 'cypher-brain wallet create' generates one, 'wallet address' shows what to fund; when unset, push/estimate's payer resolution and 'wallet address'/'balance' all fall back to $CYPHER_BRAIN_HOME/wallet.json (the default 'wallet create' path, #472) — only required when the wallet lives somewhere else; the 'arweave' npm package is needed only to PUSH or for the rare L1 chunk fallback — a gateway pull needs none; the approximate-USD lines price each backend in its own truthful unit: the raw arweave L1 backend at AR SPOT (CYPHER_BRAIN_AR_USD_RATE_URL — the spend is real AR at market value), the turbo backend and 'wallet balance' at Turbo's own credit rate, fees included (CYPHER_BRAIN_AR_TURBO_RATES_URL — a turbo upload spends credits, and credits sell at Turbo's price, not AR spot; pricing them at spot understated a real push's cost by ~35%), falling back to labeled AR spot only when that price sheet is unavailable or unusable; a dead rate endpoint just omits the USD line, it never blocks a push; CYPHER_BRAIN_AR_BALANCE_URL overrides the payment-service account endpoint 'wallet balance' queries as '<url>?address=<addr>'; CYPHER_BRAIN_AR_L1_MAX overrides the raw-arweave-L1 backend's max single-tx size in bytes (default 10485760 ≈ 10 MiB — push/estimate refuse a larger raw-L1 tx and suggest --backend turbo instead, unless this is raised); 'schedule install' bakes the value in effect at install time into the generated nightly runner, same as the other AR_* settings);
         turbo: CYPHER_BRAIN_AR_WALLET (JWK signer) + optional CYPHER_BRAIN_AR_PAID_BY (an address sharing Turbo Credits to that signer); needs '@ardrive/turbo-sdk' to PUSH (a pull reuses the arweave gateway read, no SDK). Funding/credit-share details: docs/arweave-upload-runbook.md.
         rclone: CYPHER_BRAIN_RCLONE_BIN (path to the rclone binary; default 'rclone' on PATH) — the remote itself is whatever --remote <name>:<path> names in your own 'rclone config'.
         ton: CYPHER_BRAIN_TON_SSH_HOST (user@host of your seeder box running tonutils-storage — required to PUSH; also the pull fallback), CYPHER_BRAIN_TON_SSH_KEY (optional ssh -i identity file), CYPHER_BRAIN_TON_REMOTE_DIR (seeder-side layout root; default 'cypher-brain-ton' in the SSH user's home — plain relative or absolute path, a literal ~ is refused), CYPHER_BRAIN_TON_REMOTE_API (the seeder daemon's API address as seen FROM the seeder itself; default '127.0.0.1:9955' — it stays loopback-bound there, reached via ssh, never exposed), CYPHER_BRAIN_TON_BIN (local tonutils-storage binary for the P2P pull; default 'tonutils-storage' on PATH), CYPHER_BRAIN_TON_HTTP_TIMEOUT (ms; default 30000), CYPHER_BRAIN_TON_NO_FALLBACK=1 (strictly '1': forbid the seeder fallback on pull, so a success PROVES P2P availability — use for verify --level remote when you want that proof), CYPHER_BRAIN_TON_NETWORK_CONFIG (path to a TON global config JSON for testnet; default mainnet), CYPHER_BRAIN_TON_TONAPI_URL (tonapi.io base URL 'publish-latest' resolves a .ton domain's NFT address and polls its DNS record against; default 'https://tonapi.io').
         ton-provider: CYPHER_BRAIN_TON_WALLET (path to a local TON wallet mnemonic — 'wallet create --chain ton' — issue #396 PR2; when set, its own address becomes the contract owner and PUSH auto-signs+broadcasts with no human involved, which is also what makes this backend reachable via 'schedule install'/MCP), CYPHER_BRAIN_TON_PROVIDER_OWNER (TON wallet address that will own the deployed StorageV1 contract — required to PUSH only when CYPHER_BRAIN_TON_WALLET is NOT set; PUSH refuses outright, rather than silently overriding it, if both are set and disagree), CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (nanoTON spend cap — required to PUSH either way, a deploy spends real funds), CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN (path to a locally built scripts/go/storage-v1-client binary — required to PUSH, notifying a provider needs an ADNL/RLDP query this project has no TypeScript implementation for), CYPHER_BRAIN_TON_PROVIDER_MYTONPROVIDER_URL (provider registry base URL; default 'https://mytonprovider.org'). Also uses CYPHER_BRAIN_TON_BIN/CYPHER_BRAIN_TON_NETWORK_CONFIG (the local ephemeral daemon that hashes and temporarily seeds the bag) and CYPHER_BRAIN_TON_TONAPI_URL (polling the deploy for on-chain confirmation, AND the approximate-USD line's rate source — tonapi's own public rates endpoint, no separate URL setting needed; auto-sign's broadcast and seqno lookup use this same URL too) from the ton settings above.
Tracing: OTEL_EXPORTER_OTLP_ENDPOINT (opt-in, #226 part 3 — a THIRD-PARTY standard env
     var, not a CYPHER_BRAIN_* name, so it is NOT also read under CIPHER_BRAIN_* and has
     no config.env entry, and it is a BASE endpoint — the '/v1/traces' path is appended
     automatically, matching the OTel spec: 'http://localhost:4318', not
     'http://localhost:4318/v1/traces'). When set, every DISPATCHED CLI command and MCP
     tool call becomes an OpenTelemetry span exported there via '@opentelemetry/api' +
     'sdk-trace-node' + 'sdk-trace-base' + 'exporter-trace-otlp-http' + 'resources' —
     optionalDependencies (like '@ardrive/turbo-sdk' above: a normal registry or
     from-source install already carries them; only an install run with --omit=optional
     skips them). Each span's resource 'service.name' defaults to 'cypher-brain' (#476);
     set OTEL_SERVICE_NAME (or OTEL_RESOURCE_ATTRIBUTES) to override it — both are read
     via the SDK's own standard env-based resource detection, the same as any other OTel
     tool honors them. The export itself is bounded to a short fixed timeout (currently
     3s) rather than the SDK's own much longer defaults, so an unreachable/slow collector
     never meaningfully delays a command (#474); if a span still fails to export within
     that bound, a single stderr WARNING says so (once per process) instead of leaving
     the added latency unexplained. A missing or broken package also WARNS once on
     stderr and falls back to a no-op — tracing must never gate a real push/restore/
     verify the way a missing SDK gates an actual paid upload elsewhere. Unset (the
     default): a pure passthrough — no OTel package is even imported, so a machine that
     has never heard of OTel pays nothing for this feature existing. Quick local check
     (#475, no real collector needed): run 'nc -l 4318' in one terminal, then
     'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 cypher-brain doctor' in another —
     watch the first terminal for the raw 'POST /v1/traces' request landing.
Spend: arweave/turbo PUSH needs --yes or CYPHER_BRAIN_YES=1 (paid, permanent); CYPHER_BRAIN_MAX_SPEND caps the arweave/turbo cost estimate (winston/winc). ton-provider PUSH needs --yes or CYPHER_BRAIN_YES=1 too, plus CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (nanoTON) — signed either by a human in Tonkeeper (no CYPHER_BRAIN_TON_WALLET configured) or auto-signed by a local wallet (CYPHER_BRAIN_TON_WALLET set — issue #396 PR2, the same "runs unattended" shape as arweave/turbo's JWK signer, which is what lets it run under 'schedule install'/MCP too). A turbo push also runs a funds check BEFORE signing: when the estimated cost exceeds even the reachable credit (the signer's own balance + the live approvals CYPHER_BRAIN_AR_PAID_BY selects), the spend is headed for a payment-service refusal that would otherwise arrive only after minutes of signing. On a TTY (a human watching) it aborts with the funding steps spelled out, after confirming the shortfall on a second balance read so a top-up landing that same moment is not blocked; without a TTY (a nightly runner, an MCP host) it only WARNS and proceeds — a balance read has no freshness guarantee, and it must never be what blocks an unattended backup. Skipped entirely when the balance cannot be read at all; CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 (strictly '1') bypasses it for one run. A ton-provider push runs the SAME kind of pre-deploy funds check (querying the owner address's own on-chain balance via tonapi), but only ever WARNS, never aborts — whichever mechanism actually spends (the human's Tonkeeper app, or the auto-sign broadcast itself) already gives its own unambiguous refusal on a real shortfall, so this check exists only to save the trip through the up-to-20-minute wait-for-active-contract poll first. Shares CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 with turbo's check above (not a separate ton-provider-specific flag). PUSH also WARNS (never aborts, same reasoning) before signing if the deploy's computed "bounty" looks below the ~0.05 TON floor providers built on tonutils-storage-provider enforce (issue #403) — a real deploy can otherwise succeed and be paid for, then have the provider's own notify refuse to ever fetch the bag, discovered only after the full notify retry window; ESTIMATE shows the same warning ahead of time.
Consent: restore --pg (pg_restore --clean --if-exists, irreversible) needs --yes or CYPHER_BRAIN_YES=1.
Permanence: there is NO delete, at any granularity (#301). cypher-brain has no forget/prune/delete
     command and will not grow one: arweave/turbo are write-once, and destroying your identity does
     not help either — the backup recipient you were told to keep (and the printable recovery kit, if
     it carries one) still decrypts everything. Recoverability was chosen over erasability on purpose.
     What IS parked is ciphertext, so a secret that reaches a snapshot is not published — it is sealed
     to your key, and stays exposed only to whatever might compromise that key later. That is the
     whole reason --scan-secrets now defaults to warn: the only workable answer is to not seal the
     secret in the first place. Before a paid push, assume you are deciding forever.
```

<!-- HELP-END -->

## Backends

`push`/`pull` are storage primitives over a pluggable backend (`--backend` is
required — there is no default). Paid pushes print a cost estimate before
uploading — both turbo (winc) and arweave (winston) show the native unit, plus an
approximate USD line when a USD/AR rate is fetchable (a rate failure drops that
line only, never the native estimate). Preview that same estimate WITHOUT pushing anything via
`cypher-brain estimate --in <file.age> --backend <backend>` (also exposed as the
`estimate_cost` MCP tool — see below); `push --skip-unchanged` skips a paid
re-upload when the snapshot's plaintext content digest (the `<out>.digest`
sidecar `snapshot` writes) matches the previous push. Six backends ship, but
they are not peers:

- **`turbo` — the recommended mainline.** Uploads the ciphertext to the Arweave
  network as an ANS-104 bundled data item via a bundler (ArDrive Turbo), payable
  with **ETH/USDC** (`<100 KB` free); pushing needs `@ardrive/turbo-sdk` and a
  JWK wallet — `cypher-brain wallet create` generates one, `cypher-brain wallet
  address` prints what to fund. The `locator` is the data-item id assigned after
  upload. Pulling needs neither — it is a plain HTTP read from any Arweave gateway.
  Funding/credit-share details: [`docs/arweave-upload-runbook.md`](docs/arweave-upload-runbook.md).
- **`arweave`** — the raw single-L1-transaction path to the same network, for
  small artifacts only (a ~10 MiB guard redirects anything larger to `turbo`).
- **`file`** — a local content-addressed store (no daemon, no network); used by
  CI and for local drills.
- **`rclone`** — a thin subprocess wrapper around the `rclone` binary
  (`push --backend rclone --remote <rclone-remote-name>:<path>`), the same
  "delegate to rclone" pattern restic/kopia use to reach 70+ cloud providers
  (S3, GCS, B2, Azure Blob, Dropbox, SFTP, …) without cypher-brain implementing
  any of their APIs itself — auth/protocol/retries are entirely rclone's own
  configured remote (`rclone config`). Free like `file` (`estimate` always
  reports cost `0` — any real transfer/storage cost is whatever your own cloud
  contract for that remote charges); the locator IS the `<remote>:<path>`
  string. A cheap way to add an offsite copy (the "1" in 3-2-1 backup) next to
  `turbo`'s permanent store, reusing an rclone config you may already have from
  restic/kopia. Needs the `rclone` binary on PATH.
- **`ton`** — [TON Storage](https://docs.ton.org/foundations/web3/ton-storage),
  seeded from **your own always-on box** (the "seeder": any machine running
  [tonutils-storage](https://github.com/xssnick/tonutils-storage), reached over
  SSH — `CYPHER_BRAIN_TON_SSH_HOST` etc., see the `--help` Settings section).
  `push` transfers the ciphertext to the seeder and creates the bag **there** (the
  machine that must retain it); the locator is `ton:v1:<64-hex-bag-id>` — the
  bag's merkle root. `pull`'s primary path is a **real P2P download** by bag id
  through an ephemeral local tonutils-storage — credential-less, so the
  "identity + locator is all a fresh machine needs" promise holds — with a loud,
  explicit fallback to a direct copy off the seeder. Free per upload (the
  seeder's running cost is the cost). **Not permanent storage**: a bag is
  retrievable only while at least one reachable seeder retains it — see
  [`docs/durability.md`](docs/durability.md) for the honest comparison with
  Arweave, and treat `ton` as a redundancy/sovereignty lane next to `turbo`'s
  permanence, not a replacement for it.
- **`ton-provider`** — the real, general-user-reachable way to use TON Storage
  (issue #396): the same network as `ton` above, but paying a **live,
  third-party provider** (self-registered on
  [mytonprovider.org](https://mytonprovider.org), the current Go/StorageV1
  scheme) to hold the bag instead of seeding it yourself — no always-on box of
  your own required, the same "pay once, don't operate infrastructure
  yourself" shape `turbo` has for Arweave. `push` deploys a per-bag StorageV1
  contract, signed via a **Tonkeeper deeplink** — a human must be present to
  approve it; unlike arweave/turbo's locally-held JWK there is no wallet that
  signs unattended yet — then notifies the chosen provider over ADNL/RLDP
  (shelling out to a locally built `scripts/go/storage-v1-client` binary; no
  mature TypeScript implementation exists for that query) and waits for it to
  report a full P2P fetch, printing a rate/ETA progress line the same way
  `turbo`'s upload does. The locator is `ton-provider:v1:<64-hex-bag-id>`;
  `pull` is the same real P2P download `ton` uses, with no seeder-SSH fallback
  (this backend never operates a seeder of its own). `estimate` prices it in
  **nanoTON** (a real `mytonprovider.org` query, not a guess) plus an
  approximate USD line. **Not permanent storage the way Arweave is**:
  durability depends on the chosen provider continuing to renew/serve the
  contract — see [`docs/durability.md`](docs/durability.md) for the honest
  comparison, and prefer `turbo` as the mainline recommendation unless you
  specifically want the TON-network option.

The backend abstraction is what makes the same `snapshot → push … pull → restore`
pipeline work across all six — locators known before upload (`file`'s content
hash, `rclone`'s caller-chosen `--remote`) and post-assigned-id ones
(`arweave`/`turbo`/`ton`/`ton-provider`) alike.

## Validation

1. **Local crypto round-trip** (`npm run selftest`) — no Postgres, no network.
   keygen → snapshot a synthetic tree → verify → restore → assert the tree is
   byte-identical, the ciphertext leaks no plaintext, and a *different* identity
   cannot restore.
2. **Real gbrain round-trip** (`scripts/real-gbrain-roundtrip.sh`, operator-run on
   the machine that holds gbrain) — dumps a live table, encrypts, verifies,
   decrypts, restores into a throwaway scratch DB, and asserts the row count and a
   content checksum match the source exactly. The scratch DB is dropped afterward.

   Result (2026-06-27, table `dream_verdicts`, 796 rows): ciphertext 90 KB,
   restored count = 796, source checksum == restored checksum. ✅
3. **Storage round-trip — `file` backend** (`npm run selftest:storage`, gated in
   CI, no daemon/network) — snapshot → push → *delete the original* → pull → verify
   → restore, asserting the locator is content-addressed (not the source path), the
   pulled bytes decrypt to the source, and an absent locator errors. ✅
4. **Key recovery + versioning** (`npm run selftest:recovery`, gated in CI, no
   daemon) — encrypts a snapshot to a primary *and* an offline backup key, then
   shows the **backup key restores with the primary identity absent**, an unrelated
   identity cannot, and two snapshots restore independently. ✅
5. **Large-file / multi-chunk** (`scripts/large-file-test.sh`, operator-run) —
   runs the whole pipeline at scale through the file backend.

   Result (2026-06-27, 256 MB): snapshot streamed in 9 s at **~101 MB node RSS**
   (≪ the 256 MB input → not buffered); the `file` backend round-tripped
   byte-identical. ✅
6. **Arweave backend parity** (`npm run selftest:arweave`, gated in CI against a
   local [arlocal](https://github.com/textury/arlocal) gateway — no real AR) —
   proves the `StorageBackend` abstraction holds for a backend whose locator is an
   **Arweave tx id assigned *after* upload** (not a content hash like `file`):
   push → tx id, fetch by that id, byte-identical, decrypts; unknown id fails. ✅
   `pull` reads both plain **L1** txs and **ANS-104 bundled** data items — the form a
   bundler (Turbo/Irys) produces when you pay with **ETH/USDC/fiat** — via a gateway-HTTP
   read with an L1 chunk-read fallback, proven against *real* arweave.net by
   `node scripts/arweave-real-read.mjs` (operator-run; external, not in CI). ✅
7. **TON backend orchestration** (`npm run selftest:ton`, gated in CI — no real
   TON network: `ssh`/`scp` are PATH-shimmed at a local fake seeder and both
   daemons are `scripts/mock-tonutils.mjs`, so the REAL backend code runs its
   real remote command lines, HTTP client and ephemeral-daemon startup) —
   push → bag on the seeder + inventory record, idempotent re-push, P2P-path
   pull round-trip, and **fired** positive controls: malformed-locator
   rejection, wrong `--sha256` pin, the loud seeder fallback when the bag is
   gone from the network, and `CYPHER_BRAIN_TON_NO_FALLBACK=1` fail-closing. ✅
   What this deliberately does NOT prove is TON Storage itself — that is
   `npm run dogfood:ton` (`scripts/ton-dogfood.mjs`, operator-run against the real
   network with `CYPHER_BRAIN_TON_NO_FALLBACK=1` on the pull, so a success proves
   actual P2P retrievability), the real-network counterpart to this selftest.

## Managing snapshots over time

[`MANAGEMENT.md`](MANAGEMENT.md) covers cadence (`cypher-brain schedule install`
generates the nightly snapshot+push runner and its launchd/cron trigger),
versioning (each push → an immutable locator + an append-only
index — content-addressed for `file`, a tx id for `arweave`/`turbo`), the
restore runbook, and **key recovery** — the primary-plus-offline-backup
model above, so losing one identity never loses the brain.

**Durability** (will the bytes survive a year of neglect?) is a separate question from
the round-trip: [`docs/durability.md`](docs/durability.md) lays out why Arweave's
pay-once permanence (via `--backend turbo`) is the one recommended path.

**When something fails**, the most common failure patterns print with a stable
`[CB-E0xx]` code and a pointer to [`MANAGEMENT.md`'s error code table](MANAGEMENT.md#error-codes)
(cause + next action for each) — the same shape ngrok uses for its own errors.

## Roadmap

- **#1 Cipher** — encrypt a snapshot client-side, key only yours. ✅
- **#2 Storage** — pluggable backend, storage sees ciphertext only. `file` backend
  round-trip ✅ (CI-gated).
- **#3 Management** — key recovery (backup key, CI-proven ✅) + versioning ✅;
  cadence / restore runbook documented in [`MANAGEMENT.md`](MANAGEMENT.md).
- **Backends** — `turbo` (**recommended** — upload via a bundler, payable with
  **ETH/USDC**, `<100KB` free; operator-proven real round-trip, #20) · `arweave`
  (raw L1; parity CI-proven against arlocal ✅, #9) · `file` (local/CI ✅) ·
  `rclone` (delegates to the `rclone` binary's own configured remote, #204/#233,
  CI-proven ✅) · `ton` (self-hosted seeder over SSH, orchestration CI-proven
  against a mock daemon ✅, real-network round-trip operator-run, #381) ·
  `ton-provider` (pays a live mytonprovider.org provider — no seeder box of your
  own required — mainnet deploy→discovery→fetch→proof-reward operator-proven,
  issue #396). The abstraction is validated across content-addressed *and*
  post-assigned-id backends.

The cipher layer is backend-agnostic by design — proven, not just asserted, now that
both a content-addressed (`file`) and a post-assigned-id (`arweave`) backend round-trip.
Arweave is the mainline because its durability is purchasable (pay once) — see
[`docs/durability.md`](docs/durability.md) for the reasoning behind that call (#60).

## MCP server

`cypher-brain-mcp` (stdio) lets an AI agent snapshot, verify and restore its own
brain by calling the same `src/lib` functions the CLI uses:

```sh
node dist/mcp.mjs        # bundled build (npm run build), or: bin/cypher-brain-mcp.mjs
```

| Tool | Money | What it does |
|---|---|---|
| `snapshot_now` | **can spend** (paid backend) | snapshot + optional push. `recipients` is REQUIRED with NO default (#478) — **unlike** the CLI `snapshot`, which defaults to `<CYPHER_BRAIN_HOME>/recipient.txt` when `--recipient` is omitted, this tool refuses a call with none rather than silently reaching for that file; pass the home recipient explicitly to get the same effect. `arweave`/`turbo` require `confirm_paid: true` (the `--yes` guard; the `CYPHER_BRAIN_YES` env escape hatch is not honored over MCP). `scan_secrets: "warn"\|"deny"\|"off"` runs the same gitleaks gate as the CLI `--scan-secrets` (#307) — and defaults the same way (#301): `warn` when there is at least one `dirs` entry and gitleaks is resolvable, nothing otherwise. An explicit mode other than `off` requires at least one `dirs` entry (it does not scan a `pg` dump); the result reports the mode that actually ran (`null` when none did), and a call asking for a scan on a machine without gitleaks fails rather than silently skipping it. `idempotency_key` makes a RETRY safe (#220, Stripe's idempotency-key pattern): a repeat call with the SAME key and the same `dirs`/`pg`/`recipients`/`out`/`backend`/`scan_secrets` returns the FIRST call's result — no new snapshot, no new spend — instead of re-executing (`idempotent_replay: true` in the result marks a replay); the same key with DIFFERENT values in any of those fields is refused (`ERR_IDEMPOTENCY_KEY_REUSED`) rather than silently answered with the wrong result. Cached results are kept in `<CYPHER_BRAIN_HOME>/idempotency-log.jsonl` and expire after `CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS` (default 24h). `backend: "ton-provider"` only appears in the enum when a local TON wallet is already configured — **and, unlike arweave/turbo, no MCP tool on this server can create that wallet** (issue #439): an operator must run `cypher-brain wallet create --chain ton` from a shell, set `CYPHER_BRAIN_TON_WALLET` in this server's own environment, and restart it before `"ton-provider"` shows up here at all |
| `last_snapshot_status` | read-only | latest locator/backend/sha256/timestamp/age from a save-locator file and/or `index.tsv` |
| `verify_restore` | read-only | pull by locator (or a local file) + verify; honest `PASS`/`FAIL`/`PARTIAL` verdict mirroring the CLI exit codes. `require_signature: true` turns an ABSENT `.minisig` from a `[SKIP]` into a `FAIL` — the CLI's `--require-signature` (#319). When it pulls, `pulled.log` carries everything the fetch said — retries, the `sha256 OK` confirmation, transfer progress — and a `signature` object appears when the artifact's `.minisig` was recorded but could not be fetched, which `verify` alone reports as "unsigned (legacy) artifact" (#312) |
| `restore_now` | **writes files, can clobber a DB** (no spend) | pull by locator (or a local file / `locator_file`, same dual-mode input as `verify_restore`) + decrypt + extract into `out_dir` — the actual restore `verify_restore` stops short of. Requires `confirm_write: true` before any work happens; when `pg` is given, `pg_restore --clean --if-exists` also DROPS and replaces objects in that database, the same `--yes` consent the CLI's `restore --pg` requires. `require_signature: true` refuses an artifact whose `.minisig` is absent — checked **before** the identity is loaded or `pg_restore --clean` can drop anything, so it gates the write rather than reporting on it (#319) |
| `estimate_cost` | read-only | upload cost for a size: turbo (winc, via the optional `@ardrive/turbo-sdk`), arweave (winston, gateway `/price`), ton-provider (nanoTON, a real priced query against the live mytonprovider.org registry — only listed when a local TON wallet is configured; no MCP tool can create one, see `snapshot_now` above), file (free). All seven fields are always present, `null` where they do not apply (#268) — never test for a key to decide whether a value exists. For turbo/arweave, `usd_estimate` carries an approximate USD figure when a USD/AR rate is fetchable — a direct HTTP call to Turbo's public rate endpoint (#170), so it works with or without `@ardrive/turbo-sdk` installed — and is `null` on any rate failure. Same computation as `cypher-brain estimate` (`src/lib/estimate.ts`) |
| `schedule_install` | **writes a real system file, can commit to ongoing spend** (no spend by itself) | register the nightly snapshot+push (a launchd plist or crontab entry), the MCP equivalent of `cypher-brain schedule install` (issue #174 follow-up). `arweave`/`turbo` require `max_spend` (a positive integer cap on every unattended run); always requires `confirm_install: true` before any write happens. `backend: "ton-provider"` (only listed when a local TON wallet is configured; no MCP tool can create one, see `snapshot_now` above) is also paid and unattended-capable, but its spend cap is a separate, env-only mechanism (`CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND`, in nanoTON) — this tool's own `max_spend` argument does not apply to it. `no_load: true` writes the artifacts without registering the trigger. `scan_secrets: "warn"\|"deny"\|"off"` bakes the gitleaks gate into the generated nightly (#307). Install resolves the **effective** mode even when none is given and bakes that in (#301) — `warn` when there is a `dirs` entry and gitleaks is resolvable, `off` otherwise — so the nightly never re-derives a default from whatever is on `PATH` at 03:30. An explicit mode other than `off` needs at least one `dirs` entry, and fails rather than installing when gitleaks cannot be resolved |
| `schedule_status` | read-only | the same report as `cypher-brain schedule status`: configured time/backend, which config file supplied settings, trigger registration state, last run log + its final rc line, next scheduled run. **Structured fields**, not the printed lines — `cypher-brain schedule status --json`, this tool and the resource below all return one object built by a single function, so they cannot disagree |
| `keygen` | **writes a keypair** (no spend) | generate a fresh age identity/recipient keypair at `<CYPHER_BRAIN_HOME>/{identity.age,recipient.txt}` — first-run setup for a shell-less agent. `pq: true` generates a post-quantum HYBRID keypair (ML-KEM-768 + X25519) instead of plain X25519. Refuses if one already exists unless `force: true` (destructive — discards the old identity) |
| `wallet_create` | **writes a wallet** (no spend) | generate a fresh Arweave JWK wallet (default `<CYPHER_BRAIN_HOME>/wallet.json`, `out` overrides). Refuses if one already exists at the target path unless `force: true` (destructive — discards spend authority over any funds already sent to it). **Arweave only** (issue #439, still open as a design decision) — no `chain` parameter, so this cannot create a TON wallet; see `snapshot_now` above for the CLI-bootstrap-then-restart steps `backend: "ton-provider"` needs instead |
| `wallet_address` | read-only | derive and show the Arweave address for a JWK wallet file (the address to fund before pushing to `arweave`/`turbo`). **Arweave only** — same #439 scope as `wallet_create` above; a TON wallet's address is printed once by `cypher-brain wallet create --chain ton` at creation time |

**`cypher-brain ledger`, `cypher-brain audit`, and `cypher-brain wallet balance` are CLI-only** (#477):
no MCP tool exposes any of the three, unlike every other CLI/MCP gap in this server, which IS
disclosed at its point of use — `schedule_install`'s description already says `schedule uninstall`
is "not exposed as a tool", `doctor --json` above is documented as having "no MCP tool yet", and
the recovery kit (below) is "CLI-only by design". This line closes the same disclosure gap for
these three.

**An argument a tool does not declare is an error**, not a no-op — the same rule
`config.env` follows for an unknown `CYPHER_BRAIN_*` key, and for the same reason.
Every tool above advertises `additionalProperties: false`; the server enforces that
against the schema it published, names the field it refused, and suggests the near
miss (`restore_now {out}` → *did you mean out_dir?*, the same hint
`cypher-brain restore --out` gives). Misspelling a *required* field only ever failed
by accident; misspelling an *optional* one — `confirm_paid`, `sha256`, `identity`,
`no_load` — used to be discarded silently, so the call looked like it had been
honored as asked (#300).

**A value outside a field's declared `enum` is an error too**, on every tool and
whichever branch the call would have taken (#308). `backend` declares
`["file","arweave","turbo"]`; a value outside that set used to be refused only where
the handler happened to consult it, so `estimate_cost {file, backend: "nonsense"}`
errored while `verify_restore {file, backend: "nonsense"}` returned a clean `PASS`
from a code path that never touched the backend it was given. The check is now
derived from the same published schema as the one above, and a near miss is named
(`backend: "fille"` → *did you mean file?*). Two things it deliberately does not do,
since it is a few lines against the schema rather than a JSON Schema validator: it
reads a top-level property's own `enum` of plain literals — every enum this server
declares — and nothing nested or structural (`scripts/mcp-smoke.mjs` fails the build
on an enum in any other shape, rather than letting one go unenforced); and it says nothing
about which fields a given call will actually *use*, which is the next check.

**A declared field the chosen branch will never read is refused too** (#308). `verify_restore
{file, backend}` takes the local-file branch, fetches nothing, and used to return `PASS` —
a verdict from a code path that never touched the backend it was named. `snapshot_now`
without a `backend` was worse in consequence: `locator_file` and `confirm_paid` only reach
the push step, so a caller asking for the durable recovery pointer got a clean exit and no
file.

This was never a new rule — the server already refused three cases of it, each written by
hand where someone noticed (`locator_file` with `backend`, `ping_url_fail` without
`ping_url`, `max_spend` on a free backend). What was missing is anything that made the
question get *asked*. Each tool now declares which of its fields are branch-dependent,
**with an empty declaration being a real answer**, and the dispatcher refuses to serve a
tool that has no declaration at all — so adding a tool forces the decision instead of
defaulting to silence, and `scripts/mcp-smoke.mjs` turns a forgotten one into a failing
build. Cases already handled inside `src/lib/` stay there: `schedule install`'s three are
shared with the CLI, which needs them just as much.

Claude Code config (`.mcp.json`):

```json
{
  "mcpServers": {
    "cypher-brain": {
      "command": "node",
      "args": ["/path/to/cypher-brain/dist/mcp.mjs"]
    }
  }
}
```

`scripts/mcp-smoke.mjs` (part of `npm run verify`) proves initialize/tools-list,
a real `snapshot_now` round-trip on the `file` backend, `schedule_status` against a
`--no-load` schedule installed via the CLI, that the paid-backend spend gate
refuses without `confirm_paid`, a real `restore_now` round-trip (pull by locator +
decrypt + extract, content asserted on disk) that refuses without `confirm_write`,
and a real `keygen` → `wallet_create` → `wallet_address` round-trip (plus the
no-clobber-unless-`force` refusal) against an isolated `CYPHER_BRAIN_HOME`. It also
walks the whole advertised tool list asserting each one refuses an undeclared
argument, so a tool added later is covered without anyone remembering to.

## Acknowledgements

cypher-brain is a thin layer over other people's work, and deliberately so —
see [Prefer an existing implementation](CONTRIBUTING.md#prefer-an-existing-implementation).
The cryptography, the storage, and most of the hard parts are theirs.

**Built on:**

- [age](https://age-encryption.org) by [@FiloSottile](https://github.com/FiloSottile)
  — the encryption format this project stores everything in, via
  [typage](https://github.com/FiloSottile/typage) (`age-encryption`), the same
  author's TypeScript implementation. No cryptographic primitive here is our own.
- [minisign](https://jedisct1.github.io/minisign/) by
  [@jedisct1](https://github.com/jedisct1) — the signature format `keygen --sign`
  and the `*.minisig` sidecars are compatible with.
- [Turbo](https://ardrive.io) / [`@ardrive/turbo-sdk`](https://github.com/ardriveapp/turbo-sdk)
  and [arweave-js](https://github.com/ArweaveTeam/arweave-js) — the upload and
  gateway paths behind the `turbo` and `arweave` backends.
- [rclone](https://rclone.org) — the entire `rclone` backend is a delegation to
  it; its 70+ providers are its authors' work, not reimplemented here.
- [gitleaks](https://github.com/gitleaks/gitleaks) — the scanner behind
  `snapshot --scan-secrets`.
- [`ignore`](https://github.com/kaelzhang/node-ignore) — gitignore-syntax
  matching for `.cypherbrainignore`, so the semantics match git's rather than a
  hand-rolled glob.
- [Model Context Protocol](https://modelcontextprotocol.io) and its TypeScript
  SDK — the MCP server surface.
- [Bun](https://bun.sh), [Biome](https://biomejs.dev),
  [Changesets](https://github.com/changesets/changesets) and
  [commitlint](https://commitlint.js.org) — build, lint, and release tooling.

**Learned from:** many projects have been read as design models without any of
their code being used. They are credited individually, with what was taken from
each, in [`docs/prior-art.md`](docs/prior-art.md).

### Resources and prompts

The server also exposes one of each, alongside the tools above. The distinction is the
protocol's own: a **tool** is model-controlled (the LLM decides to invoke it), while a
**resource** is application-controlled — something a client can attach without the model
having to think to ask.

| Kind | Name | What it is |
|---|---|---|
| resource | `cypher-brain://schedule/status` | The installed schedule's state, as JSON — the **same object** the `schedule_status` tool returns, from one function, so they cannot describe the state differently (`next_run` is computed from the clock at call time, so two reads can legitimately differ by a minute). Useful pinned into a conversation: "is the nightly backup still armed" is a thing you want visible, not something to remember to check. |
| prompt | `restore-runbook` | The restore procedure — pull, verify *before* trusting, then decrypt into a scratch target. Its text is [`MANAGEMENT.md`](MANAGEMENT.md)'s "Restore runbook" section, inlined at build time, so it cannot drift from the documentation. |

Only these two, deliberately. `last_snapshot_status` takes optional path arguments and
would need a URI template, which is a separate decision; and every capability is surface
area on a security-adjacent server, so the case for widening it should come from a client
that actually wanted more.

## Project continuity

`cypher-brain` is currently maintained by a single person
([@Masashi-Ono0611](https://github.com/Masashi-Ono0611)). There is no formal
succession plan or pre-granted collaborator/npm-publish access at this time.

If you need to reach the maintainer about something urgent — a security
issue, or the project appearing unmaintained for an extended period — use
GitHub's private vulnerability reporting (see [`SECURITY.md`](SECURITY.md))
for security matters, or open a public issue otherwise. There is no other
published contact channel.
