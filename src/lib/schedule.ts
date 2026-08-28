// schedule — make the nightly snapshot+push unattended (issue #69, part of #60).
//
// `schedule install` turns the MANAGEMENT.md "Cadence" recipe into two generated
// artifacts instead of a hand-rolled script:
//   1. a runner (nightly.sh) under the schedule dir — the snapshot+push pipeline
//      composed from the SAME flags snapshot/push take, with dated output names,
//      --save-locator, an index.tsv append, and (paid backends only) the
//      CYPHER_BRAIN_YES=1 + CYPHER_BRAIN_MAX_SPEND spend-guard lines;
//   2. the platform trigger — macOS: a launchd plist in ~/Library/LaunchAgents;
//      Linux: a crontab entry tagged `# cypher-brain-nightly` so uninstall can
//      remove exactly its own line.
//
// Every generated file is DETERMINISTIC for a given set of inputs (no embedded
// timestamps) — dates appear only where the RUNNER computes them at run time.
// The runner logs each run to <schedule>/logs/nightly-YYYY-MM-DD.log and always
// leaves a final "OK rc=0 warnings=N" / "FAILED rc=N warnings=N" line (warnings=N
// added by #432 — the count of ⚠-class warnings, e.g. a single-recipient snapshot,
// that run recorded into the SAME log), so `schedule status` can tail the newest
// log for the outcome — but that is a PULL: nothing surfaces a run
// that silently stopped happening at all (launchd/cron itself wedged, the box
// was off). --ping-url (issue #202) adds the PUSH half: a healthchecks.io-style
// dead man's switch the runner curl's on every run's outcome (success URL /
// `${url}/fail` on failure, both best-effort — see the EXIT trap in
// runnerBody()), so an unattended schedule that stops running gets noticed
// even if nobody ever runs `schedule status`.
//
// Testability: CYPHER_BRAIN_SCHEDULE_DIR overrides the schedule dir and
// CYPHER_BRAIN_LAUNCHD_DIR the plist dir, and --no-load writes the artifacts
// without touching launchctl/crontab — so the selftest never registers anything
// on the machine that runs it.

import { mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { join, resolve, dirname, basename } from 'node:path';
import {
  HOME,
  SCHEDULE_DIR,
  LAUNCHD_DIR,
  CONFIG_FILE,
  readEnv,
  type EnvName,
  TON_PROVIDER_MAX_SPEND,
  TON_PROVIDER_NOTIFY_BIN,
} from './config.js';
import {
  SCAN_SECRETS_INSTALL_HINT,
  SCAN_SECRETS_MODES,
  isScanSecretsMode,
  type ScanSecretsMode,
} from './secrets-scan.js';
import { exists } from './util.js';
import { printJson } from './ui.js';
import { assertExportRequiresO2bProfile, assertKnownProfile } from './profiles.js';
import { tonWalletConfigured } from './wallet.js';
import { didYouMean, nearestName } from './suggest.js';
import type { CliOptions } from './types.js';

// LABEL/CRON_MARKER are scoped to CYPHER_BRAIN_HOME (#114) so a second `install` under a
// DIFFERENT CYPHER_BRAIN_HOME never overwrites or unregisters the first's launchd job /
// crontab line — both LABEL (and therefore PLIST's filename) and CRON_MARKER used to be
// fixed, machine-wide constants, so two brains on the same machine collided. The hash is
// derived from HOME alone (not the rest of the config), so it stays the SAME across
// reinstalls of the same home with different flags.
const HOME_LABEL_HASH = createHash('sha256').update(HOME).digest('hex').slice(0, 8);
const LABEL = `dev.cypher-brain.nightly.${HOME_LABEL_HASH}`;
const CRON_MARKER = `# cypher-brain-nightly:${HOME_LABEL_HASH}`; // idempotent uninstall: remove exactly the lines that carry this tag
// Earlier installs registered under other values: pre-#114 the FIXED, unscoped
// `dev.cipher-brain.nightly` / `# cipher-brain-nightly` (shared machine-wide, by every
// home), and before the cipher-brain -> cypher-brain rename the scoped
// `dev.cipher-brain.nightly.<hash>` / `# cipher-brain-nightly:<hash>` (whose hash also
// changes when the default home dir moved). Rather than enumerate each scheme, install/
// status/uninstall read the registration THIS home's own artifacts recorded (schedule.json's
// trigger.path / cron.entry — see legacyLaunchd/legacyCronEntry below) and treat any that
// is not the current one as legacy to migrate. Never a blind machine-wide sweep, so it can
// never touch a DIFFERENT home's still-legacy job.

const RUNNER = join(SCHEDULE_DIR, 'nightly.sh');
const CONFIG = join(SCHEDULE_DIR, 'schedule.json');
const LOGS_DIR = join(SCHEDULE_DIR, 'logs');
const SNAPS_DIR = join(SCHEDULE_DIR, 'snapshots');
const PLIST = join(LAUNCHD_DIR, `${LABEL}.plist`);
const CRON_ENTRY_FILE = join(SCHEDULE_DIR, 'cron.entry'); // Linux: the exact registered line, kept as an artifact for status/uninstall

// rclone and the self-hosted `ton` backend stay excluded from unattended scheduling —
// both need operator-side setup (--remote / a configured seeder box) a launchd/cron job
// can't collect. `ton-provider` used to be excluded too, for the separate reason that
// every deploy needed a HUMAN to sign a Tonkeeper deeplink mid-push, something an
// unattended run has no way to wait for. PR2 (issue #396) added a local TON wallet
// (wallet.ts's `wallet create --chain ton`) that lets put() auto-sign instead — so this
// is now computed FRESH at each `schedule install` call (not a frozen module constant:
// unlike mcp.ts's long-running server process, install() is a one-shot CLI invocation,
// so there is no "stale until restart" tradeoff to accept) via the exact same
// presence-check arweave/turbo's own wallet already uses. `install` bakes whatever is
// in effect AT INSTALL TIME into the generated runner (see the file's own header) — a
// wallet created afterward needs a re-`install` to be picked up by the nightly runner,
// same as any other setting.
async function scheduleableBackends(): Promise<Set<string>> {
  return new Set(['file', 'arweave', 'turbo', ...((await tonWalletConfigured()) ? ['ton-provider'] : [])]);
}
const PAID = new Set(['arweave', 'turbo']);

// Every CYPHER_BRAIN_* var a snapshot+push run could need that this runner does NOT
// already bake unconditionally or separately (see the comment above envLines' loop
// in runnerBody for the full exclusion list).
const ENV_CAPTURE_VARS: readonly EnvName[] = [
  'CYPHER_BRAIN_FILE_DIR',
  'CYPHER_BRAIN_PG_BIN',
  // #307: resolved to an ABSOLUTE path by install when --scan-secrets is used, so the
  // nightly executes the very scanner install reported — not whatever a bare launchd/cron
  // PATH resolves the name "gitleaks" to, which need not be the same binary.
  'CYPHER_BRAIN_GITLEAKS_BIN',
  'CYPHER_BRAIN_PIN_RECIPIENTS',
  'CYPHER_BRAIN_AR_HOST',
  'CYPHER_BRAIN_AR_PORT',
  'CYPHER_BRAIN_AR_PROTOCOL',
  'CYPHER_BRAIN_AR_WALLET',
  'CYPHER_BRAIN_AR_PAID_BY',
  'CYPHER_BRAIN_AR_HTTP_TIMEOUT',
  'CYPHER_BRAIN_AR_L1_MAX',
  // The USD rate endpoint is read on the PUSH path, not just by `estimate`: arweave's
  // put() and turbo both call arUsdRate() for the approximate-USD line next to the
  // native-unit cost. Dropping it would not break the push (arUsdRate returns null on
  // any failure, and the spend cap is in native units) but WOULD make the unattended
  // run egress to the default payment.ardrive.io that the operator configured away
  // from (#276). CYPHER_BRAIN_AR_GATEWAY/AR_GATEWAYS stay out on purpose: arGateways()
  // is reached only from arweave's get(), and this runner only snapshots and pushes.
  'CYPHER_BRAIN_AR_USD_RATE_URL',
  'CYPHER_BRAIN_PIPE_TIMEOUT',
  // ton-provider (#396 PR2): install() below REQUIRES CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND
  // and CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN to be set before allowing this backend to be
  // scheduled — but requiring them at install time is worthless if they are not ALSO
  // captured here, since the runner's own environment is otherwise bare. Without this
  // list entry every scheduled push would fail nightly with the exact "must be set"
  // errors install() exists to catch up front (Codex review, xhigh pass).
  'CYPHER_BRAIN_TON_WALLET',
  'CYPHER_BRAIN_TON_PROVIDER_OWNER',
  'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND',
  'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN',
  'CYPHER_BRAIN_TON_PROVIDER_MYTONPROVIDER_URL',
  'CYPHER_BRAIN_TON_BIN',
  'CYPHER_BRAIN_TON_NETWORK_CONFIG',
  'CYPHER_BRAIN_TON_TONAPI_URL',
];

// Of ENV_CAPTURE_VARS, the ones config.ts documents as naming a filesystem path (a
// directory or a specific key/JWK file) rather than a bare value (a backend name, a
// timeout, a spend cap, a hostname/URL/address). A relative value here resolves fine
// at install time (against the operator's interactive cwd), but launchd/cron invoke
// the runner from a DIFFERENT, unrelated cwd — so bake the ABSOLUTE path in, same
// treatment already given to --vault/--zip/--recipient(file) below.
const PATH_ENV_VARS = new Set([
  'CYPHER_BRAIN_FILE_DIR', // config.ts: "file backend object store"
  'CYPHER_BRAIN_PG_BIN', // config.ts: "dir holding pg_dump/pg_restore"
  'CYPHER_BRAIN_AR_WALLET', // config.ts: "path to a JWK key file"
  'CYPHER_BRAIN_TON_WALLET', // wallet.ts: "path to a local TON wallet mnemonic file" (#396 PR2)
  'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN', // config.ts: "path to a locally-built scripts/go/storage-v1-client binary"
  'CYPHER_BRAIN_TON_NETWORK_CONFIG', // config.ts: "path to a TON global config JSON for testnet"
]);

// Vars that may hold EITHER a path or a bare value, so resolve() must be conditional on
// the value naming something that exists — an unconditional resolve() would turn a bare
// binary name ("gitleaks") or an inline recipient list into a bogus cwd-relative path.
const MAYBE_PATH_ENV_VARS = new Set([
  'CYPHER_BRAIN_PIN_RECIPIENTS', // a recipients FILE or an inline age1... list
  'CYPHER_BRAIN_GITLEAKS_BIN', // a binary PATH or a bare name resolved via PATH (#307)
  'CYPHER_BRAIN_TON_BIN', // config.ts: "local binary for the ephemeral P2P download daemon" — a PATH or a bare name resolved via PATH, same shape as gitleaks
]);

// Snapshot + resolve, at install time, every ENV_CAPTURE_VARS value that is actually set —
// so the runner bakes in absolute paths, not values relative to whatever cwd the operator
// happened to run `schedule install` from.
async function captureEnv(): Promise<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const v of ENV_CAPTURE_VARS) {
    // readEnv, not process.env: a value the operator still sets under the legacy
    // CIPHER_BRAIN_* spelling is captured too, and baked under the canonical name.
    const raw = readEnv(v);
    // `undefined` (genuinely unset) is the ONLY case worth dropping. An explicitly EMPTY
    // value is baked in verbatim, because the two are not interchangeable: config.ts
    // deliberately keeps CYPHER_BRAIN_PIN_RECIPIENTS='' distinct from unset so snapshot()
    // can fail CLOSED on it (#101 — a broken cron/systemd template that renders an empty
    // pin must not silently disable the recipient allowlist). A falsy `!raw` guard here
    // collapsed those two cases, so `schedule install` run with an empty pin generated a
    // runner carrying no pin at all — and since that runner exports
    // CYPHER_BRAIN_NO_CONFIG_FILE=1 (#286), $CYPHER_BRAIN_HOME/config.env could not put it
    // back either: the interactive path failed closed while the unattended one ran with no
    // allowlist. Baking '' verbatim keeps snapshot() the single place that decides what an
    // empty pin means, and makes the scheduled run hit that very same check.
    if (raw === undefined) continue;
    if (raw === '') {
      // Nothing to resolve — resolve('') returns the install-time cwd, which would invent a
      // path where the operator supplied none.
      //
      // Baking '' is deliberately NOT special-cased to the pin: every OTHER name in
      // ENV_CAPTURE_VARS is consumed in config.ts as `readEnv(...) || <default>`, so an
      // empty export is already run-time identical to no export at all for them, and
      // keeping the rule uniform means the next variable whose empty value MEANS something
      // is handled correctly by default rather than re-introducing #101's collapse. A new
      // variable added here that distinguishes '' from unset at run time inherits that
      // distinction — check its config.ts fallback if it must not.
      captured[v] = '';
    } else if (MAYBE_PATH_ENV_VARS.has(v)) {
      // File-first, exactly like keys.ts's resolvePinnedRecipients: if the value names
      // an existing file, it's a path — resolve it. Otherwise it's an inline age1... list,
      // a bare binary name to be found on PATH, or a not-yet-existing path — in every one
      // of those cases resolve() would only mangle it, so leave it untouched.
      captured[v] = (await exists(raw)) ? resolve(raw) : raw;
    } else if (PATH_ENV_VARS.has(v)) {
      captured[v] = resolve(raw);
    } else {
      captured[v] = raw;
    }
  }
  return captured;
}

