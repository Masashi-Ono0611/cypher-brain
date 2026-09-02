# Managing cypher-brain snapshots

How to run encrypted gbrain backups over time: **cadence**, **versioning**,
**restore**, and **key recovery**. The recovery and versioning claims here are
exercised by `npm run selftest:recovery` (gated in CI).

> **New setup?** `cypher-brain init` is the recommended entry point — an interactive
> wizard that walks keygen, the backup key and passphrase-wrap choices below,
> `CYPHER_BRAIN_PIN_RECIPIENTS`, a `--profile`, and the first snapshot + push, ending
> in a printable recovery kit (issue #68; exercised end-to-end by
> `npm run selftest:init`, including a kit-only restore drill). Everything below still
> applies — the wizard is a thin, interactive front end over these same commands, not
> a different mechanism.

## Key recovery — "losing the identity *or the locator* must not lose the brain"

Recovery needs **two** things, and both can be lost. The private `identity.age` is the
only thing that can *decrypt* — lose it and every snapshot is permanently unreadable.
But the **locator** (which tx id / store path holds the latest ciphertext) is
the only thing that tells a fresh machine *where to fetch from* — and today the full
record of locators is a local `index.tsv` on the always-on box. If that box dies, an
operator who backed up only the identity still cannot find the bytes. So back up both:
the identity (below) **and** the latest locator (`#3`).

cypher-brain gives you two independent defenses for the identity; **use both**.

### 1. Encrypt to a backup key (recommended, built in)

`snapshot --recipient` is repeatable. Give it a **primary** and an **offline
backup** public key, and *either* identity can restore:

```sh
# one-time: make a backup keypair on a machine you control, keep its identity OFFLINE
CYPHER_BRAIN_HOME=~/.cypher-brain-backup cypher-brain keygen     # -> backup recipient + identity

# every snapshot: encrypt to BOTH the primary and the backup public key
cypher-brain snapshot --dir ~/.gbrain --pg "$PG" \
  --recipient ~/.cypher-brain/recipient.txt \
  --recipient ~/.cypher-brain-backup/recipient.txt \
  --out brain-$(date +%F).age
```

Store the backup `identity.age` somewhere the primary machine isn't: an encrypted
USB in a drawer, a second location, a trusted person. If the primary box dies, the
backup identity restores everything. (Proven in `selftest-recovery.sh`: the backup
key restores with the primary identity absent; an unrelated key cannot.)

Either `keygen` call above can add `--pq` for a post-quantum HYBRID keypair
(ML-KEM-768 + X25519) instead of plain X25519 — the primary and backup don't need
to match (a hybrid primary + an X25519 backup, or vice versa, both restore). See
README Threat model for why this matters against harvest-now-decrypt-later.

### 2. Back up the identity file itself

The identity is a short text file — copy it somewhere durable and private:
a password manager (secure note), a printed copy in a safe, or a hardware-backed
store. Treat it like a seed phrase.

**Protect it at rest.** A bare `keygen` identity (the standard age secret-key file) is an unwrapped secret guarded
only by file perms (0600) — theft of the file = every snapshot decryptable. Two
defenses, ideally both:
- **Passphrase-wrap it:** `cypher-brain keygen --passphrase` (for a *fresh* keypair) or
  `cypher-brain keygen --wrap-in-place` (for an identity you already have — e.g. one
  created by a bare `keygen`, or by `init` with this step skipped) encrypts the identity
  with a scrypt passphrase (you enter it on `restore`/`verify`). An exfiltrated identity
  file is then useless without the passphrase. **Do not** use `keygen --passphrase
  --force` to add a passphrase to an existing identity — `--force` always generates a
  brand-new keypair (it does not wrap the old one), so every snapshot already encrypted
  to the old identity becomes unrecoverable; `--wrap-in-place` keeps the same keypair.
- **Full-disk-encrypt the identity host.** The machine that holds the identity is
  secret-bearing (it can read every snapshot); FileVault / LUKS protects it (and any
  off-box copies) if the disk or USB is lost or stolen.

> **M-of-N (Shamir) split** — splitting the identity into *N* shares where any *K*
> reconstruct it (no single point of loss *or* compromise) is tracked as a future
> option rather than hand-rolled here. See the repo issues.

### 3. Retain the latest locator off-box (built in)

The identity decrypts, but you still need to know *where the latest ciphertext lives*.
`push --save-locator <path>` writes
`<locator>\t<backend>\t<sha256>[\t<content_digest>[\t<recipients_fingerprint>[\t<sig_locator>[\t<sign_key_id>]]]]`
to a small file, rewritten atomically on every push so it always holds the **most
recent** snapshot's locator plus an integrity pin. The optional 4th field is the
plaintext content digest (from the `<out>.digest` sidecar `snapshot` writes); the
optional 5th is the recipients fingerprint (from the `<out>.recipients-fingerprint`
sidecar); the 6th is where the `<out>.minisig` authenticity sidecar was pushed, if
any, and the 7th is the signing key id inside it. `push --skip-unchanged` compares
content, recipients AND signing state against the current snapshot and only skips when
none of them changed — so re-snapshotting unchanged content under a **different**
`--recipient` set (added/removed a key), or after enabling or rotating the signing key,
never returns a stale locator. Older 3-, 4-, 5- and 6-field files keep working
everywhere:

```sh
cypher-brain push --in brain-$(date +%F).age --backend turbo --yes \
  --save-locator ~/.cypher-brain/latest-locator.tsv
```