// POSIX single-quote an arbitrary string for embedding in the generated script.
const shq = (s: unknown): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

const parseAt = (at: string): { hour: number; minute: number } => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!m) throw new Error(`--at must be HH:MM (24h), got: ${at}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
};

function sh(cmd: string, args: string[], { input }: { input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { encoding: 'utf8', input });
}

// ---------- generated artifact bodies (deterministic) ----------

// The resolved, install-time configuration every generated artifact (runner script,
// launchd plist, cron line) is rendered from — and what schedule.json persists so
// `status`/`uninstall` can read it back later.
interface ScheduleConfig {
  schema: number;
  at: string;
  hour: number;
  minute: number;
  backend: string;
  profile?: string;
  vault?: string;
  zip?: string;
  export?: string; // profile o2b: resolved absolute path, same reasoning as vault/zip below (issue #206)
  force_vault?: boolean;
  pg?: string;
  tables: string[];
  pg_filter?: string; // resolved absolute path, same reasoning as vault/zip below (issue #235)
  pg_exclude_table_data?: string[];
  dirs: string[];
  recipients: string[];
  // --scan-secrets warn|deny|off (#215/#307/#301): threaded into the generated snapshot command
  // line, NOT into the env block — it is a flag snapshot takes, not one of the
  // CYPHER_BRAIN_* settings ENV_CAPTURE_VARS bakes. Absent = no scan (unchanged
  // pre-#307 runner, byte for byte).
  scan_secrets?: ScanSecretsMode;
  save_locator: string;
  index_file: string;
  max_spend?: string;
  home: string;
  schedule_dir: string;
  logs_dir: string;
  runner: string;
  node: string;
  cli: string;
  trigger: { type: 'launchd'; path: string } | { type: 'cron'; entry_file: string };
  env: Record<string, string>;
  tmpdir: string | null;
  // Dead man's switch (issue #202): a healthchecks.io-style URL the runner curl's on
  // success; ping_url_fail (default: `${ping_url}/fail`, healthchecks.io's own convention)
  // is hit on failure instead. Both are best-effort — see the trap in runnerBody, which
  // never lets a curl failure change the run's own OK/FAILED outcome.
  ping_url?: string;
  ping_url_fail?: string;
}

function runnerBody(cfg: ScheduleConfig): string {
  const cb = `${shq(cfg.node)} ${shq(cfg.cli)}`;
  // Environment the trigger will NOT have (launchd/cron start with a bare env):
  // bake the values that were in effect at install time so the unattended run
  // resolves the same keys/stores the operator tested with.
  const envLines = [
    `export CYPHER_BRAIN_HOME=${shq(cfg.home)}`,
    // #286: everything this runner needs was baked in at install time, below. Tell
    // the CLI not to read $CYPHER_BRAIN_HOME/config.env as well — without this, each
    // scheduled invocation would re-read it, so editing that file could retune an
    // already-installed schedule, or (with an unknown key in it) stop the schedule
    // outright. `schedule install` exists to pin what the operator tested.
    'export CYPHER_BRAIN_NO_CONFIG_FILE=1',
  ];
  // Users with large brains are expected to set TMPDIR so snapshot() (mkdtempSync) stages
  // plaintext on a disk with enough room — bake it in too, or a scheduled run silently
  // falls back to the system temp dir even though install was run with TMPDIR set.
  if (cfg.tmpdir) envLines.push(`export TMPDIR=${shq(cfg.tmpdir)}`);
  // (--scan-secrets' scanner is pinned through CYPHER_BRAIN_GITLEAKS_BIN, which install
  // resolves to an absolute path and the ENV_CAPTURE_VARS loop below bakes in like any
  // other setting — see install(). Nothing extra to emit here.)
  // Every CYPHER_BRAIN_* var src/lib/config.ts reads that a snapshot+push run could need,
  // EXCEPT: CYPHER_BRAIN_HOME (baked above unconditionally), CYPHER_BRAIN_YES/MAX_SPEND
  // (baked separately below, only for paid backends), CYPHER_BRAIN_AGE/AGE_KEYGEN
  // (deprecated — age is bundled in-process now), and CYPHER_BRAIN_PASSPHRASE (only read
  // by the decrypt path — restore/verify/pull's decrypt-proof — which the nightly runner
  // never exercises; it only encrypts). launchd/cron start with a BARE env, so anything
  // here that was set at install time and is silently dropped makes a scheduled run of a
  // non-default backend (turbo/a custom arweave gateway) fail or fall back to the
  // WRONG default compared to the interactive setup the operator actually tested.
  // cfg.env was already resolved to absolute paths (where applicable) at install time by
  // captureEnv() — do NOT re-read process.env here (launchd/cron's bare env has none of
  // this anyway; the whole point is to bake in what install time saw).
  for (const [v, val] of Object.entries(cfg.env)) {
    envLines.push(`export ${v}=${shq(val)}`);
  }
  const spendLines: string[] = [];
  if (PAID.has(cfg.backend)) {
    spendLines.push(
      `# ${cfg.backend} is a paid, PERMANENT store. CYPHER_BRAIN_YES=1 grants the unattended`,
      `# upload consent that an interactive run gives with --yes; CYPHER_BRAIN_MAX_SPEND caps`,
      `# each upload in the native unit of the backend (winc for turbo, winston for arweave L1)`,
      `# and aborts the push when the cost estimate exceeds it. REVIEW this cap.`,
      `export CYPHER_BRAIN_YES=1`,
      `export CYPHER_BRAIN_MAX_SPEND=${cfg.max_spend}`,
    );
    if (!readEnv('CYPHER_BRAIN_AR_WALLET')) {
      spendLines.push(
        `# export CYPHER_BRAIN_AR_WALLET="$HOME/.cypher-brain/wallet.json"   # JWK signer — required to push via ${cfg.backend}`,
      );
    }
  }
  // Dead man's switch pings (issue #202): only emitted when --ping-url was given at
  // install time. PING_URL/PING_URL_FAIL are plain shell variables (not exported — the
  // runner's own trap is the only reader) set BEFORE the trap so the trap's single-quoted
  // command body can reference them by name; bash re-parses a trap's command string at
  // fire time (not at `trap ...` set time), so $PING_URL there resolves to whatever this
  // script set it to earlier, not to an empty/unset value.
  const pingLines = cfg.ping_url ? [`PING_URL=${shq(cfg.ping_url)}`, `PING_URL_FAIL=${shq(cfg.ping_url_fail)}`] : [];
  const pingOkCmd = cfg.ping_url ? 'curl -fsS -m 10 "$PING_URL" >/dev/null 2>&1 || true; ' : '';
  const pingFailCmd = cfg.ping_url ? 'curl -fsS -m 10 "$PING_URL_FAIL" >/dev/null 2>&1 || true; ' : '';
  const snapshotArgs: string[] = [];
  if (cfg.profile) snapshotArgs.push('--profile', shq(cfg.profile));
  if (cfg.vault) snapshotArgs.push('--vault', shq(cfg.vault));
  if (cfg.zip) snapshotArgs.push('--zip', shq(cfg.zip));
  if (cfg.export) snapshotArgs.push('--export', shq(cfg.export));
  if (cfg.force_vault) snapshotArgs.push('--force-vault');
  if (cfg.pg) snapshotArgs.push('--pg', shq(cfg.pg));
  for (const t of cfg.tables) snapshotArgs.push('--pg-table', shq(t));
  if (cfg.pg_filter) snapshotArgs.push('--pg-filter', shq(cfg.pg_filter));
  for (const t of cfg.pg_exclude_table_data ?? []) snapshotArgs.push('--pg-exclude-table-data', shq(t));
  for (const d of cfg.dirs) snapshotArgs.push('--dir', shq(d));
  for (const r of cfg.recipients) snapshotArgs.push('--recipient', shq(r));
  // #307: the whole point of this issue — an unattended nightly is the run nobody is
  // watching, so it is the one that most needs the gate. Before this, `schedule install
  // --scan-secrets deny` exited 0 and generated a runner that never scanned.
  if (cfg.scan_secrets) snapshotArgs.push('--scan-secrets', shq(cfg.scan_secrets));
  return `#!/usr/bin/env bash
# nightly.sh — generated by \`cypher-brain schedule install\`. Do NOT edit in place:
# re-run install to change anything (this file is overwritten). If cypher-brain or
# node moves, re-run install so the absolute paths below stay valid.
# One unattended run of the snapshot+push pipeline (MANAGEMENT.md "Cadence").
set -euo pipefail

SCHEDULE_DIR=${shq(cfg.schedule_dir)}
LOG_DIR="$SCHEDULE_DIR/logs"
SNAP_DIR="$SCHEDULE_DIR/snapshots"
mkdir -p "$LOG_DIR" "$SNAP_DIR"
LOG="$LOG_DIR/nightly-$(date +%F).log"
# #432: a same-day retry APPENDS to this same dated LOG (see the retry-safe --out
# naming below) — record how many lines already exist BEFORE this run's own output
# lands, so the warning count computed in the trap below can be scoped to what THIS
# invocation wrote, not the whole day's cumulative log (which would double-count an
# earlier run's warnings against a later, clean retry's rc line). The [ -f ] check
# (rather than \`wc -l < "$LOG" 2>/dev/null || echo 0\`) matters on the FIRST run of a
# new day: redirecting FROM a not-yet-existing file is a shell-level open() failure
# that bash reports on ITS OWN stderr before wc even runs — a 2>/dev/null attached to
# wc cannot suppress it, and at this point in the script exec hasn't redirected into
# "$LOG" yet, so that spurious "No such file or directory" would leak to whatever
# invoked this runner instead of landing in the log like everything else here does.
if [ -f "$LOG" ]; then LOG_START_LINES=$(wc -l < "$LOG"); else LOG_START_LINES=0; fi
# Known limitation (Codex review): LOG_START_LINES is a snapshot taken once, up front.
# It scopes the count correctly against SEQUENTIAL same-day retries (the scenario the
# retry-safe --out naming above exists for — "a manual test on install day, or a
# legitimate retry after a transient failure"), but two invocations of THIS SAME
# runner that are genuinely CONCURRENT (both appending to the same dated LOG at once)
# can each mis-attribute the other's warnings — this script has no locking around the
# log, matching every other append into LOG here (the same hazard already applies to
# the plain human-readable interleaving of two runs' output). Not addressed: it would
# require real mutual exclusion (flock is not available on macOS by default), a much
# bigger change than this warnings=N surfacing fix, for a scenario the existing
# same-day retry-safety comments never claimed to cover.
exec >>"$LOG" 2>&1
${pingLines.length ? `${pingLines.join('\n')}\n` : ''}
# Every run ends with a machine-readable status line a heartbeat monitor can tail:
# "OK rc=0 warnings=N" on success, "FAILED rc=N warnings=N" on any failure (set -e
# exits at the first error). warnings=N (#432) is the total count of ⚠-class
# warnings (warn.ts's chokepoint — see cli.ts's printWarningSummary) that snapshot
# and/or push above recorded and printed into THIS SAME log via
# \`exec >>"$LOG" 2>&1\` above, e.g. "snapshot encrypted to a SINGLE recipient key —
# ... UNRECOVERABLE". Before this, that warning existed only as prose a human had to
# think to \`cat\` the dated log to find; scheduleStatusReport()'s last_run.warning_count
# reads this back structurally so \`schedule status\`/\`doctor\` can surface it instead of
# a silent OK/PASS. Counted by tailing ONLY the lines THIS run appended (from
# LOG_START_LINES on — see above) for warn.ts's formatWarningSummary() header line,
# matched end-to-end and end-of-line-anchored on its EXACT fixed text ("N warning(s) a
# human should see (an agent relaying this run: show these verbatim):" — the whole
# distinctive phrase including its parenthetical, not just "N warning", and anchored so
# it must be the WHOLE tail of the line) so arbitrary logged prose — e.g. a secret-scan
# finding echoing matched file content into this same log — cannot coincidentally, or
# by a maliciously crafted file in the snapshotted source, inflate the count — rather
# than threading a counter through snapshot/push's separate node invocations — grep
# matches the leading count of each such header (there is one per subcommand that
# recorded warnings) and sums them (formatWarningSummary is exported specifically so
# this exact text stays pinned by tests).
${
  cfg.ping_url
    ? `# This install also configured --ping-url (issue #202): the SAME trap pushes a dead
# man's switch ping — PING_URL on success, PING_URL_FAIL on any failure — a best-effort
# curl (10s timeout, "|| true") that can never turn a successful/failed run into the
# other, nor mask the run's own outcome if the ping itself fails (no network
# reachability, the monitor being down, etc.).
`
    : ''
}trap 'rc=$?; wcnt=0; if [ -f "$LOG" ]; then for n in $(tail -n +"$((LOG_START_LINES + 1))" "$LOG" 2>/dev/null | grep -oE "^⚠  run summary — [0-9]+ warning\\(s\\) a human should see \\(an agent relaying this run: show these verbatim\\):$" | grep -oE "[0-9]+"); do wcnt=$((wcnt + n)); done; fi; if [ "$rc" -eq 0 ]; then echo "OK rc=0 warnings=$wcnt"; ${pingOkCmd}else echo "FAILED rc=$rc warnings=$wcnt"; ${pingFailCmd}fi' EXIT

${envLines.join('\n')}
${spendLines.length ? `${spendLines.join('\n')}\n` : ''}
echo "== cypher-brain nightly run start: $(date -u +%FT%TZ) =="
# Retry-safe naming: snapshot.ts refuses to overwrite an existing --out (by design —
# see src/lib/snapshot.ts), so a name keyed on the date ALONE collides the moment this
# runner is invoked twice on the same day (a manual test on install day, or a legitimate
# retry after a transient failure). Key on date+time-of-day instead, and disambiguate
# with a numeric suffix in the rare case two invocations land in the same second — this
# loop guarantees every invocation gets its own --out, so a same-day re-run never wedges
# the next (cron/launchd-triggered) run.
STAMP="$(date +%Y%m%dT%H%M%S)"
OUT="$SNAP_DIR/brain-$STAMP.age"
n=1
while [ -e "$OUT" ]; do
  n=$((n + 1))
  OUT="$SNAP_DIR/brain-$STAMP-$n.age"
done
${cb} snapshot ${snapshotArgs.join(' ')} --out "$OUT"
LOC=$(${cb} push --in "$OUT" --backend ${shq(cfg.backend)} --skip-unchanged --save-locator ${shq(cfg.save_locator)})
# The (possibly paid, possibly SKIPPED) push above already succeeded — create the index
# file's parent dir NOW, before appending, so a --index-file under a not-yet-existing
# directory can't turn a successful push into a FAILED run (which would invite a naive
# retry to re-upload and pay again for the same snapshot).
mkdir -p ${shq(dirname(cfg.index_file))}
# Read the SHA256 back from the save-locator file's 3rd field rather than re-hashing
# "$OUT": on a --skip-unchanged SKIP, $LOC is the PREVIOUS run's locator while $OUT is
# THIS run's freshly re-encrypted (age's ephemeral file key differs every run) and
# never-uploaded ciphertext — hashing $OUT would pair $LOC with a hash it will never
# actually produce, breaking any later \`pull --locator ... --sha256 ...\` check against
# this index row (MANAGEMENT.md "Cadence"). The save-locator file's 3rd field already
# holds the correct hash for whatever $LOC points to (push writes it on every real push,
# and leaves it — still correct — untouched on a skip).
SHA=$(cut -f3 ${shq(cfg.save_locator)})
printf '%s\\t%s\\t%s\\n' "$(date -u +%FT%TZ)" "$LOC" "$SHA" >> ${shq(cfg.index_file)}
echo "pushed -> ${cfg.backend}:$LOC"
`;
}