> **Use a network backend here.** For `--backend file` the locator is a *local* store
> path, useless on a fresh machine — `turbo`/`arweave`/`ton` locators are portable
> (a `ton` pull additionally needs the bag to still be seeded somewhere — see
> docs/durability.md).

Back this file up **off-box, next to the backup identity** (same encrypted USB / secure
note). Recovery on a fresh machine then needs only those two things — no `index.tsv`. The
saved sha256 is applied automatically, so a substituted ciphertext is rejected.
After each push, `cypher-brain recovery-kit --from-locator-file <this file>` regenerates
the printable kit `init` produced, pointed at the NEW locator — the printed copy goes
stale each cycle otherwise (#364):

```sh
cypher-brain pull --from-locator-file ~/restore/latest-locator.tsv --out latest.age
cypher-brain restore --in latest.age --out-dir ./restored --pg "$PG_RESTORE" --yes
```

For full version history (not just the latest), keep backing up the whole `index.tsv`
(below) — but the single latest-locator file is the minimum that makes disk-death
recoverable. *(A stable name that always resolves to the newest snapshot — an ArNS
mutable pointer — is a future option; until then this file is the durable pointer.)*

## Settings in a file, and what that does *not* change

Any `CYPHER_BRAIN_*` setting can live in `$CYPHER_BRAIN_HOME/config.env` — one
`KEY=value` per line, `#` comments — instead of being re-established in every
shell. The CLI and the MCP server both read it.

```sh
# $CYPHER_BRAIN_HOME/config.env   (chmod 600 — it may hold secrets)
CYPHER_BRAIN_AR_WALLET=/Users/me/.cypher-brain/wallet.json
CYPHER_BRAIN_MAX_SPEND=500000
CYPHER_BRAIN_FILE_DIR=/Volumes/backup/cypher-brain-store
```

- **An explicit environment variable wins over the file.** `CYPHER_BRAIN_MAX_SPEND=1
  cypher-brain push …` overrides whatever the file says, every time.
- **`CYPHER_BRAIN_HOME` cannot come from the file** — the file lives inside it. Set
  that one in the environment; a file that tries is warned about, not obeyed.
- **An unknown `CYPHER_BRAIN_*` key is an error**, not a no-op. A
  `CYPHER_BRAIN_MAXSPEND` typo would otherwise silently remove a spend cap.
- **Only `CYPHER_BRAIN_*` settings are applied.** Any other key in the file is read
  (so it can be reported) but never enters the environment — a stray `TMPDIR` or
  proxy variable in there cannot reach the `tar`, `pg_dump` or `rclone` processes
  cypher-brain spawns.
- **The pre-rename `CIPHER_BRAIN_*` spelling also works**, in the file exactly as
  in the environment — same names, `cipher` instead of `cypher`. Setting the same
  key under both spellings in the same file is refused as ambiguous, same as
  setting both in the environment.

**What it does not change is the nightly run.** `schedule install` still bakes the
values that were in effect *at install time* into the runner, because launchd and
cron start with a bare environment and the guarantee worth keeping is that the
unattended run uses the configuration the operator actually tested. Editing
`config.env` afterwards does **not** retune an installed schedule: the generated
runner sets `CYPHER_BRAIN_NO_CONFIG_FILE=1`, so it uses only what was baked in and
is unaffected by later edits — including an edit that would refuse a normal
invocation. Re-run `schedule install` to pick changes up. `cypher-brain schedule status` prints
which config file it loaded, so "why is this behaving differently" has an answer.

## Cadence

gbrain re-synthesizes nightly, so a **nightly** snapshot is the natural cadence.
`cypher-brain schedule install` is the primary path: it composes the snapshot+push
pipeline from the same flags those commands take, writes it as a runner script
(`$CYPHER_BRAIN_HOME/schedule/nightly.sh`), and registers the platform trigger —
a `launchd` agent on macOS, a `crontab` entry on Linux:

```sh
# runs on the machine that holds gbrain (it has the public key only)
# --dir here assumes gbrain's default ~/.gbrain. If gbrain's OWN GBRAIN_HOME env
# var relocates its home elsewhere, gbrain actually lives at $GBRAIN_HOME/.gbrain
# (not $GBRAIN_HOME itself) — point --dir there instead.
cypher-brain schedule install --backend turbo \
  --pg "postgres://you@localhost:5432/gbrain" --dir "$HOME/.gbrain" \
  --recipient ~/.cypher-brain/recipient.txt \
  --recipient ~/.cypher-brain-backup/recipient.txt \
  --max-spend 500000000            # REQUIRED for arweave/turbo (native units) — see below

cypher-brain schedule status       # configured time · trigger state · last run + rc · next run
cypher-brain schedule uninstall    # unregister the trigger, remove the generated artifacts
```

The default run time is **03:30** (change with `--at HH:MM`): well after gbrain's
overnight re-synthesis settles, so the DB and files are captured from the same settled
state ("Avoid the write window", below). Each run appends to
`$CYPHER_BRAIN_HOME/schedule/logs/nightly-YYYY-MM-DD.log` and always ends with a
machine-readable `OK rc=0` / `FAILED rc=N` line, so `schedule status` (or any monitor)
can tail the newest log for the outcome.

That, though, is a *pull*: it tells you the outcome only when you go check. Add
`--ping-url <url>` for the *push* half — a `healthchecks.io`-style dead man's switch —
and every run also `curl`s that URL on success, or `<url>/fail` on failure (a plain
string append, not URL-aware — pass `--ping-url-fail` explicitly if your ping URL has
a query string or a trailing slash), so a schedule that silently stops running at all
gets noticed even if nobody runs `schedule status`. Both are best-effort (10s timeout,
never affects the run's own outcome).

**The unattended run carries the secret-scanning gate too, by default.** The generated
runner's `snapshot` line always carries an explicit `--scan-secrets`, whether or not you
passed one: install resolves the same default the interactive command uses (`warn` when
there is a `--dir`/`--profile` source and [gitleaks](https://github.com/gitleaks/gitleaks)
is resolvable, `off` otherwise) and bakes the result in (#301). That is deliberate — a
runner that re-derived its own default at 03:30, from a bare `launchd`/`cron` `PATH`,
would start or stop scanning based on what happened to get installed months later. Pass
`--scan-secrets deny` to refuse a leaking nightly outright, or `off` to record that this
schedule does not scan. It matters most here, because this is the
run nobody is watching when it pushes to a write-once store. Install resolves `gitleaks`
at that moment and *pins* the absolute path into the runner as
`CYPHER_BRAIN_GITLEAKS_BIN` (`launchd`/`cron` do not inherit your `PATH`, the same reason
`--pg` bakes `CYPHER_BRAIN_PG_BIN` — pinned rather than added to `PATH` so a different
`gitleaks` on the scheduler's `PATH` cannot quietly take its place), and *refuses to
install* if it cannot be resolved. An explicit `CYPHER_BRAIN_GITLEAKS_BIN` is resolved and
validated the same way rather than trusted: a bare name or a stale path in it is just as
unusable to the scheduler. It stays fail-closed afterwards: if `gitleaks` later
disappears, the nightly ends `FAILED rc=N` rather than quietly snapshotting unscanned.
`schedule status` reports the scan mode the installed schedule is *configured* with (it
reads `schedule.json`, so it is not a health check). The gate covers `--dir`/`--profile`
staged plaintext only, so a `--pg`-only schedule is refused rather than installed
reporting a scan of no component — and gitleaks does not look inside archives, so a
zip source (e.g. `--profile chatgpt-export`) is scanned only as opaque bytes
(`--profile o2b`'s bundle is plain JSON, not an archive, so it is scanned like any
other file). (The MCP
`schedule_install` tool takes the same `scan_secrets` field.)

**Paid backends must be capped.** For `turbo`/`arweave` the generated runner sets
`CYPHER_BRAIN_YES=1` — the unattended equivalent of `--yes` — which is exactly why
`schedule install` *refuses* those backends without `--max-spend <n>`: an unattended
nightly upload must never run uncapped. Review the `CYPHER_BRAIN_MAX_SPEND` line it
writes (native units: winc for turbo, winston for arweave L1); if
`CYPHER_BRAIN_AR_WALLET` is set when you run install it is baked into the runner,
otherwise edit the commented wallet line the runner carries. Wallet funding and
credit-share setup: [`docs/arweave-upload-runbook.md`](docs/arweave-upload-runbook.md).

What the generated runner does is the hand-rolled recipe it replaces — kept here as
the explanation of the moving parts:

```sh
# nightly.sh (shape of the generated runner)
set -euo pipefail
# Keyed on date+time (not just the day) and disambiguated on collision, so a manual
# test/retry on install day — or any same-day re-run — never refuses to overwrite
# the prior run's snapshot.
STAMP="$(date +%Y%m%dT%H%M%S)"
OUT="$HOME/.cypher-brain/schedule/snapshots/brain-$STAMP.age"
n=1
while [ -e "$OUT" ]; do n=$((n + 1)); OUT="$HOME/.cypher-brain/schedule/snapshots/brain-$STAMP-$n.age"; done
cypher-brain snapshot --pg "postgres://you@localhost:5432/gbrain" --dir "$HOME/.gbrain" \
  --recipient ~/.cypher-brain/recipient.txt --recipient ~/.cypher-brain-backup/recipient.txt \
  --out "$OUT"
# turbo (the recommended backend) is a paid, permanent store — CYPHER_BRAIN_YES=1
# suppresses the interactive --yes guard when running unattended, and
# CYPHER_BRAIN_MAX_SPEND=<n> (native units: winc for turbo, winston for arweave L1)
# aborts when the cost estimate exceeds your budget. Omit both (and the wallet) for
# the free file backend.
export CYPHER_BRAIN_YES=1
export CYPHER_BRAIN_MAX_SPEND=500000000
export CYPHER_BRAIN_AR_WALLET="$HOME/.cypher-brain/wallet.json"   # JWK signer for turbo
# --save-locator keeps a one-line file with the LATEST locator; back it up off-box
# next to the backup identity so disk-death is recoverable (see Key recovery #3).
# --skip-unchanged reads the plaintext content digest snapshot wrote to "$OUT.digest"
# AND the recipients fingerprint it wrote to "$OUT.recipients-fingerprint"; only when
# BOTH match what's recorded in the save-locator file does it exit 0 with the previous
# locator instead of paying to re-upload (a changed --recipient set always re-uploads;
# --force overrides either way).
LOC=$(cypher-brain push --in "$OUT" --backend turbo --skip-unchanged \
  --save-locator "$HOME/.cypher-brain/latest-locator.tsv")   # or: file | arweave
# Read the SHA256 back from the save-locator file's 3rd field rather than re-hashing
# "$OUT": on a --skip-unchanged SKIP, $LOC is the PREVIOUS run's locator while $OUT is
# THIS run's freshly re-encrypted (age's ephemeral file key differs every run) and
# never-uploaded ciphertext — shasum-ing $OUT would pair $LOC with a hash it will never
# actually produce, breaking any later `pull --locator ... --sha256 ...` check against
# this index row. The save-locator file's 3rd field already holds the correct hash for
# whatever $LOC points to (cypher-brain push writes it there on every real push, and
# leaves it untouched — still correct — on a skip).
SHA=$(cut -f3 "$HOME/.cypher-brain/latest-locator.tsv")
printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$LOC" "$SHA" \
  >> "$HOME/.cypher-brain/schedule/index.tsv"
```

`schedule install --index-file <path>` overrides where the generated runner appends this
line, if `$CYPHER_BRAIN_HOME/schedule/index.tsv` (shown above) isn't where you want it.

Snapshotting needs only the **public** key, so the snapshots the always-on box
writes (and anything storage sees) are ciphertext only. Two caveats: that box also
runs gbrain, so the live plaintext is on it regardless (keep it full-disk-encrypted);
and a box that can rewrite `recipient.txt` could re-key *future* snapshots — set
`CYPHER_BRAIN_PIN_RECIPIENTS` (an allowlist of `age1…` keys) so snapshot refuses any
recipient you did not pin. A full snapshot is ~850 MB today (pg_dump ~630 MB +
`~/.gbrain` ~220 MB); incremental snapshots are a future optimization.

Prove restorability where the identity lives, on a cadence: a `verify` on the
public-key-only snapshotting box reports **PARTIAL** (exit 2) because it cannot run
the decrypt proof, so periodically pull a recent snapshot to a machine that holds the
identity and run `verify` there (a full **PASS** = restorable by you). `scripts/selftest-recovery.sh` is the off-box drill in miniature.

**Avoid the write window.** A run `pg_dump`s the DB and then tars `~/.gbrain` at
*different instants*, so a snapshot that straddles gbrain's nightly re-synthesis can
pair a newer DB with older files (or vice versa). Schedule the snapshot *outside* that
window (gbrain re-synthesizes overnight — snapshot well after it settles). The manifest
now records a top-level `created_at` and a per-component `captured_at` (echoed by
`restore`/`verify`), so any DB↔files skew is detectable after the fact. (`pg_dump -Fc`
is itself point-in-time consistent via one REPEATABLE READ txn — only the DB↔file
boundary needs aligning.)

**On PGLite, the write window is the whole story.** gbrain's default engine keeps the
entire database as a directory on disk, so there is no `pg_dump` and nothing gives that
directory point-in-time consistency: it is tar'd like any other `--dir` while the engine
may be mid-write. PostgreSQL — which is what PGLite is — does not support file-level
copies of a running cluster outside its own backup API, because a copy that spans time
captures different files at different instants and can tear a page. Crash recovery
salvages most such copies, but it is not guaranteed to, and an inconsistent copy can
also open carrying latent damage. Stop gbrain for the duration when you can; the nightly
`--at` default of 03:30 does not do that for you. `verify` will not tell you either way
— it checks the ciphertext, which is well-formed regardless — so see the Restore runbook
for what to do if a restored store will not open.

`snapshot` prints a ⚠ warning (it reaches the run summary and the MCP `warnings` array)
when a source **is** such a directory, or has one **directly inside it** — the markers
are `PG_VERSION` plus `pg_wal/`. Two limits worth knowing, both deliberate:

- **How deep it looks.** Without a `.cypherbrainignore`, detection reads the source root
  and one level below it — enough for `--dir <store>` and for `--dir ~/.gbrain` with the
  store at the configured `database_path`, and bounded so pointing `--dir` at a large
  tree does not pay for a full recursive walk to produce an advisory. *With* an ignore
  file the walk has already happened, so detection is exact at any depth. A store nested
  deeper than one level under a source with no ignore file is not warned about.
- **What the markers prove.** They identify a Postgres-format data directory, which is
  what a PGLite store is — but an ordinary PostgreSQL server's datadir under a `--dir`
  looks identical, and nothing inside distinguishes the two. The warning says "PostgreSQL
  data directory" for that reason. The hazard is the same either way.

It is a warning and never a refusal, because an unattended nightly run must still produce
a backup. A data directory the ignore file has cut into pieces gets a **stronger** warning
instead, in one of three strengths — each says only what the exclusion actually proves,
and the fix in every case is to remove the rule:

- the exclusion removes a **marker file** (`PG_VERSION`, `global/pg_control`) or an
  **entire required directory** (`pg_wal/`, `base/`, `global/`) → the restored copy
  **cannot be opened at all**, which is worse than merely maybe-inconsistent;
- the exclusion takes paths from **inside** one of those directories without removing it
  → it **may** prevent the copy opening, and the warning names the directory. Some of
  what lives there is disposable (`pg_wal/archive_status/*.done`, for instance) and some
  is load-bearing; nothing in a backup tool can tell which you cut, so it does not
  pretend to;
- the exclusion hits only other files (`postmaster.pid`, a log, transient stats) → the
  copy **may still open**. Still reported, because a data directory is meant to be
  archived whole and `verify` cannot tell you whether what went missing mattered.

## Minimal recovery profile (`--pg-filter` / `--pg-exclude-table-data`)

A full `--pg` snapshot dumps the whole database — every table, including large or
low-value-for-disaster-recovery ones like raw conversation logs, tool-run logs, or an
embedding cache. `snapshot` can also produce a smaller, lower-risk **minimal** artifact
alongside the normal full one, using nothing but `pg_dump`'s own standard filtering
flags — cypher-brain does **no SQL parsing or filtering of its own**; these two flags
are a literal pass-through to `pg_dump`, which runs exactly as it would if you invoked
it by hand with the same arguments.

- **`--pg-filter <file>`** → `pg_dump --filter <file>` (requires `pg_dump` ≥ 17). The
  file holds one `{include|exclude} {table|schema} PATTERN` line per entry. Full syntax:
  [PostgreSQL docs — Filtering](https://www.postgresql.org/docs/current/app-pgdump.html#PG-DUMP-FILTERING).
  Example filter file:
  ```
  include table conversation_summaries
  exclude table conversation_logs
  exclude table embedding_cache
  ```
- **`--pg-exclude-table-data <table>`** (repeatable) → `pg_dump --exclude-table-data <table>`:
  keeps the table's *schema* in the dump but drops its *rows* — useful for a cache table
  you'd rather restore empty than have missing entirely.

Both are additive to `--pg-table` and to each other, and are ONLY applied when passed —
omit them and `--pg` behaves exactly as before (a full, unfiltered dump). Passing
`--pg-filter`/`--pg-table`/`--pg-exclude-table-data` *without* `--pg <conn>` (or with `--pg`
given but empty) is **refused with an error** rather than silently ignored — these flags
only mean anything to a `pg_dump` that is actually running, so both `snapshot` and
`schedule install` reject that combination up front instead of installing/running a backup
that quietly drops the filter. A typical setup
runs `schedule install`/a cron job for the full backup (disaster recovery) and a second,
separate `snapshot --pg-filter ...` for the minimal one (long-term/off-site/lower-risk
storage):

```sh
cypher-brain snapshot --pg "$PG" --pg-filter ./minimal-profile.txt \
  --recipient ~/.cypher-brain/recipient.txt --out "minimal-$(date +%F).age"
```

The manifest records what was passed (`filter`/`exclude_table_data` alongside the
existing `tables` field) purely for transparency — restore never reads it back; a
`pg_restore` of a minimal dump just restores whatever pg_dump actually put in it.

## Versioning

Each snapshot is immutable: `push` returns a **locator** whose form depends on the
backend — a store path (`file`, content-addressed) or a tx id assigned *after*
upload (`arweave`/`turbo`; not a content hash). Keep an append-only
`index.tsv` of `timestamp · locator · sha256` (the scheduled nightly runner does this).
That index *is* your version history — every line is an independently restorable
point in time. To find the *most recent* backup, a fresh machine reads the latest
line of `index.tsv`, or the one-line `--save-locator` file (Key recovery #3) if it
has only that. *(A self-resolving stable name — an ArNS pointer updated to the
newest locator — would let a fresh machine find the latest with no local file at
all; that is a future option, not yet implemented.)*

### A snapshot output is `--out` **plus its sidecars**, and all of them are no-clobber

`snapshot` writes up to three files alongside `--out`: `<out>.digest`,
`<out>.recipients-fingerprint`, and — whenever a signing identity is present —
`<out>.minisig`. Since #783 every one of those paths gets the same refusal `--out`
itself has always had: if anything is already sitting there, the run refuses
(`CB-E009`) before staging anything, and it refuses a **symlink** too rather than
writing through it.

That matters most for `.minisig`. A signature file left over from a *different*
artifact used to survive a run that did not sign (no signing identity, or
`--no-sign`), and `restore`/`verify` would then find a present, well-formed
signature that does not verify against those bytes — refusing the new snapshot as
tampered or forged (`CB-E016`), permanently. If you reuse an output name, clear the
old sidecars along with the old `*.age`; the refusal now tells you which one is in
the way instead of producing a backup that cannot be restored.

## Restore runbook

On a machine that holds a recipient **identity** (primary or backup):

```sh
# 1. pick a version from index.tsv (or the latest line); take its <locator>
# 2. fetch the ciphertext back from storage
cypher-brain pull --locator "<locator>" --backend "$BACKEND" --out restored.age

# 3. confirm it is intact and yours BEFORE trusting it
cypher-brain verify --in restored.age          # header + your key decrypts it
# (this is --level quick, the default — see "Verification levels" below for
# remote/drill, which check the STORAGE side of this same question instead)

# 4. decrypt + rebuild into a SCRATCH database (never straight over a live gbrain)
# --pg runs pg_restore --clean --if-exists, which DROPS/replaces objects in the
# target database — an irreversible operation, so it requires --yes to confirm.
cypher-brain restore --in restored.age --out-dir ./restored \
  --pg "postgres://you@localhost:5432/gbrain_restore" --yes

# 5. sanity-check row counts / content, then cut over deliberately
```

If you only need the files (not a live DB), drop `--pg` — every `--dir`/`--profile`
component is auto-expanded into `./restored/expanded/<NNN>-<source basename>-<digest>/`,
keyed to the component's ORIGINAL absolute source path (from `manifest.json`), not its
on-disk name. This is what makes many same-basename sources (e.g. dozens of claude-code
project `memory/` dirs under `--profile claude-code`) still land in separate directories
instead of an undifferentiated pile of `memory.tar.gz` / `memory-1.tar.gz` / etc that
only `manifest.json` could disambiguate (#181) — the numeric `<NNN>` index guarantees
that exactly within one restore's manifest, and the full, un-truncated SHA-256 digest of
the full source path keeps that guarantee even across two SEPARATE restores into the
same `--out-dir` (#423), so the directory NAME itself only needs to carry a short,
readable label plus that digest, not the whole source path.
`./restored/expanded/README.txt` (and restore's own stdout) records which expanded
directory came from which FULL source path. Nothing is ever
written back to that original absolute path — expansion only ever creates NEW
directories under `--out-dir`, and re-running restore into the same `--out-dir` does not
clobber a prior expansion (same no-clobber posture as the outer extract). Pass
`--no-expand-components` to skip this and get only the raw `*.tar.gz` files (the
pre-#181 behavior, still there either way as the fallback).

**A restored PGLite store that will not open.** On gbrain's default engine there is no
`--pg` step: step 4 just extracts the store's directory and you point gbrain at it. If it
was copied while gbrain was writing (see "Avoid the write window" above) the copy may be
internally inconsistent — one reported shape is a torn write-ahead log, which upstream
describes as a `RuntimeError: Aborted()` on connect.

For that shape, gbrain's own `gbrain pglite-repair`
([garrytan/gbrain#3901](https://github.com/garrytan/gbrain/pull/3901), shipped in
v0.42.75.0) is worth trying; run it against the *extracted copy*, never the live store.
Treat it as a thing to try, not a guarantee: it targets the write-ahead log, and not
every inconsistency a file-level copy can produce is WAL-shaped. If it does not help,
fall back to an earlier version from `index.tsv` — which is the real argument for keeping
more than one. cypher-brain has no repair of its own and deliberately adds none; this is
gbrain's data format, not ours.

## Verification levels (`quick` / `remote` / `drill`)

The restore runbook above answers "can I restore *right now*, from a copy I already
fetched". It does not answer "is the copy still sitting in storage the way I think it
is" — the failure mode that actually bites backup tools: a snapshot pushed once and
never looked at again, discovered broken only when it's finally needed, years later
(#209). `verify --level` (default `quick`, unchanged) adds two deeper, restic/kopia-style
checks for exactly that gap — each one a strictly slower, more thorough proof than the
one before:

```sh
# quick (default): the LOCAL ciphertext only — no network access. Same checks
# `verify` has always run: age header, wrong-key rejection, and (with the private
# identity on this box) a positive-control decrypt.
cypher-brain verify --in snap.age

# remote: re-fetches by locator from the ACTUAL backend and re-runs the same
# checks against what came back — proving the object is still retrievable and
# unchanged, not merely that a local copy still parses (restic `check
# --read-data-subset`'s idea). A fetch failure reports VERDICT: FAIL, not a crash.
cypher-brain verify --level remote --from-locator-file "$CYPHER_BRAIN_HOME/last-locator.tsv"

# drill: everything remote does, plus an actual decrypt + extract into a scratch
# directory (the same code path `restore` runs) — the full pull -> decrypt ->
# extract rehearsal, cleaned up afterward either way. Never runs pg_restore, even
# with --pg given: a verification drill must not touch a live database.
cypher-brain verify --level drill --from-locator-file "$CYPHER_BRAIN_HOME/last-locator.tsv"
```

Suggested cadence, layered on top of the nightly snapshot+push from "Cadence" above —
`quick` is cheap enough to run every time (folding it into the nightly runner is not
built in, but a one-line addition to the generated `nightly.sh` does it); `remote` and
`drill` cost a real fetch (and, for `drill`, a real decrypt) so a coarser schedule is
the point, not a compromise. `verify` has no `--ping-url` of its own (that flag belongs
to `schedule install`, baked into the *generated nightly runner* — see "Cadence" above),
so a verification cron wires its own dead man's switch the same way that runner does:
`curl` the success URL when the command exits 0, `curl` `<url>/fail` otherwise.

```sh
# crontab -e (or the launchd equivalent) — weekly remote, monthly drill. Each line
# is its own dead man's switch (#202's healthchecks.io-style idea, applied by hand
# here since verify itself has no --ping-url): ping on success, ping .../fail
# otherwise, so a verification cron that silently stops running gets noticed too.
0 4 * * 0  cypher-brain verify --level remote --from-locator-file ~/.cypher-brain/last-locator.tsv >>~/.cypher-brain/verify-remote.log 2>&1 && curl -fsS -m 10 https://hc-ping.com/<uuid-remote> || curl -fsS -m 10 https://hc-ping.com/<uuid-remote>/fail
0 5 1 * *  cypher-brain verify --level drill  --from-locator-file ~/.cypher-brain/last-locator.tsv >>~/.cypher-brain/verify-drill.log  2>&1 && curl -fsS -m 10 https://hc-ping.com/<uuid-drill>  || curl -fsS -m 10 https://hc-ping.com/<uuid-drill>/fail
```

(`--ping-url` here is the same plain best-effort `curl` idea `schedule install --ping-url`
bakes into the nightly runner — `verify` does not implement it itself, so the cron line
pipes to a tool that does, or you wire your own healthcheck around it.)

## Error codes

Failures print with a stable `[CB-E0xx]` code and a link to this section, the same shape
ngrok uses for its own errors (https://ngrok.com/docs/errors): `error: <existing message>
[CB-E0xx] see https://github.com/Masashi-Ono0611/cypher-brain/blob/main/MANAGEMENT.md#error-codes`
(a full GitHub URL rather than a bare relative filename — issue #727: `MANAGEMENT.md`
itself isn't part of the published npm package, so a relative pointer resolves to
nothing for an `npx`/global install). The code identifies the FAILURE PATTERN, not
the exact wording — it's meant to stay stable across a future rewording of the surrounding
message (`src/lib/errors.ts`'s registry matches text, so keeping that promise in practice
means the registry entry is updated in the SAME change that reworks its message — see that
file's `source` field on each entry). An error with no code just means it hasn't been
assigned one yet (issue #212 seeded the registry and later issues have grown it since —
see `src/lib/errors.ts`'s `ERROR_CODES` array for the current, authoritative count — it
covers the most common failure patterns, not every possible failure); the plain message
is still the full story either way. Over MCP,
`verify_restore`/`snapshot_now`/etc.'s error result also carries the code as its own
`cb_code` field, so an agent can branch on it without parsing the message text.

| Code | Cause | Next action |
|---|---|---|
| CB-E001 | `pull --sha256` (or a locator-file's saved pin) didn't match the fetched bytes — the storage/gateway served something else. | Retry against a different gateway/backend, or re-check the trusted source (e.g. `index.tsv`) the expected hash came from. Never trust a substituted artifact that still merely opens. |
| CB-E002 | age decryption itself failed — most often the identity you gave isn't a recipient this ciphertext was encrypted to (wrong `--identity`/wrong keypair), or the artifact is corrupt/truncated. | Confirm you're pointing at the identity that matches one of the snapshot's `--recipient`s. If it should be the right key, re-fetch the artifact and check its size/sha256 for truncation. |
| CB-E003 | The identity file is passphrase-wrapped (`keygen --passphrase`) and the passphrase given was wrong (or the file is damaged). | Re-enter the correct passphrase (prompted on the TTY, or set `CYPHER_BRAIN_PASSPHRASE` for automation). |
| CB-E004 | `pull` reached the backend, but the object isn't retrievable yet — a fresh Arweave/Turbo upload typically takes ~5-8 min to propagate to a gateway. | Re-run with `--wait <seconds>` (retries until ready), or simply wait a few minutes and pull again. |
| CB-E005 | `CYPHER_BRAIN_PIN_RECIPIENTS` is set, and a recipient this snapshot would encrypt to is not on that allowlist (a tampered `recipient.txt`, or an unexpected extra `--recipient`). | Confirm the recipient is one you actually intend to grant access; if so, add it to `CYPHER_BRAIN_PIN_RECIPIENTS`. If not, this is exactly the attack the pin exists to catch — investigate before proceeding. |
| CB-E006 | The upload's cost estimate exceeds `CYPHER_BRAIN_MAX_SPEND`, or the signing wallet's balance/credits are insufficient. | Raise (or intentionally lower) `CYPHER_BRAIN_MAX_SPEND`, or fund the wallet (Turbo Credits top up at app.ardrive.io; Arweave L1 needs AR in the JWK's own address). |
| CB-E007 | `push`/`schedule install` targets a paid, permanent backend (arweave/turbo) without consent. | Pass `--yes`, or set `CYPHER_BRAIN_YES=1` (the unattended-cadence escape hatch) to confirm the spend. |
| CB-E008 | `push --in` points at a file that isn't age ciphertext (its header doesn't match) — storage must only ever see ciphertext. | Pass the `.age` file `cypher-brain snapshot` produced, not a plaintext/other file. |
| CB-E009 | The command's output path already exists and no-clobber refused to overwrite it (protects a prior snapshot/pull result from silent loss) — or `push --backend rclone --remote <name>:<path>` found an object already sitting at that exact remote path (#533: rclone destinations are operator-named, not content-addressed, so a reused `--remote` could otherwise silently replace a different snapshot). | Pick a different `--out`/`--save-locator`/`--remote` path, move the existing file aside, or pass `--force` to overwrite it deliberately. |
| CB-E010 | A `file`-backend locator resolves outside `CYPHER_BRAIN_FILE_DIR`, or doesn't match the `<sha256>.age` shape `push` itself produces — refused as a possible path-traversal/arbitrary-file-read attempt via a tampered locator. | Only pass locators exactly as `push` printed them (or as saved in a `--save-locator`/index file from a trusted, off-box copy); don't hand-construct one. |
| CB-E011 | The `arweave`/`turbo` backend needs `CYPHER_BRAIN_AR_WALLET` (a JWK signer) and it's unset, or the path isn't readable — or `wallet address`/`wallet balance` was pointed at a wallet file that exists but isn't readable (corrupt/non-JSON contents, a permission error, …; a wallet file that's simply MISSING is CB-E019 instead). | Run `cypher-brain wallet create` to generate one, then set `CYPHER_BRAIN_AR_WALLET` to its path (`wallet address` shows what to fund). If the file exists but won't parse, re-create it or fix its permissions. |
| CB-E012 | The optional package the backend needs isn't installed — `arweave` (an optional peer) or `@ardrive/turbo-sdk` (an `optionalDependency` a normal install carries, but which can be absent after `--omit=optional` or a tolerated optional-install failure). | Run the `npm install …` command the error itself prints. |
| CB-E013 | `--backend` was given a value other than `file`, `arweave`, `turbo`, `rclone`, `ton`, or `ton-provider`. | Correct the typo — only those six are valid. |
| CB-E014 | `schedule status`/`uninstall` ran before `schedule install`, or writing the crontab entry failed. | Run `cypher-brain schedule install` first; a crontab-write failure usually means missing cron permissions/availability in this environment. |
| CB-E015 | `restore`/`verify` can't find the private identity file it needs to decrypt (default or `--identity` path). | Run `cypher-brain keygen` if you haven't yet, or point `--identity` at the correct file. |
| CB-E016 | `restore`/`verify` found a `*.minisig` signature next to the ciphertext, and a configured signing public key, but the signature did NOT verify — the artifact may be tampered or forged. | Do not trust the artifact. Confirm you're checking against the correct `sign-recipient.pub` (or `--sign-recipient`); if it matches and the failure persists, treat the ciphertext as compromised and re-fetch from a trusted copy. |
| CB-E017 | `schedule status` read `schedule.json` and it either isn't valid JSON (truncated write, disk full mid-write, hand edit) or is missing a field `status` needs (a partially-written or older-schema file). | Re-run `cypher-brain schedule install` to regenerate a valid `schedule.json`. |
| CB-E018 | `pull`/`verify` looked for an object at a locator (or `push --backend rclone --remote <name>:<path>`'s pre-upload check) and nothing is there — either it was never pushed, or the locator/remote path is wrong (`file`/`rclone` backends only; #539 for rclone, which used to pass rclone's own raw, 3x-repeated "directory not found" retry-loop text straight through instead). | Double-check the locator/`--remote` value against what `push` actually printed (or the `--save-locator` file), and confirm something was really pushed there. |
| CB-E019 | `wallet address`/`wallet balance` (CLI or MCP `wallet_address`), or `push --backend arweave`/`turbo`, was given a `--wallet`/`wallet` path (or the default `CYPHER_BRAIN_AR_WALLET`) and no JWK file exists there (#600: `push` used to report this as the generic CB-E011 ENOENT instead). | Run `cypher-brain wallet create` first, or point `--wallet`/`wallet`/`CYPHER_BRAIN_AR_WALLET` at the correct path. |
| CB-E020 | `snapshot`'s `--recipient`/MCP `snapshot_now`'s `recipients` named something that is neither an `age1...` pubkey nor an existing file of pubkeys (same condition the recovery kit checks for its own recorded recipient). | Run `cypher-brain keygen` first, or pass an `age1...` pubkey / a valid recipients file. |
| CB-E021 | `restore`'s `--out-dir`/MCP `restore_now`'s `out_dir` already exists as a plain file (or other non-directory) rather than a directory. | Point `--out-dir`/`out_dir` at a path that is either absent or already a directory. |
| CB-E022 | `snapshot --sign-identity <path>` was given a path that doesn't exist. | Point `--sign-identity` at an existing signing private key (`cypher-brain keygen` writes one to the default path), or drop the flag to use the default. |
| CB-E023 | `restore`/`verify --sign-recipient <path>` was given a path that doesn't exist. | Point `--sign-recipient` at an existing signing public key, or drop the flag to use the default. |

## What's proven vs recommended

| Area | Status |
|---|---|
| Backup-key recovery (any one identity restores), versioning round-trip | **proven** — `selftest:recovery` (CI) |
| Restore extraction hardening (`restore` inspects every tar entry — absolute paths, `..` traversal, FIFO/device/socket, an escaping hardlink target, a path-traversal-through-symlink shape — and refuses the whole archive before extracting a byte; extraction itself lands in an isolated scratch directory, only promoted into `--out-dir` once fully vetted and complete — #218, defense-in-depth alongside #198's manifest.json path-traversal guard) | **proven** — `selftest:restore-security` (CI; malicious archives rejected, legitimate symlink/hardlink shapes `snapshot()` itself produces still restore) |
| `file` backend store/fetch | **proven** — `selftest:storage` (CI) |
| `arweave` backend round-trip | **proven** — `selftest:arweave` (CI, against arlocal); real-network gateway pull confirmed operator-run |
| `turbo` backend (ETH/USDC bundler upload) | **proven** — operator-run real round-trip (#20) |
| `rclone` backend (delegates to the `rclone` binary and its own configured remote) | **proven** — `selftest:rclone` (CI) |
| `ton` backend orchestration (seeder-side bag creation over ssh/scp, idempotent re-push, P2P-path pull, loud fallback + `CYPHER_BRAIN_TON_NO_FALLBACK` fail-close — against a mock daemon + PATH-shimmed ssh/scp; the REAL TON network is deliberately out of CI scope) | **proven** — `selftest:ton` (CI); real-network round-trip is operator-run |
| `ton-provider` backend orchestration (StorageV1 contract deploy, Tonkeeper deeplink signing or local-wallet auto-signing, provider selection + ADNL/RLDP notify via `scripts/go/storage-v1-client`, full-download wait — against a mock provider/mock chain; the REAL TON network is deliberately out of CI scope) | **proven** — `selftest:ton-provider` (CI); mainnet deploy→discovery→fetch→proof-reward round-trip is operator-run (issue #396) |
| `publish-latest` (opt-in `.ton` DNS publication of the latest ton bag id — availability probe, tonapi domain resolution, `change_dns_record` body build, Tonkeeper deeplink, `--wait` resolve poll — against a mock seeder + mock tonapi.io; never signs, and never part of the nightly) | **proven** — `selftest:ton-dns` (CI); real tonapi.io + Tonkeeper approval is operator-run |
| Identity at rest (passphrase-wrap via `keygen --passphrase`; FDE on the identity host) | **available / recommended** — `--passphrase` ships; FDE is operator config, not enforced by code |
| Post-quantum hybrid keypair (`keygen --pq`, ML-KEM-768 + X25519 — mitigates harvest-now-decrypt-later, see README Threat model) | **available** — `selftest:pq` (CI); combines with a plain-X25519 backup key and `CYPHER_BRAIN_PIN_RECIPIENTS`, but the recipient/ciphertext are much bigger than plain X25519 |
| Authenticity signing (`keygen --sign`, a minisign-compatible Ed25519 detached signature over each `*.age` — mitigates age's lack of authenticity, see README Threat model #214) | **available** — `selftest:minisign` (CI, in-process round trip always; real `minisign` binary interop when it's on PATH); optional and additive — an unsigned artifact restores exactly as before |
| Nightly cadence (`schedule install / status / uninstall`: generated runner + launchd/cron trigger, paid backends refused without a spend cap, end-to-end run of the generated runner) | **proven** — `selftest:schedule` (CI) |
| Identity off-box backup, Shamir M-of-N | **recommended practice / future** — not enforced by code |