function plistBody(cfg: ScheduleConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xmlEscape(cfg.runner)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${cfg.hour}</integer>
    <key>Minute</key><integer>${cfg.minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(cfg.logs_dir)}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${xmlEscape(cfg.logs_dir)}/launchd.err.log</string>
</dict>
</plist>
`;
}

const cronLine = (cfg: ScheduleConfig): string =>
  `${cfg.minute} ${cfg.hour} * * * /bin/bash "${cfg.runner}" ${CRON_MARKER}`;

// Escape a string for embedding as PLIST XML text content (e.g. inside <string>…</string>).
// & must go first, or the entities the other replacements introduce would themselves be
// re-escaped. Without this, a path containing any of these characters (plausible in a
// $HOME or username, e.g. "O'Brien & Co") produces invalid XML that `launchctl bootstrap`
// rejects even though the runner itself was generated fine.
const xmlEscape = (s: unknown): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// ---------- trigger registration ----------

function loadLaunchd(): void {
  const uid = process.getuid?.();
  sh('launchctl', ['bootout', `gui/${uid}/${LABEL}`]); // clear a prior registration; failure = was not loaded, fine
  const r = sh('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
  if (r.error || r.status !== 0) {
    throw new Error(
      `launchctl bootstrap failed: ${(r.stderr || '').trim() || r.error?.message || `exit ${r.status}`} — artifacts are written; retry with: launchctl bootstrap gui/${uid} ${PLIST}`,
    );
  }
}

function crontabText(): string {
  const r = sh('crontab', ['-l']);
  if (r.error) throw new Error(`crontab not available: ${r.error.message}`);
  return r.status === 0 ? r.stdout : ''; // non-zero = no crontab for this user yet
}

function loadCron(entry: string): void {
  const kept = crontabText()
    .split('\n')
    .filter((l) => l.trim() && !l.includes(CRON_MARKER));
  const next = `${[...kept, entry].join('\n')}\n`;
  const r = sh('crontab', ['-'], { input: next });
  if (r.error || r.status !== 0)
    throw new Error(`crontab write failed: ${(r.stderr || '').trim() || r.error?.message || `exit ${r.status}`}`);
}

// Resolve pg_dump's directory the SAME way config.ts's PG_BIN is consumed (a directory
// holding pg_dump/pg_restore, joined with the tool name — see config.ts pgTool()), NOT
// the pg_dump binary path itself. `command -v` is a POSIX shell builtin (portable across
// macOS/Linux, unlike the `which` binary which isn't guaranteed present), run via `sh -c`
// so it resolves against THIS process's current PATH — the same env `schedule install`
// is running in.
function resolvePgDumpDir(): string | null {
  const r = sh('sh', ['-c', 'command -v pg_dump']);
  const found = r.status === 0 ? r.stdout.trim() : '';
  return found ? dirname(resolve(found)) : null;
}

// Same idea for gitleaks (#307), except the BINARY itself is what gets baked, not its
// directory: config.ts's GITLEAKS_BIN takes a full path, so pinning it means the nightly
// executes the exact scanner install resolved and reported. Appending its directory to
// the runner's PATH instead would only make it reachable — a different `gitleaks` earlier
// on the scheduler's PATH would still win, which multi-model review demonstrated can turn
// a `deny` runner into one that pushes (a stub reporting no findings shadowed the real
// binary). Resolved against the interactive PATH, which is what the operator just tested.
//
// `nameOrPath` is whatever CYPHER_BRAIN_GITLEAKS_BIN says, or plain "gitleaks" when it
// says nothing. An EXPLICIT value is resolved and validated too, not trusted as-is
//: a bare name there is exactly as unusable to launchd/cron as the
// default is, and a path that does not exist is worse — install would exit 0 having
// promised a gate the nightly can never run. `command -v` answers for both shapes and
// only echoes a path back when it is executable, so one call validates and absolutises.
function resolveGitleaksBin(nameOrPath: string): string | null {
  const r = sh('sh', ['-c', 'command -v "$1"', 'sh', nameOrPath]);
  const found = r.status === 0 ? r.stdout.trim() : '';
  return found ? resolve(found) : null;
}

// ---------- legacy (earlier LABEL/CRON_MARKER scheme) detection ----------

// Ownership gate for everything below. schedule.json / cron.entry live under SCHEDULE_DIR,
// which is overridable, so a directory reused across two homes would otherwise let one home
// unregister the OTHER's trigger (multi-model review). A recorded registration is only this
// home's when the home it recorded is the same directory as HOME — compared as real paths,
// so a ~/.cipher-brain left behind as a symlink to ~/.cypher-brain (the rename's own
// migration) still counts as the same home. `home` has been recorded since #81, i.e. by
// every registration any of the legacy paths here could meet.
function sameHome(recorded: string | undefined): boolean {
  if (!recorded) return false;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(recorded) === real(HOME);
}

// The launchd registration THIS home's own schedule.json (as last written by `install`)
// recorded, when it is not the current PLIST — i.e. this home's job was registered under an
// earlier scheme (pre-#114 unscoped, or the cipher-brain-era label), not just "some old
// plist happens to exist" (which could belong to a different home entirely). The label is
// what launchd knows the job as: the plist's basename. `sameLabel` is the one case where
// only the plist MOVED (LAUNCHD_DIR changed, home unchanged): launchd already knows that
// label, install re-registers it from the new PLIST, so the stale file is removed but the
// label must NOT be booted out — that would unload the job just loaded.
function legacyLaunchd(cfg: ScheduleConfig | null): { label: string; plist: string; sameLabel: boolean } | null {
  if (cfg?.trigger.type !== 'launchd' || cfg.trigger.path === PLIST || !sameHome(cfg.home)) return null;
  const label = basename(cfg.trigger.path, '.plist');
  return { label, plist: cfg.trigger.path, sameLabel: label === LABEL };
}

// THIS home's own recorded cron line (cron.entry — the exact line install last registered),
// when its marker is not the current CRON_MARKER — i.e. registered under an earlier scheme.
// Only that EXACT line is ever matched (not "every line ending in the marker"): the pre-#114
// marker was shared machine-wide, so a suffix match could take a different home's entry with
// it. Null when there is no prior entry, it is not this home's, or it is already current.
function legacyCronEntry(priorEntry: string | null, cfg: ScheduleConfig | null): string | null {
  if (!priorEntry || !sameHome(cfg?.home)) return null;
  const i = priorEntry.lastIndexOf(' # ');
  if (i < 0) return null;
  const marker = priorEntry.slice(i + 1).trimEnd();
  return marker === CRON_MARKER ? null : priorEntry.trimEnd();
}
const isLegacyCronLine = (l: string, entry: string): boolean => l.trimEnd() === entry;
const cronMarkerOf = (entry: string): string => entry.slice(entry.lastIndexOf(' # ') + 1);

// This home's own schedule.json — read WITHOUT throwing (returns null if absent/corrupt),
// for the legacy-migration checks below, which must never treat "no prior config" as an
// error.
async function tryReadConfig(): Promise<ScheduleConfig | null> {
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8')) as ScheduleConfig;
  } catch {
    return null;
  }
}

// This home's own cron.entry artifact — the EXACT line `install` last registered (whatever
// LABEL/marker scheme was in effect when it ran), used to tell whether THIS home's cron job
// is legacy-format without having to re-derive it from schedule.json.
async function readOwnCronEntry(): Promise<string | null> {
  try {
    const t = (await readFile(CRON_ENTRY_FILE, 'utf8')).trim();
    return t || null;
  } catch {
    return null;
  }
}

// ---------- subcommands ----------

// ---------- install() helpers ----------
//
// #508: install() used to be a single ~365-line function reading top to bottom as (1)
// input validation, (2) environment probing/resolution (pg_dump, gitleaks paths), (3)
// building the resolved ScheduleConfig, (4) writing the runner/plist/cron/config
// artifacts + registering the launchd/cron trigger + migrating off a legacy
// label/marker scheme, (5) printing the operational summary. Unlike wizard.ts's
// interactive flow, none of that needs to be interleaved with user I/O — it is pure
// sequential data transformation + file writes, so it is split into one function per
// concern below. Every helper is called from install() in EXACTLY the original order,
// with EXACTLY the original side effects (throws, console.error lines, process.env /
// `o` mutations) — this is a pure refactor, not a behavior change. Two params
// (`backend`, `effectiveScan`) are threaded through explicitly rather than re-read off
// `o` in every helper: TypeScript's narrowing of `o.backend`/`o.scan_secrets` (established
// by the `if (!o.backend) throw` guard and the `isScanSecretsMode` check below) does not
// survive a function-call boundary, so passing the already-validated values is what keeps
// this compiling with the exact same runtime guarantees the single function had.

// ---------- (1) input validation ----------
// The `--backend` presence check itself stays in install(), BEFORE scheduleableBackends()
// is even called (see install() below) — scheduleableBackends() does a filesystem check
// (does a TON wallet exist), and the original single function never paid for that when
// `--backend` was missing outright (Codex review: reordering it after would have made a
// plain usage error do extra I/O it never did before). `backend` is therefore guaranteed
// non-empty by the time this runs; only its MEMBERSHIP in `backends` still needs checking
// here. Returns the validated backend name (narrowed from CliOptions' `backend?: string`)
// so every helper below can take a plain `string` instead of re-deriving it from `o`.
function validateInstallInputs(o: CliOptions, backends: Set<string>): string {
  const backend = o.backend as string;
  if (!backends.has(backend)) {
    // #434: ton-provider IS a recognized, documented backend name — it's just
    // excluded from `backends` above until a TON wallet is configured. Routing
    // that case through the generic "unknown backend" message below reads as if
    // the name itself were wrong, which misleads a user who already ran `wallet
    // create --chain ton` but forgot to export the env var that makes it visible
    // here. Name it specifically instead; every OTHER rejected name (rclone/ton,
    // which are real but intentionally never scheduleable, or a genuine typo)
    // still falls through to the generic message unchanged.
    if (backend === 'ton-provider') {
      throw new Error("ton-provider requires CYPHER_BRAIN_TON_WALLET=<path> — see 'wallet create --chain ton'");
    }
    throw new Error(`unknown backend: ${backend} (expected one of ${[...backends].join('|')})`);
  }
  // #461: install() never calls resolveProfilePaths() itself (it only reaches profiles.ts
  // through the --export/o2b check just below) — so a misspelled --profile used to sail
  // straight through to the runner/plist/cron writes below, baking `snapshot --profile
  // '<typo>'` into a nightly that would fail from the very first unattended run, silently,
  // since nobody watches those logs. Same "flag accepted, never honored" bug class
  // assertExportRequiresO2bProfile() (right below) already refuses for --export — refuse
  // here too, before anything is written, and using the exact same check `snapshot
  // --profile <typo>` fails fast with (see profiles.ts's assertKnownProfile()).
  assertKnownProfile(o.profile);
  // #206/multi-model review: install() bakes cfg.export into the runner's snapshot line
  // unconditionally (below) — it never calls resolveProfilePaths() itself, so an --export
  // given without --profile o2b would install cleanly and only turn out to be a no-op
  // every night, unattended, once the runner actually calls snapshot() (see
  // profiles.ts's assertExportRequiresO2bProfile doc comment for the full bug class).
  assertExportRequiresO2bProfile(o);
  if (!o.pg && o.dirs.length === 0 && !o.profile) {
    throw new Error('nothing to snapshot: pass --profile <name>, --pg <conn> and/or --dir <path>');
  }
  // --scan-secrets (#307): validate the MODE here, before anything is written and before
  // the environment probes below. snapshot() validates it too, but only when the runner
  // finally runs — hours later, unattended, in a log nobody is reading. `schedule install
  // --scan-secrets bogus` must not exit 0 and bake a nightly that fails every night, and
  // whether the request is coherent at all must not depend on what happens to be
  // installed on this host.
  if (o.scan_secrets !== undefined) {
    if (!isScanSecretsMode(o.scan_secrets)) {
      throw new Error(
        `--scan-secrets must be ${SCAN_SECRETS_MODES.join(' or ')} (got ${JSON.stringify(o.scan_secrets)})`,
      );
    }
    // Same "nothing to scan" refusal snapshot() makes (see its --scan-secrets block): the
    // gate covers --dir/--profile staged plaintext, so a --pg-only schedule would report
    // scanning in `schedule status` while every nightly scanned zero components. Refused
    // HERE too, rather than left to fail once a night, unattended, in a log nobody reads.
    // `off` asks for NO scan, so nothing about a source-less schedule is wrong for it —
    // refusing here would leave a --pg-only schedule unable to record the opt-out at all,
    // while `snapshot --scan-secrets off` accepts it (multi-model review finding: the two
    // surfaces must not disagree about what a mode means).
    if (o.scan_secrets !== 'off' && o.dirs.length === 0 && !o.profile) {
      throw new Error(
        `--scan-secrets ${o.scan_secrets} has nothing to scan: it covers --dir/--profile staged plaintext, and this ` +
          `schedule has no --dir or --profile source (a --pg dump is not scanned). Add the source you meant to gate, ` +
          `or drop --scan-secrets — refusing rather than installing a nightly that reports a scan of no component.`,
      );
    }
  }
  return backend;
}

// ---------- (2) environment probing/resolution (pg_dump, gitleaks paths) ----------
// Also finishes resolving --scan-secrets to its EFFECTIVE mode (#301) — inseparable from
// the gitleaks resolution just below (the default depends on whether gitleaks is
// resolvable at all). Mutates `o.scan_secrets` exactly as the original single function
// did: the MCP schedule_install result reads the RESOLVED mode back off the SAME options
// object after install() returns, not the caller's original input (see mcp.ts).
function resolveScheduleEnv(o: CliOptions): { gitleaksBin: string | null; effectiveScan: ScanSecretsMode | undefined } {
  // launchd/cron start with a BARE env — they do NOT inherit the interactive shell's PATH,
  // so a --pg snapshot that resolves pg_dump via PATH interactively (the common Homebrew /
  // Postgres.app setup) would find pg_dump right now but fail every scheduled run. Resolve
  // a default HERE, in the same env this install command is running in, and bake it in
  // (same mechanism as every other CYPHER_BRAIN_* var above) instead of requiring the user
  // to already know to set CYPHER_BRAIN_PG_BIN. An explicit CYPHER_BRAIN_PG_BIN is left
  // untouched (respected as-is by the envLines loop in runnerBody).
  if (o.pg && !readEnv('CYPHER_BRAIN_PG_BIN')) {
    const dir = resolvePgDumpDir();
    if (!dir) {
      throw new Error(
        `--pg requires pg_dump for the unattended run — could not resolve it (command -v pg_dump found nothing on PATH); install the postgresql client tools or pass CYPHER_BRAIN_PG_BIN=<dir containing pg_dump/pg_restore>`,
      );
    }
    // A WRITE, not a read: the resolved dir is put back into the environment so
    // captureEnv() below bakes it into the runner like any other setting. readEnv()
    // (#286) is read-only by design, so this stays a direct assignment.
    process.env.CYPHER_BRAIN_PG_BIN = dir;
    console.error(
      `resolved pg_dump -> ${join(dir, 'pg_dump')} (baked into the runner as CYPHER_BRAIN_PG_BIN — launchd/cron do not inherit PATH)`,
    );
  }
  // The environment half of --scan-secrets, kept with the other probes (pg_dump above)
  // rather than with the validation: resolve gitleaks NOW so the exact binary can be
  // baked in. Same motivation as --pg resolving pg_dump above — the runner's bare
  // launchd/cron PATH would not find a Homebrew-installed gitleaks, so an install that
  // looked fine would produce a nightly that fails on every run. Refusing here is the
  // same fail-closed posture assertGitleaksAvailable() takes at run time: never a
  // warning, never a silently unscanned schedule.
  //
  // Unlike the --pg branch, an EXPLICIT CYPHER_BRAIN_GITLEAKS_BIN is validated rather
  // than passed through: `CYPHER_BRAIN_GITLEAKS_BIN=gitleaks` is a
  // perfectly reasonable interactive setting and a useless baked one, and a stale
  // absolute path in it is worse still — install would exit 0 promising a gate that can
  // never run. Whatever it says is resolved through the same check the default gets.
  //
  // #301 made the scan default to `warn` when gitleaks is resolvable, and that default is
  // resolved HERE rather than left to the runner. A nightly that re-derives its own default
  // at 03:30, from a bare launchd/cron PATH, would decide whether to scan based on what
  // happens to be installed months later — the exact class of runner-depends-on-PATH
  // failure #307 closed. So the effective mode is computed once, now, and baked in
  // explicitly; `off` is baked too, so "this schedule does not scan" is a recorded decision
  // rather than the absence of one.
  // validateInstallInputs() already confirmed this is undefined or a valid
  // ScanSecretsMode before install() ever calls this function — TS narrowing does not
  // cross that function-call boundary, so this cast just restates what was already
  // checked (a no-op at runtime, same value either way).
  let effectiveScan: ScanSecretsMode | undefined = o.scan_secrets as ScanSecretsMode | undefined;
  if (effectiveScan === undefined) {
    const hasScannableSource = o.dirs.length > 0 || !!o.profile;
    effectiveScan =
      hasScannableSource && resolveGitleaksBin(readEnv('CYPHER_BRAIN_GITLEAKS_BIN') || 'gitleaks') ? 'warn' : 'off';
  }
  let gitleaksBin: string | null = null;
  if (effectiveScan !== 'off') {
    const configured = readEnv('CYPHER_BRAIN_GITLEAKS_BIN') || 'gitleaks';
    gitleaksBin = resolveGitleaksBin(configured);
    if (!gitleaksBin) {
      throw new Error(
        configured === 'gitleaks'
          ? SCAN_SECRETS_INSTALL_HINT
          : `CYPHER_BRAIN_GITLEAKS_BIN=${configured} could not be resolved to an executable — refusing to install a ` +
              `schedule whose nightly scan can never run. ${SCAN_SECRETS_INSTALL_HINT}`,
      );
    }
    console.error(
      `resolved gitleaks -> ${gitleaksBin} (baked into the runner as CYPHER_BRAIN_GITLEAKS_BIN — launchd/cron do not inherit PATH, and a different gitleaks on theirs must not silently take its place)`,
    );
    if (o.scan_secrets === undefined)
      console.error(
        `secret scan: --scan-secrets defaults to ${effectiveScan} and is baked into the runner — reinstall with --scan-secrets deny to refuse a leaking nightly, or --scan-secrets off to skip the scan`,
      );
  } else if (o.scan_secrets === undefined) {
    console.error(
      `secret scan: OFF for this schedule (no gitleaks resolvable here${o.dirs.length === 0 && !o.profile ? ', and no --dir/--profile source to scan' : ''}) — baked in as such so the nightly cannot start scanning, or stop, because of what lands on PATH later`,
    );
  }
  // Same write-back snapshot() does: callers that report the outcome (the MCP
  // schedule_install result) must not echo an omitted input as "no scan" when install just
  // resolved and baked one.
  o.scan_secrets = effectiveScan;
  return { gitleaksBin, effectiveScan };
}

// ---------- (1b) spend-cap + --ping-url-fail validation ----------
// Runs AFTER resolveScheduleEnv() in install() (same order the original single function
// checked these in) and takes the already-validated `backend` rather than `o.backend`
// for the same narrowing reason validateInstallInputs() returns it (see the file-level
// comment above).
function validateSpendCaps(o: CliOptions, backend: string): void {
  // The one thing this feature must never create: unattended spending without a cap.
  // A paid backend gets CYPHER_BRAIN_YES=1 baked into the runner, so a spend cap is
  // MANDATORY here — refuse to install rather than schedule an uncapped nightly upload.
  if (PAID.has(backend)) {
    if (!o.max_spend) {
      throw new Error(
        `--backend ${backend} is a paid store: --max-spend <n> is required for an unattended schedule (native units: winc for turbo, winston for arweave L1) — the runner gets CYPHER_BRAIN_YES=1, so it must also get a spend cap`,
      );
    }
    if (!/^\d+$/.test(String(o.max_spend)) || BigInt(o.max_spend) <= 0n) {
      throw new Error(`--max-spend must be a positive integer (native units), got: ${o.max_spend}`);
    }
  } else if (o.max_spend) {
    throw new Error(
      `--max-spend only applies to arweave/turbo (native units: winc/winston); --backend ${backend} either is free ` +
        'or (ton-provider) uses its own CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (nanoTON) instead — see below',
    );
  }
  // ton-provider (#396 PR2) has its OWN spend-cap variable — CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND
  // (nanoTON), a different variable and unit from --max-spend/PAID above (winc/winston) — so
  // it gets a parallel, separate required-config check rather than being folded into PAID
  // (which would wrongly imply --max-spend is the right knob for it, and break the "free
  // backend" branch's error message above). scheduleableBackends() already guarantees
  // CYPHER_BRAIN_TON_WALLET is configured by the time backend==='ton-provider' reaches here
  // (that Set only ever contains 'ton-provider' when tonWalletConfigured() is true) — this
  // additionally requires the deploy spend cap AND the notify binary, the other two things
  // put() itself throws on if missing, so a scheduled install fails now with actionable
  // guidance instead of every night at push time (Codex review, xhigh pass: the original cut
  // of this PR made ton-provider "schedule install"-eligible without ALSO requiring or
  // carrying forward what a nightly run actually needs to succeed).
  if (backend === 'ton-provider') {
    if (TON_PROVIDER_MAX_SPEND <= 0n) {
      throw new Error(
        'ton-provider is a paid store: CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (nanoTON) must be set in the ' +
          'environment before install — a StorageV1 deploy spends real funds, so there is no safe default ' +
          'to let an unattended schedule run uncapped through',
      );
    }
    if (!TON_PROVIDER_NOTIFY_BIN) {
      throw new Error(
        'ton-provider requires CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN (a locally built ' +
          'scripts/go/storage-v1-client binary) set in the environment before install — otherwise every ' +
          'scheduled push would fail at the notify step',
      );
    }
  }
  // --ping-url-fail (issue #202) only makes sense as an override of the success URL's
  // implied /fail sibling — refuse it standalone rather than silently pinging a failure
  // URL that was never paired with a configured success URL.
  if (o.ping_url_fail && !o.ping_url) {
    throw new Error('--ping-url-fail requires --ping-url (the success URL) to also be set');
  }
}

// ---------- (3) building the resolved ScheduleConfig ----------
async function buildScheduleConfig(
  o: CliOptions,
  args: {
    backend: string;
    at: string;
    hour: number;
    minute: number;
    gitleaksBin: string | null;
    effectiveScan: ScanSecretsMode | undefined;
  },
): Promise<ScheduleConfig> {
  const { backend, at, hour, minute, gitleaksBin, effectiveScan } = args;
  // The resolved scanner is layered ON TOP of the captured environment rather than being
  // written back into process.env the way the --pg branch does with CYPHER_BRAIN_PG_BIN.
  // In the CLI the two are equivalent (one process, one install), but the MCP server is
  // long-lived: a process.env left mutated by one schedule_install call would still be
  // there for the next one, which would then read a stale absolute path as if the
  // operator had configured it. Nothing outside this call sees it.
  const capturedEnv = await captureEnv();
  if (gitleaksBin) capturedEnv.CYPHER_BRAIN_GITLEAKS_BIN = gitleaksBin;

  return {
    schema: 1,
    at,
    hour,
    minute,
    backend,
    ...(o.profile ? { profile: o.profile } : {}),
    // --vault/--zip are always filesystem paths (a directory / a zip file) — resolve
    // NOW, against the cwd `schedule install` is run from, exactly like --dir below.
    // launchd/cron invoke the generated runner from a DIFFERENT (often unrelated) cwd,
    // so a relative string baked in verbatim would resolve to a different file (or
    // nothing) at scheduled-run time even though it worked interactively at install time.
    ...(o.vault ? { vault: resolve(o.vault) } : {}),
    ...(o.zip ? { zip: resolve(o.zip) } : {}),
    ...(o.export ? { export: resolve(o.export) } : {}),
    ...(o.force_vault ? { force_vault: true } : {}),
    ...(o.pg ? { pg: o.pg } : {}),
    tables: o.tables,
    // --pg-filter is always a filesystem path (a filter file) — resolve NOW, against the
    // cwd `schedule install` is run from, same reasoning as --vault/--zip above: launchd/cron
    // invoke the generated runner from a different cwd, so a relative path baked in verbatim
    // would resolve to a different file (or nothing) at scheduled-run time.
    ...(o.pg_filter ? { pg_filter: resolve(o.pg_filter) } : {}),
    ...(o.pg_exclude_table_data?.length ? { pg_exclude_table_data: o.pg_exclude_table_data } : {}),
    dirs: o.dirs.map((d) => resolve(d)),
    // --recipient is EITHER an inline age1... public key (leave verbatim — it is not a
    // path) OR a path to a recipients file (resolve it, same reasoning as --vault/--zip
    // above: it must still name the same file when the runner is invoked from a
    // different cwd by launchd/cron).
    recipients: o.recipients.map((r) => (r.startsWith('age1') ? r : resolve(r))),
    // Validated, and (since #301) resolved to an effective mode above whether or not the
    // flag was passed — always recorded, so the runner never re-derives a default from
    // whatever PATH it inherits at 03:30 and `schedule status` reports a decision that was
    // actually made rather than an absence.
    scan_secrets: effectiveScan,
    save_locator: resolve(o.save_locator || join(HOME, 'latest-locator.tsv')),
    index_file: resolve(o.index_file || join(SCHEDULE_DIR, 'index.tsv')),
    ...(o.max_spend ? { max_spend: String(o.max_spend) } : {}),
    home: HOME,
    schedule_dir: SCHEDULE_DIR,
    logs_dir: LOGS_DIR,
    runner: RUNNER,
    node: process.execPath,
    cli: resolve(process.argv[1]),
    trigger:
      process.platform === 'darwin' ? { type: 'launchd', path: PLIST } : { type: 'cron', entry_file: CRON_ENTRY_FILE },
    // Same reasoning as --vault/--zip/--dir/--recipient above, applied to the ambient
    // CYPHER_BRAIN_* env vars and TMPDIR: snapshot this process's env NOW (resolving any
    // relative path-valued vars to absolute) so the runner still resolves the same
    // files/dirs when launchd/cron invoke it later from a different cwd and bare env.
    env: capturedEnv,
    tmpdir: process.env.TMPDIR ? resolve(process.env.TMPDIR) : null,
    // Dead man's switch (issue #202): --ping-url is a bare value (a URL, not a path) —
    // nothing to resolve() against cwd, unlike --vault/--zip/--recipient above. When only
    // --ping-url is given, ping_url_fail defaults to the healthchecks.io convention of
    // appending "/fail" to the success URL — a plain, deliberately unparsed string
    // concatenation (multi-model review flagged this: a --ping-url with a query string
    // or a trailing slash produces a "/fail" appended after the query string, or a
    // double slash, respectively). healthchecks.io-style URLs are bare paths with no
    // query/fragment in practice, so this is left as-is rather than adding URL parsing —
    // pass --ping-url-fail explicitly to override the default for any URL shape where
    // the naive append isn't what you want.
    ...(o.ping_url ? { ping_url: o.ping_url, ping_url_fail: o.ping_url_fail || `${o.ping_url}/fail` } : {}),
  };
}

// ---------- (4) writing the runner/plist/cron/config artifacts ----------
async function writeScheduleArtifacts(cfg: ScheduleConfig): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });
  await mkdir(SNAPS_DIR, { recursive: true });
  await writeFile(RUNNER, runnerBody(cfg));
  await chmod(RUNNER, 0o755);
  console.error(`runner written -> ${RUNNER}`);

  if (cfg.trigger.type === 'launchd') {
    await mkdir(LAUNCHD_DIR, { recursive: true });
    await writeFile(PLIST, plistBody(cfg));
    console.error(`launchd plist written -> ${PLIST}`);
  } else {
    await writeFile(CRON_ENTRY_FILE, `${cronLine(cfg)}\n`);
    console.error(`cron entry written -> ${CRON_ENTRY_FILE}`);
  }
  await writeFile(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
}

// ---------- (4b) launchd/cron trigger registration + legacy-scheme migration ----------
async function registerTrigger(
  cfg: ScheduleConfig,
  priorCfg: ScheduleConfig | null,
  priorCronEntry: string | null,
  noLoad: boolean | undefined,
): Promise<void> {
  if (noLoad) {
    if (cfg.trigger.type === 'launchd') {
      console.error(
        `--no-load: trigger NOT registered (launchctl untouched) — but ${PLIST} is a REAL, PERSISTENT file that was just written. Its default location (~/Library/LaunchAgents) is a real system dir, NOT scoped to CYPHER_BRAIN_HOME (override with CYPHER_BRAIN_LAUNCHD_DIR to sandbox a --no-load preview). Remove it by hand, or with \`cypher-brain schedule uninstall\`, if you do not intend to \`launchctl load\` it or re-run install without --no-load.`,
      );
    } else {
      console.error('--no-load: cron entry written, trigger NOT registered (crontab untouched)');
    }
    if (legacyLaunchd(priorCfg) || legacyCronEntry(priorCronEntry, priorCfg)) {
      console.error(
        `note: a legacy (earlier label/marker scheme) registration for this home is still live — re-run install WITHOUT --no-load to migrate off it (otherwise both would end up running nightly)`,
      );
    }
  } else if (cfg.trigger.type === 'launchd') {
    loadLaunchd();
    console.error(`launchd job loaded: ${LABEL}`);
    const legacy = legacyLaunchd(priorCfg);
    if (legacy) {
      // sameLabel: loadLaunchd() just re-registered this very label from the new PLIST —
      // booting it out here would unload it again. Only the stale file goes.
      if (!legacy.sameLabel) sh('launchctl', ['bootout', `gui/${process.getuid?.()}/${legacy.label}`]); // failure = was not loaded, fine
      if (await exists(legacy.plist)) {
        await rm(legacy.plist);
        console.error(
          legacy.sameLabel
            ? `removed the previous plist for this label at ${legacy.plist} (LAUNCHD_DIR changed)`
            : `migrated off the legacy launchd label (${legacy.label}) — removed ${legacy.plist}`,
        );
      }
    }
  } else {
    loadCron(cronLine(cfg));
    console.error(`crontab entry registered (${CRON_MARKER})`);
    const legacyEntry = legacyCronEntry(priorCronEntry, priorCfg);
    if (legacyEntry) {
      const lines = crontabText()
        .split('\n')
        .filter((l) => l.trim());
      const kept = lines.filter((l) => !isLegacyCronLine(l, legacyEntry));
      if (kept.length !== lines.length) {
        const r = sh('crontab', ['-'], { input: kept.length ? `${kept.join('\n')}\n` : '' });
        if (r.error || r.status !== 0)
          throw new Error(
            `crontab write failed while migrating off the legacy entry: ${(r.stderr || '').trim() || r.error?.message || `exit ${r.status}`}`,
          );
        console.error(`migrated off the legacy crontab entry (${cronMarkerOf(legacyEntry)})`);
      }
    }
  }
}

// ---------- (5) operational summary ----------
function printInstallSummary(cfg: ScheduleConfig): void {
  // The write-window rationale (MANAGEMENT.md "Avoid the write window"): a run pg_dumps
  // the DB and tars the files at different instants, so it must not straddle the nightly
  // re-synthesis of the source.
  console.error(
    `scheduled daily at ${cfg.at} — run well after the source re-synthesizes overnight, so the DB and files are captured from the same settled state`,
  );
  if (PAID.has(cfg.backend)) {
    console.error(
      `review CYPHER_BRAIN_MAX_SPEND=${cfg.max_spend} in ${RUNNER} — every unattended ${cfg.backend} push is capped at that estimate (native units)`,
    );
  }
  console.error(
    `runs log to ${LOGS_DIR}/nightly-YYYY-MM-DD.log (final line: "OK rc=0 warnings=N" or "FAILED rc=N warnings=N"); check with: cypher-brain schedule status`,
  );
  if (cfg.ping_url) {
    console.error(
      `dead man's switch enabled: success -> ${cfg.ping_url}, failure -> ${cfg.ping_url_fail} (best-effort — a ping failure never changes the run's own OK/FAILED outcome)`,
    );
  }
}

// ---------- install() — orchestrates the above in the ORIGINAL sequential order ----------
async function install(o: CliOptions): Promise<void> {
  // Checked here, BEFORE scheduleableBackends() (which does a filesystem check for a TON
  // wallet) — same order the original single function had: a plain "--backend missing"
  // usage error must never pay for that extra I/O (Codex review).
  if (!o.backend) throw new Error('--backend <file|arweave|turbo|ton-provider> required');
  const backends = await scheduleableBackends();
  const backend = validateInstallInputs(o, backends);
  const { gitleaksBin, effectiveScan } = resolveScheduleEnv(o);
  const at = o.at || '03:30';
  const { hour, minute } = parseAt(at);
  validateSpendCaps(o, backend);

  // Read any PRE-EXISTING artifacts now, before anything below overwrites them — used only
  // to detect (and, unless --no-load, migrate off) a legacy pre-#114 registration for THIS
  // SAME home, so re-running install after upgrading cypher-brain doesn't leave BOTH the
  // old unscoped job and the new scoped one running nightly (#114). Read AFTER the input
  // validation above so a plain usage error (bad --backend, missing --max-spend, ...) never
  // pays for this extra I/O.
  const priorCfg = await tryReadConfig();
  const priorCronEntry = await readOwnCronEntry();

  const cfg = await buildScheduleConfig(o, { backend, at, hour, minute, gitleaksBin, effectiveScan });
  await writeScheduleArtifacts(cfg);
  await registerTrigger(cfg, priorCfg, priorCronEntry, o.no_load);
  printInstallSummary(cfg);
}

// A real, checkable (`instanceof`) marker for "nothing installed" — same pattern as
// util.ts's MissingPathError — so doctor.ts (#333 review) can tell this ONE expected
// condition apart from any other failure reading the schedule (a corrupt schedule.json,
// a crontab/launchctl call that itself errored) without matching on message text, which
// this codebase has been removing elsewhere for the same reason. The message itself is
// unchanged, so errors.ts's CB-E014 pattern (which matches on `.message`, not the
// class) still recognizes it.
export class ScheduleNotInstalledError extends Error {}

// #494: the exact fields scheduleStatusReport() (readConfig's only caller) dereferences
// off the returned config, checked up front so a partially-written/older-schema
// schedule.json that parses fine but is missing one of them surfaces as THIS clear
// message instead of a generic "Cannot read properties of undefined" deep inside that
// function. Deliberately narrower than every key ScheduleConfig declares (e.g. `tables`/
// `dirs`/`recipients`/`env` are never read by readConfig's caller) — validating fields
// nothing here uses would reject a config that `status` can perfectly well report on.
function assertScheduleConfigShape(v: unknown): asserts v is ScheduleConfig {
  const missing = (field: string) =>
    new Error(
      `schedule config is corrupt (${CONFIG} is missing required field "${field}") — reinstall with: cypher-brain schedule install`,
    );
  if (typeof v !== 'object' || v === null) {
    throw new Error(
      `schedule config is corrupt (${CONFIG} is not a JSON object) — reinstall with: cypher-brain schedule install`,
    );
  }
  const cfg = v as Record<string, unknown>;
  if (typeof cfg.at !== 'string') throw missing('at');
  if (typeof cfg.hour !== 'number') throw missing('hour');
  if (typeof cfg.minute !== 'number') throw missing('minute');
  if (typeof cfg.backend !== 'string') throw missing('backend');
  if (typeof cfg.home !== 'string') throw missing('home');
  if (typeof cfg.runner !== 'string') throw missing('runner');
  const trigger = cfg.trigger as Record<string, unknown> | undefined;
  if (typeof trigger !== 'object' || trigger === null) throw missing('trigger');
  if (trigger.type === 'launchd') {
    if (typeof trigger.path !== 'string') throw missing('trigger.path');
  } else if (trigger.type === 'cron') {
    if (typeof trigger.entry_file !== 'string') throw missing('trigger.entry_file');
  } else {
    throw missing('trigger.type');
  }
}

async function readConfig(): Promise<ScheduleConfig> {
  if (!(await exists(CONFIG))) {
    throw new ScheduleNotInstalledError(`schedule not installed (no ${CONFIG}) — run: cypher-brain schedule install`);
  }
  // Only JSON.parse() is wrapped — NOT the readFile() above it (Codex review): a
  // filesystem failure reading an EXISTING file (permission denied, a delete race between
  // the exists() check and this read) is a different problem than a malformed file, and
  // labeling it "not valid JSON" would be actively misleading. That class of failure is
  // left to propagate exactly as it did before this fix (unwrapped, whatever Node's own
  // fs error says) — only a genuine parse failure gets the structured message below.
  const raw = await readFile(CONFIG, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `schedule config is corrupt (${CONFIG} is not valid JSON: ${detail}) — reinstall with: cypher-brain schedule install`,
    );
  }
  assertScheduleConfigShape(parsed);
  return parsed;
}

async function lastLog(): Promise<{ name: string; rcLine: string; warningCount: number | null } | null> {
  let names: string[] = [];
  try {
    names = (await readdir(LOGS_DIR)).filter((n) => /^nightly-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
  } catch {
    /* logs dir absent = no runs yet */
  }
  if (names.length === 0) return null;
  const name = names[names.length - 1];
  const lines = (await readFile(join(LOGS_DIR, name), 'utf8')).split('\n').filter((l) => l.trim());
  // The runner guarantees a trailing OK/FAILED rc line per run; take the last one. The
  // trailing " warnings=N" suffix is #432 and OPTIONAL in this regex specifically so a
  // log written by an OLDER runner (pre-#432, bare "OK rc=0"/"FAILED rc=N") still
  // matches — it just carries an unknown (null, not 0) warning count below, rather than
  // falling through to the "(empty log)"/last-line fallback as if the log were corrupt.
  const rcLine =
    [...lines].reverse().find((l) => /^(OK|FAILED) rc=\d+( warnings=\d+)?$/.test(l)) ||
    lines[lines.length - 1] ||
    '(empty log)';
  // null = the rc line has no " warnings=N" suffix at all (an old-format log, or the
  // '(empty log)'/corrupt-line fallback above) — genuinely UNKNOWN, deliberately not
  // coerced to 0, so callers don't report "no warnings" for a run that predates this
  // field ever being recorded.
  const m = /warnings=(\d+)$/.exec(rcLine);
  const warningCount = m ? Number(m[1]) : null;
  return { name, rcLine, warningCount };
}

function nextRunAt(hour: number, minute: number): string {
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())} ${p(next.getHours())}:${p(next.getMinutes())}`;
}

// The legacy-migration note text, shared by the human-readable report and --json's
// trigger.legacy_note field below — one string, never re-worded twice.
const legacyLaunchdNote = (label: string) =>
  `this schedule is still registered under the legacy launchd label (${label}) from an earlier scheme (pre-CYPHER_BRAIN_HOME-scoped, or the cipher-brain name) — run \`cypher-brain schedule install\` again to migrate it to ${LABEL}`;
const legacyCronNote = (marker: string) =>
  `this schedule is still registered under the legacy crontab marker (${marker}) from an earlier scheme (pre-CYPHER_BRAIN_HOME-scoped, or the cipher-brain name) — run \`cypher-brain schedule install\` again to migrate it to ${CRON_MARKER}`;

/**
 * The schedule's state, as one object (#285).
 *
 * There used to be three shapes of this: the CLI's `--json` built it inline here, the
 * human-readable report printed its own lines, and the MCP `schedule_status` tool
 * CAPTURED those printed lines because `status()` had no return value. A resource
 * needs structured content, and adding a fourth shape would have been absurd — so all
 * of them now read this one function. The MCP tool no longer round-trips through
 * console output at all.
 */
// A type alias rather than an interface: mcp.ts hands this straight to structuredOk(),
// which takes Record<string, unknown>, and only a type alias carries the implicit index
// signature that assignment needs.
export type ScheduleStatusReport = {
  // #426: always true here — scheduleStatusReport() still THROWS ScheduleNotInstalledError
  // for the "nothing installed" case rather than returning an object with installed:false
  // (that would be a bigger change: doctor.ts's own instanceof-checked catch of that
  // exception, #333, would need reworking too). Only the CLI's `status()` catches that
  // throw and synthesizes a separate `{installed:false}` object for its OWN --json output
  // — literally the only place that ever produces installed:false, since this field is
  // otherwise unconditionally true on every object THIS function returns. Present on the
  // shared type (not bolted onto the CLI-only object) specifically so the MCP tool and the
  // cypher-brain://schedule/status resource — which both return this function's result
  // verbatim — report it too, keeping the field-for-field parity this type's own top
  // comment already promises rather than letting `installed` become a CLI-only bolt-on
  // (Codex review).
  readonly installed: true;
  readonly configured: {
    readonly at: string;
    readonly backend: string;
    /**
     * #307: the gitleaks mode CONFIGURED into this schedule's runner at install time, or
     * null when it does not scan. Reported because "is my unattended nightly gated?" is
     * otherwise only answerable by reading the generated shell script.
     *
     * It is the configured intent, NOT a health check: this says the runner passes
     * `--scan-secrets <mode>`, not that gitleaks is still resolvable from wherever the
     * runner will look for it tonight. That stays fail-closed at run
     * time — a gitleaks that has since disappeared makes the run FAIL rather than skip the
     * scan — so the honest reading is "configured", which is how the printed line words
     * it. Surfacing scanner health as well would mean a new field on this shared object
     * (CLI --json, the MCP tool AND the resource all serve it), so it is left out here.
     */
    readonly scan_secrets: ScanSecretsMode | null;
  };
  readonly runner: string;
  /** #286: which config file supplied settings, if any — names only, never values. */
  readonly config_file: { readonly path: string; readonly variables: string[] } | null;
  readonly ping: { readonly url: string; readonly fail_url?: string } | null;
  readonly trigger: {
    readonly type: 'launchd' | 'cron';
    readonly path?: string;
    readonly entry?: string;
    readonly loaded: 'yes' | 'no' | 'unknown';
    readonly legacy: boolean;
    readonly legacy_note?: string;
  };
  readonly last_run: {
    readonly log: string;
    readonly rc_line: string;
    /**
     * #432: the total ⚠-class warnings (warn.ts's chokepoint, e.g. a single-recipient
     * "UNRECOVERABLE" snapshot) that this run recorded, read back from rc_line's
     * "warnings=N" suffix — structured, so callers don't have to re-parse the log's
     * prose. `0` means the run genuinely recorded none. `null` means UNKNOWN, not
     * zero: this log was written by a runner from before #432 (bare "OK rc=0"/"FAILED
     * rc=N", no suffix at all), so nothing here can vouch for whether that run had
     * warnings or not.
     */
    readonly warning_count: number | null;
  } | null;
  readonly next_run: string;
};

/**
 * Read the installed schedule's state. Throws the usual "schedule not installed"
 * error (CB-E014) when there is none — every caller wants that surfaced, not
 * swallowed into an empty report.
 */
export async function scheduleStatusReport(): Promise<ScheduleStatusReport> {
  const cfg = await readConfig();

  let triggerPath: string | undefined;
  let triggerEntry: string | undefined;
  let loadedYesNo: 'yes' | 'no' | 'unknown';
  let legacy: boolean;
  let legacyNote: string | undefined;

  if (cfg.trigger.type === 'launchd') {
    // A legacy (pre-#114) schedule.json literally stored the unscoped plist path — trust
    // THAT ground truth over re-deriving from the current (scoped) LABEL constant, so a
    // legacy job that IS actually loaded is reported as loaded, not wrongly "no".
    const prior = legacyLaunchd(cfg);
    legacy = !!prior;
    const label = prior ? prior.label : LABEL;
    const r = sh('launchctl', ['print', `gui/${process.getuid?.()}/${label}`]);
    loadedYesNo = !r.error && r.status === 0 ? 'yes' : 'no';
    triggerPath = cfg.trigger.path;
    if (prior) legacyNote = legacyLaunchdNote(prior.label);
  } else {
    // Same reasoning as the launchd branch: read back the EXACT line install last wrote
    // (whatever marker scheme was in effect then) instead of re-deriving one from the
    // current cfg + the current (scoped) CRON_MARKER constant, which would misreport a
    // still-legacy registration as unregistered.
    const entryLine = (await readOwnCronEntry()) ?? cronLine(cfg);
    const legacyEntry = legacyCronEntry(entryLine, cfg);
    legacy = !!legacyEntry;
    const needle = legacyEntry ?? CRON_MARKER;
    loadedYesNo = 'unknown';
    const r = sh('crontab', ['-l']);
    if (!r.error) loadedYesNo = r.status === 0 && r.stdout.includes(needle) ? 'yes' : 'no';
    triggerEntry = entryLine;
    if (legacyEntry) legacyNote = legacyCronNote(cronMarkerOf(legacyEntry));
  }
  const last = await lastLog();

  return {
    installed: true,
    configured: { at: cfg.at, backend: cfg.backend, scan_secrets: cfg.scan_secrets ?? null },
    runner: cfg.runner,
    // #286: the config file is loaded SILENTLY by config.ts — deliberately, so it does
    // not add a line to every command. This is where it becomes visible, because a
    // file can change which wallet, gateway or spend cap a run uses and "why is it
    // behaving differently" has to be answerable somewhere. Names only: a value could
    // be a passphrase.
    config_file: CONFIG_FILE ? { path: CONFIG_FILE.path, variables: [...CONFIG_FILE.variables] } : null,
    ping: cfg.ping_url ? { url: cfg.ping_url, fail_url: cfg.ping_url_fail } : null,
    trigger: {
      type: cfg.trigger.type,
      ...(triggerPath !== undefined ? { path: triggerPath } : {}),
      ...(triggerEntry !== undefined ? { entry: triggerEntry } : {}),
      loaded: loadedYesNo,
      legacy,
      ...(legacyNote !== undefined ? { legacy_note: legacyNote } : {}),
    },
    last_run: last ? { log: last.name, rc_line: last.rcLine, warning_count: last.warningCount } : null,
    next_run: nextRunAt(cfg.hour, cfg.minute),
  };
}

async function status(o: CliOptions): Promise<void> {
  // #426: "not installed" is an OPTIONAL, expected state — schedule install is opt-in,
  // exactly the same fact doctor.ts's checkSchedule() already treats as [SKIP] rather
  // than a failure (see its own ScheduleNotInstalledError catch, same reasoning). A
  // plain STATUS query (as opposed to an action that requires a schedule to exist)
  // reporting nonzero for "nothing is configured yet" was inconsistent with that
  // precedent, and made scripting harder than it needed to be: a caller wanting to
  // branch on "is a schedule installed?" had to catch/parse a CB-E014 error instead of
  // reading a field. `schedule uninstall`'s "nothing to remove" already exits 0 for the
  // same underlying fact — this brings status in line with it. Any OTHER failure
  // reading the schedule (corrupt schedule.json, a crontab/launchctl call that itself
  // errored) is a real problem with an EXISTING setup, not "nothing installed", and
  // must still propagate as an error — only this one specific, checkable exception
  // class is downgraded.
  let r: ScheduleStatusReport;
  try {
    r = await scheduleStatusReport();
  } catch (e) {
    if (!(e instanceof ScheduleNotInstalledError)) throw e;
    if (o.json) {
      printJson({ installed: false });
    } else {
      console.log("schedule: not installed — run 'cypher-brain schedule install' to automate nightly snapshots");
    }
    return;
  }

  if (o.json) {
    // --json (#211): the SAME object the MCP tool and the cypher-brain://schedule/status
    // resource serve — never a re-implementation, so the three can never disagree. `r`
    // already carries `installed: true` (part of ScheduleStatusReport itself, #426), so a
    // --json consumer can branch on that ONE field regardless of which shape it got back,
    // instead of having to know in advance that a bare `{"installed": false}` (this
    // function's own catch above, the only place that ever produces it) is the OTHER
    // possible response shape.
    printJson(r);
    return;
  }

  console.log(`configured: daily at ${r.configured.at}, backend ${r.configured.backend}`);
  console.log(`runner: ${r.runner}`);
  // "configured", deliberately, not "enabled": this reads schedule.json, so it reports what
  // the runner was built to pass, not that gitleaks is still resolvable tonight. Claiming
  // the latter from a file read would be the same kind of unearned assurance #307 is about
  //. The run itself stays fail-closed either way, which is what the
  // parenthetical tells the reader.
  console.log(
    r.configured.scan_secrets && r.configured.scan_secrets !== 'off'
      ? `secret scan: configured --scan-secrets ${r.configured.scan_secrets} (each run re-checks gitleaks and FAILS if it is missing — this line is the configured mode, not a health check)`
      : r.configured.scan_secrets === 'off'
        ? 'secret scan: off (re-run install with --scan-secrets warn|deny to gate this nightly)'
        : // No mode recorded at all means this schedule was installed BEFORE #301, when
          // omitting the flag left the runner with no --scan-secrets. Such a runner asks the
          // upgraded snapshot() to pick a default at run time, from the scheduler's own bare
          // PATH — the one thing baking the mode exists to prevent. Nothing here can rewrite
          // an already-installed runner, so say so instead of printing a confident "off"
          // that this status cannot actually guarantee.
          'secret scan: off, but NOT pinned — this schedule predates the baked-in mode, so its runner carries no --scan-secrets and each nightly decides from whatever PATH it inherits. Re-run `schedule install` to pin it (add --scan-secrets warn|deny|off to choose).',
  );
  console.log(
    r.config_file
      ? `config file: ${r.config_file.path} (${r.config_file.variables.length} setting(s): ${r.config_file.variables.join(', ')})`
      : 'config file: none',
  );
  console.log(r.ping ? `ping: ${r.ping.url} (fail: ${r.ping.fail_url})` : 'ping: not configured');
  if (r.trigger.type === 'launchd') {
    console.log(`trigger: launchd ${r.trigger.path} (loaded: ${r.trigger.loaded})`);
  } else {
    console.log(`trigger: cron "${r.trigger.entry}" (registered: ${r.trigger.loaded})`);
  }
  if (r.trigger.legacy_note) console.log(`note: ${r.trigger.legacy_note}`);
  console.log(r.last_run ? `last run: ${r.last_run.log} — ${r.last_run.rc_line}` : 'last run: none yet');
  // #432: the trailing rc line alone ("OK rc=0 warnings=1") is easy to skim past as a
  // plain success — call the warning out on its OWN line so it can't hide in a
  // machine-formatted status line. `null` (an old-format log from before #432 that
  // never recorded a count) gets its OWN note rather than silently being treated the
  // same as a real, counted `0` (Codex review round 3) — that would read as a clean
  // run this doctor/status genuinely cannot vouch for.
  if (r.last_run?.warning_count === null) {
    console.log(
      `(this log predates warning-count tracking, #432 — inspect ${r.last_run.log} directly for a "run summary" block if you want to be sure)`,
    );
  } else if (r.last_run?.warning_count) {
    console.log(
      `⚠  last run recorded ${r.last_run.warning_count} warning(s) a human should see — inspect ${r.last_run.log} in the schedule's logs directory (run summary block) for details`,
    );
  }
  // #433: next_run is computed purely from the configured hour/minute — it never
  // checked trigger.loaded, so a --no-load (or otherwise unregistered) schedule
  // printed a confident "next run: <time>" right below a "(loaded: no)" trigger line
  // that already said nothing will actually happen. Reword the PLAIN-TEXT line to
  // match what the trigger line above it says (rather than contradicting it) whenever
  // loaded isn't a confirmed 'yes'. 'no' and 'unknown' are NOT the same claim (Codex
  // review) — 'no' means the trigger was actually checked and is confirmed absent;
  // 'unknown' means the check itself failed (e.g. crontab errored), so it may well BE
  // registered and this code just cannot confirm it — each gets its own honest
  // wording rather than both collapsing into "is not registered". next_run itself is
  // left UNCHANGED in --json (above) — a --json consumer already has trigger.loaded to
  // cross-reference, and the computed time is still useful to know ("this is when it
  // WOULD run").
  console.log(
    r.trigger.loaded === 'yes'
      ? `next run: ${r.next_run} (local)`
      : r.trigger.loaded === 'no'
        ? `next run: none — the ${r.trigger.type} trigger is not registered (loaded: no, see above); would run at ${r.next_run} (local) if loaded`
        : `next run: unknown — the ${r.trigger.type} trigger's registration could not be confirmed (loaded: unknown, see above); would run at ${r.next_run} (local) if loaded`,
  );
}

async function uninstall(o: CliOptions): Promise<void> {
  // Legacy detection is scoped to THIS home's own recorded artifacts — never a blind
  // machine-wide launchctl/crontab sweep — so it can never touch a DIFFERENT
  // CYPHER_BRAIN_HOME's still-legacy job (see legacyLaunchd/legacyCronEntry).
  const priorCfg = await tryReadConfig();
  const priorCronEntry = await readOwnCronEntry();

  if (o.no_load) {
    // Symmetric with install's --no-load ("write/keep artifacts, do not touch
    // launchd/crontab"): --no-load here must not touch the scheduler either. UNLIKE
    // install, though, deleting the runner/config/plist/cron-entry files while the
    // trigger stays registered would orphan a live launchd/cron job pointing at a script
    // that no longer exists — it fails silently every night with nothing left to explain
    // why (#113). So --no-load is a pure status report here: nothing is removed, ever.
    const present: string[] = [];
    if (process.platform === 'darwin') {
      if (await exists(PLIST)) present.push(`launchd plist ${PLIST}`);
      const legacy = legacyLaunchd(priorCfg);
      if (legacy && (await exists(legacy.plist))) present.push(`legacy launchd plist ${legacy.plist}`);
    } else {
      if (await exists(CRON_ENTRY_FILE)) present.push(`cron entry file ${CRON_ENTRY_FILE}`);
    }
    if (await exists(RUNNER)) present.push(`runner ${RUNNER}`);
    if (await exists(CONFIG)) present.push(`config ${CONFIG}`);
    if (present.length === 0) {
      console.error('nothing to remove — schedule is not installed');
    } else {
      console.error(
        `--no-load: nothing removed — the trigger registration in launchd/crontab is still live. Re-run \`cypher-brain schedule uninstall\` WITHOUT --no-load to unregister it and remove: ${present.join(', ')}`,
      );
    }
    return;
  }

  const removed: string[] = [];
  if (process.platform === 'darwin') {
    sh('launchctl', ['bootout', `gui/${process.getuid?.()}/${LABEL}`]); // failure = was not loaded, fine
    if (await exists(PLIST)) {
      await rm(PLIST);
      removed.push(`launchd plist ${PLIST}`);
    }
    const legacy = legacyLaunchd(priorCfg);
    if (legacy) {
      // sameLabel: LABEL was booted out just above; only the stale file is left.
      if (!legacy.sameLabel) sh('launchctl', ['bootout', `gui/${process.getuid?.()}/${legacy.label}`]); // failure = was not loaded, fine
      if (await exists(legacy.plist)) {
        await rm(legacy.plist);
        removed.push(`legacy launchd plist ${legacy.plist}`);
      }
    }
  } else {
    const legacyEntry = legacyCronEntry(priorCronEntry, priorCfg);
    const lines = crontabText()
      .split('\n')
      .filter((l) => l.trim());
    const kept = lines.filter((l) => !l.includes(CRON_MARKER) && !(legacyEntry && isLegacyCronLine(l, legacyEntry)));
    if (kept.length !== lines.length) {
      const r = sh('crontab', ['-'], { input: kept.length ? `${kept.join('\n')}\n` : '' });
      if (r.error || r.status !== 0)
        throw new Error(`crontab write failed: ${(r.stderr || '').trim() || r.error?.message || `exit ${r.status}`}`);
      removed.push(
        legacyEntry
          ? `crontab entry (${CRON_MARKER} + legacy ${cronMarkerOf(legacyEntry)})`
          : `crontab entry (${CRON_MARKER})`,
      );
    }
    if (await exists(CRON_ENTRY_FILE)) {
      await rm(CRON_ENTRY_FILE);
      removed.push(`cron entry file ${CRON_ENTRY_FILE}`);
    }
  }
  for (const [p, what] of [
    [RUNNER, 'runner'],
    [CONFIG, 'config'],
  ]) {
    if (await exists(p)) {
      await rm(p);
      removed.push(`${what} ${p}`);
    }
  }
  if (removed.length === 0) {
    console.error('nothing to remove — schedule is not installed');
  } else {
    for (const r of removed) console.error(`removed: ${r}`);
    console.error(
      `kept: logs (${LOGS_DIR}), snapshots (${SNAPS_DIR}) and index.tsv — they are your data, delete manually if unwanted`,
    );
  }
}

// #435: the same "did you mean" nearestName() #425 wired into top-level commands/flags,
// reused here for schedule's OWN sub-verb — `schedule statuz` used to get only the
// generic "expected install | uninstall | status" listing, no closer than a top-level
// `cypher-brain doctro` typo used to be before #425.
const SCHEDULE_SUBCOMMANDS = ['install', 'status', 'uninstall'];

export async function schedule(o: CliOptions): Promise<void> {
  switch (o._) {
    case 'install':
      return install(o);
    case 'status':
      return status(o);
    case 'uninstall':
      return uninstall(o);
    default: {
      const suggestion = o._ ? nearestName(o._, SCHEDULE_SUBCOMMANDS) : undefined;
      throw new Error(
        `schedule: expected install | uninstall | status, got: ${o._ || '(nothing)'}${suggestion ? ` (${didYouMean(suggestion)})` : ''}`,
      );
    }
  }
}
