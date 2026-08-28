// config — env-driven paths, binaries and tunables shared by every module, plus the
// optional config file (#286) that can supply any of them.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { errMsg, warnIfLooseKeyPermsSync } from './util.js';
import { warn } from './warn.js';

// Every CYPHER_BRAIN_* name this codebase reads, declared exactly once.
//
// This list is not documentation — `readEnv()` below only accepts a name from it, so
// reading a variable that is not declared here is a TYPE ERROR. That is what lets the
// config file reject an unknown key (a `CYPHER_BRAIN_MAXSPEND` typo would otherwise be
// silently ignored, and for a spend cap that is a real loss) WITHOUT introducing a
// second list to keep in sync — the failure mode that produced #276 in the first place.
//
// Names read lazily elsewhere (crypt.ts, pushpull.ts, wizard.ts, backends/arweave.ts)
// are declared here too and reach their call sites through readEnv(), so the set stays
// complete without forcing those reads to happen at import time — several are read
// per-invocation on purpose.
const ENV_NAMES = [
  'CYPHER_BRAIN_HOME',
  'CYPHER_BRAIN_AGE', // deprecated no-op (#64), still declared so the file can name it and get the warning
  'CYPHER_BRAIN_AGE_KEYGEN', // deprecated no-op (#64)
  'CYPHER_BRAIN_PG_BIN',
  'CYPHER_BRAIN_PIN_RECIPIENTS',
  'CYPHER_BRAIN_PASSPHRASE',
  'CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE',
  'CYPHER_BRAIN_SCHEDULE_DIR',
  'CYPHER_BRAIN_LAUNCHD_DIR',
  'CYPHER_BRAIN_FILE_DIR',
  'CYPHER_BRAIN_RECEIPT_LEDGER',
  'CYPHER_BRAIN_AUDIT_LOG',
  'CYPHER_BRAIN_RCLONE_BIN',
  'CYPHER_BRAIN_GITLEAKS_BIN',
  'CYPHER_BRAIN_AR_HOST',
  'CYPHER_BRAIN_AR_PORT',
  'CYPHER_BRAIN_AR_PROTOCOL',
  'CYPHER_BRAIN_AR_WALLET',
  'CYPHER_BRAIN_AR_PAID_BY',
  'CYPHER_BRAIN_AR_GATEWAY',
  'CYPHER_BRAIN_AR_GATEWAYS',
  'CYPHER_BRAIN_AR_HTTP_TIMEOUT',
  'CYPHER_BRAIN_AR_USD_RATE_URL',
  'CYPHER_BRAIN_AR_TURBO_RATES_URL', // #343: Turbo's credit price sheet (fiat per GiB) — turbo-backend USD lines price with this, not AR spot
  'CYPHER_BRAIN_AR_BALANCE_URL',
  'CYPHER_BRAIN_AR_L1_MAX',
  'CYPHER_BRAIN_TON_SSH_HOST',
  'CYPHER_BRAIN_TON_SSH_KEY',
  'CYPHER_BRAIN_TON_REMOTE_DIR',
  'CYPHER_BRAIN_TON_REMOTE_API',
  'CYPHER_BRAIN_TON_BIN',
  'CYPHER_BRAIN_TON_HTTP_TIMEOUT',
  'CYPHER_BRAIN_TON_NO_FALLBACK',
  'CYPHER_BRAIN_TON_NETWORK_CONFIG',
  'CYPHER_BRAIN_TON_TONAPI_URL',
  'CYPHER_BRAIN_TON_PROVIDER_OWNER',
  'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND',
  'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN',
  'CYPHER_BRAIN_TON_PROVIDER_MYTONPROVIDER_URL',
  'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS', // test-only override (scripts/selftest-ton-provider.sh) — a real push waits on the 10-minute default
  'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS', // test-only override, same reason
  'CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS', // test-only override (#480) — a real deploy-confirm wait is bounded at 20 real minutes
  'CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS', // test-only override, same reason
  'CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS', // test-only override, same reason (#480 progress-line cadence)
  'CYPHER_BRAIN_TON_WALLET', // PR2: local TON wallet mnemonic file — when set, ton-provider auto-signs (no Tonkeeper deeplink) and derives `owner` from this wallet
  'CYPHER_BRAIN_YES',
  'CYPHER_BRAIN_MAX_SPEND',
  'CYPHER_BRAIN_SKIP_FUNDS_CHECK', // #342: one-run bypass of the turbo pre-upload funds check (stale balance reads)
  'CYPHER_BRAIN_PIPE_TIMEOUT',
  'CYPHER_BRAIN_PULL_RETRY_MS',
  'CYPHER_BRAIN_NO_CONFIG_FILE', // set by the generated nightly runner so a scheduled run uses only baked values (#286)
  'CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS', // #220: snapshot_now MCP idempotency-key cache lifetime
] as const;

export type EnvName = (typeof ENV_NAMES)[number];

// The project was renamed cipher-brain -> cypher-brain. Every variable keeps working
// under its old CIPHER_BRAIN_* spelling: the canonical name wins when both are set,
// otherwise the legacy one is read. Derived from the canonical list so there is still
// exactly one place a name is declared.
export const ENV_PREFIX = 'CYPHER_BRAIN_';
export const LEGACY_ENV_PREFIX = 'CIPHER_BRAIN_';
export const legacyEnvName = (name: EnvName): string => LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length);
const canonicalEnvName = (key: string): string =>
  key.startsWith(LEGACY_ENV_PREFIX) ? ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length) : key;

/**
 * Read one declared variable. The union type is the point: a name not in ENV_NAMES
 * does not compile, so the list above cannot fall behind what the code reads.
 * Deliberately NOT cached — several callers read per-invocation (tests set these
 * between calls), and freezing them here would change that behaviour.
 * `''` and `undefined` stay distinct through the fallback (PIN_RECIPIENTS relies on it):
 * an explicitly empty canonical value is returned as-is, never replaced by the legacy one.
 */
export const readEnv = (name: EnvName): string | undefined => {
  const v = process.env[name];
  return v !== undefined ? v : process.env[legacyEnvName(name)];
};

export interface LoadedConfigFile {
  readonly path: string;
  /** The CYPHER_BRAIN_* keys the file defined, for `schedule status` to report. */
  readonly variables: readonly string[];
}

// WHERE the config file lives, derived in exactly one place. Anything that needs to
// name the resolved path (loadConfigFile below, the `init` wizard's recipient-pin step)
// goes through this or through CONFIG_FILE_PATH under HOME — a second `join(home,
// 'config.env')` elsewhere would drift silently the day the filename changes: the
// loader would look at the new name while the wizard kept telling users to write the
// old one, and a file nothing reads produces no error at all. Same drift shape #276
// removed from the env-name list.
const configFileIn = (home: string): string => join(home, 'config.env');

// A refusal here is RECORDED, not thrown. This runs in a module body, before cli.ts's
// main().catch and before mcp.ts is serving, so throwing produces a raw stack trace
// instead of the `error: …` line (plus the --json error object, #270, and the CB-E code
// match) that every other failure in this tool gets. Both entry points re-throw
// CONFIG_FILE_ERROR as their first act, which puts it back on the normal path.
//
// The file lives at $CYPHER_BRAIN_HOME/config.env, which means CYPHER_BRAIN_HOME is the
// one variable it cannot set — the file would have to be read to know where it is. A
// file that names it is warned about rather than silently ignored.
//
// Precedence is Node's, not ours: `process.loadEnvFile()` leaves an already-set
// variable alone, so explicit env > file > built-in default with no logic here to get
// wrong. The file is parsed a second time (parseEnv, which only parses — it does not
// touch process.env) purely to learn which keys it declared, for validation and for
// `schedule status`.
function loadConfigFile(home: string): { file: LoadedConfigFile | null; error: Error | null } {
  const path = configFileIn(home);
  // The generated nightly runner sets this (#286): its values were baked in at install
  // time, and re-reading the file at run time would mean an edit could retune — or
  // break — an already-installed schedule, which is exactly the guarantee `schedule
  // install` exists to provide.
  if (readEnv('CYPHER_BRAIN_NO_CONFIG_FILE') === '1') return { file: null, error: null };
  if (!existsSync(path)) return { file: null, error: null }; // by far the common case — never an error

  // ONE read. An earlier version parsed the file for validation and then called
  // process.loadEnvFile() to apply it, which had two problems: the file could change
  // between the two reads (so unvalidated content could be applied), and loadEnvFile
  // applies the WHOLE file — a stray TMPDIR or HTTP_PROXY in it would silently reach
  // every child process we spawn, and an in-file CYPHER_BRAIN_HOME would land in the
  // environment despite the warning saying it is ignored (multi-model review findings).
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch (e) {
    return { file: null, error: new Error(`config file ${path} could not be parsed: ${errMsg(e)}`) };
  }

  // Both spellings are ours; the legacy CIPHER_BRAIN_* keys are validated and applied
  // under the same rules as the canonical ones.
  const ours = Object.keys(parsed).filter((k) => k.startsWith(ENV_PREFIX) || k.startsWith(LEGACY_ENV_PREFIX));
  const unknown = ours.filter((k) => !(ENV_NAMES as readonly string[]).includes(canonicalEnvName(k)));
  if (unknown.length) {
    return {
      file: null,
      error: new Error(
        `config file ${path}: unknown setting(s) ${unknown.join(', ')} — ` +
          `cypher-brain reads no such variable, so this would have no effect (a typo in e.g. ` +
          `CYPHER_BRAIN_MAX_SPEND would silently remove your spend cap). Run 'cypher-brain --help' ` +
          `for the settings it does read. Keys outside the CYPHER_BRAIN_ (or legacy CIPHER_BRAIN_) ` +
          `namespace are ignored entirely.`,
      ),
    };
  }
  // The same setting spelled both ways in one file is ambiguous — which value would win
  // depends on iteration order, and for a spend cap that is not something to guess at.
  const seen = new Map<string, string>();
  for (const k of ours) {
    const c = canonicalEnvName(k);
    const prev = seen.get(c);
    if (prev !== undefined && prev !== k) {
      return {
        file: null,
        error: new Error(
          `config file ${path}: ${prev} and ${k} are the same setting spelled two ways — keep one ` +
            `(the CYPHER_BRAIN_ spelling is the current one).`,
        ),
      };
    }
    seen.set(c, k);
  }
  if (seen.has('CYPHER_BRAIN_HOME')) {
    warn(
      `${path} sets ${seen.get('CYPHER_BRAIN_HOME')}, which is ignored — this file is found *inside* ` +
        `CYPHER_BRAIN_HOME, so it cannot choose it. Set it in the environment instead.`,
    );
  }
  warnIfLooseKeyPermsSync(path, 'config file');

  // Apply ONLY our own validated settings, and only where the environment has not
  // already spoken — explicit env > file, the same precedence Node's own loader uses,
  // written out here because we are no longer handing it the whole file. "Already
  // spoken" means under EITHER spelling: an operator's CIPHER_BRAIN_X in the environment
  // still outranks a CYPHER_BRAIN_X in the file.
  // CYPHER_BRAIN_HOME is excluded outright: it was resolved before this ran, so letting
  // it into the environment would mean child processes disagreeing with this one.
  const applied: string[] = [];
  for (const k of ours) {
    const c = canonicalEnvName(k) as EnvName;
    if (c === 'CYPHER_BRAIN_HOME') continue;
    if (readEnv(c) !== undefined) continue;
    process.env[k] = parsed[k];
    applied.push(k);
  }
  return { file: { path, variables: applied }, error: null };
}

// Resolved from the environment ALONE, before the file is loaded — see loadConfigFile.
// The default directory moved from ~/.cipher-brain to ~/.cypher-brain with the rename;
// an existing ~/.cipher-brain keeps being used until a ~/.cypher-brain exists, so an
// upgrade never silently points at an empty home while the keys sit in the old one.
const defaultHome = (): string => {
  const current = join(homedir(), '.cypher-brain');
  const legacy = join(homedir(), '.cipher-brain');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
};
export const HOME = readEnv('CYPHER_BRAIN_HOME') || defaultHome();

/**
 * The config file's resolved path under this run's HOME, whether or not it exists —
 * for anything that needs to NAME it (e.g. `init` telling the user where to put a
 * setting). Distinct from CONFIG_FILE below, which is null unless a file was actually
 * loaded. Must stay after HOME: it is derived from it.
 */
export const CONFIG_FILE_PATH = configFileIn(HOME);

const CONFIG_LOAD = loadConfigFile(HOME);
/** The config file that was loaded, if any. `schedule status` reports it (#286). */
export const CONFIG_FILE: LoadedConfigFile | null = CONFIG_LOAD.file;
/**
 * Why the config file was refused, if it was. NOTHING from the file has been applied
 * when this is set. Both entry points (cli.ts main(), mcp.ts startup) must re-throw it
 * before doing any work — otherwise a command would run with the file silently ignored,
 * which is the outcome this refusal exists to prevent.
 */
export const CONFIG_FILE_ERROR: Error | null = CONFIG_LOAD.error;

// #64: age runs in-process (typage, bundled) — the external-binary overrides are obsolete.
for (const v of ['CYPHER_BRAIN_AGE', 'CYPHER_BRAIN_AGE_KEYGEN'] as const) {
  if (readEnv(v))
    warn(`${v} is deprecated and ignored — age is bundled in-process (typage); no external age binary is used`);
}
export const PG_BIN = readEnv('CYPHER_BRAIN_PG_BIN') || ''; // dir holding pg_dump/pg_restore; '' => PATH
export const pgTool = (name: string): string => (PG_BIN ? join(PG_BIN, name) : name);

export const IDENTITY = join(HOME, 'identity.age'); // private key — required to restore
export const RECIPIENT = join(HOME, 'recipient.txt'); // public key — all snapshot needs

// #232: append-only JSONL ledger of ACTUAL storage-provider receipts (arweave/turbo
// only — the paid backends), one line per completed paid push. Same append-only JSONL
// shape as IDEMPOTENCY_LOG below, but a different consistency contract: this is an
// audit trail, not a replay-detection log, so a single malformed/truncated line is
// skipped (src/lib/receipt.ts), never treated as fail-closed.
export const RECEIPT_LEDGER = readEnv('CYPHER_BRAIN_RECEIPT_LEDGER') || join(HOME, 'receipt-ledger.jsonl');

// #226: append-only, hash-chained JSONL audit trail — one line per push/restore/verify
// run (success or failure), each line's hash binding it to the previous line's hash
// (Certificate-Transparency-style tamper evidence). Same pure-append shape as
// RECEIPT_LEDGER (src/lib/audit.ts), a DIFFERENT concept from both it (this covers
// every push/restore/verify, not just paid ones, and carries no cost data) and
// IDEMPOTENCY_LOG (that one detects REPLAYS; this one never mutates or drops a past
// entry).
export const AUDIT_LOG = readEnv('CYPHER_BRAIN_AUDIT_LOG') || join(HOME, 'audit-log.jsonl');

// #220: cypher-brain-mcp's idempotency-key log for snapshot_now (the paid MCP tool) — an
// AI agent's own retry after a network blip must not spend twice for what it believes is
// one call. JSONL, one line per still-fresh (tool, idempotency_key) pair; see
// src/lib/idempotency.ts for the read/write contract. MCP-only bookkeeping (the CLI never
// reads or writes it), so it needs no CLI flag, only this path and the TTL below.
export const IDEMPOTENCY_LOG = join(HOME, 'idempotency-log.jsonl');
// How long a recorded result stays replayable before a repeat of the same key is treated
// as a brand-new call. Default 24h: long enough to cover an agent's own retry-after-
// failure window, short enough that a deliberate re-run days later (a different snapshot
// an agent mistakenly keys the same) is never silently skipped forever.
//
// Multi-model review (P2): a NaN/zero/negative override would silently DISABLE replay
// entirely — idempotency.ts's isFresh() compares `now - t < ttlSeconds * 1000`, and a `<
// NaN`/`< 0` comparison is always false, so every lookup reads as already-expired and
// every retry spends again, exactly the double-spend #220 exists to prevent. An Infinity
// override does the opposite: it never expires anything, so the SAME key reused days
// later — the "a different snapshot an agent mistakenly keys the same" case the comment
// above says the default must catch — is silently answered with a stale, unrelated
// result forever instead. Validated, not just Number()'d like the other numeric env
// overrides in this file; a bad value is RECORDED as a value here (not thrown), the same
// pattern CONFIG_FILE_ERROR above uses and for the same reason: this runs in a module
// body, before either entry point's own error formatting is available, and the CLI never
// reads or writes the idempotency log at all, so only mcp.ts's own startup (the sole
// actual consumer of this value) decides whether and when to surface it.
function parseIdempotencyTtlSeconds(raw: string | undefined): { seconds: number; error: Error | null } {
  const DEFAULT_SECONDS = 24 * 60 * 60;
  if (raw === undefined) return { seconds: DEFAULT_SECONDS, error: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return {
      seconds: DEFAULT_SECONDS,
      error: new Error(
        `CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS must be a positive finite integer (seconds) — got ${JSON.stringify(raw)}. ` +
          'A NaN/zero/negative value would disable idempotency-key replay entirely (every lookup reads as already ' +
          'expired); an Infinity value would never expire a key, keeping a stale result replayable forever.',
      ),
    };
  }
  return { seconds: n, error: null };
}
const IDEMPOTENCY_TTL_LOAD = parseIdempotencyTtlSeconds(readEnv('CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS'));
export const IDEMPOTENCY_TTL_SECONDS = IDEMPOTENCY_TTL_LOAD.seconds;
/** Why CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS was refused, if it was — mcp.ts's main() must check this before serving (mirrors CONFIG_FILE_ERROR above). */
export const IDEMPOTENCY_TTL_ERROR: Error | null = IDEMPOTENCY_TTL_LOAD.error;

// schedule (#69) state and trigger locations. Declared here rather than in schedule.ts
// so every CYPHER_BRAIN_* name lives in ENV_NAMES above (#286); the values and their
// defaults are unchanged. LAUNCHD_DIR deliberately defaults OUTSIDE CYPHER_BRAIN_HOME —
// ~/Library/LaunchAgents is a real system directory, which is why `schedule install
// --no-load` warns about writing there and why the override exists (#182).
export const SCHEDULE_DIR = readEnv('CYPHER_BRAIN_SCHEDULE_DIR') || join(HOME, 'schedule');
export const LAUNCHD_DIR = readEnv('CYPHER_BRAIN_LAUNCHD_DIR') || join(homedir(), 'Library', 'LaunchAgents');

// Minisign-compatible Ed25519 signing keypair (#214) — an ADDITIONAL, optional layer:
// age (above) gives confidentiality + tamper detection but no AUTHENTICITY (anyone
// holding `recipient` — public by design — can forge ciphertext that decrypts cleanly
// with your identity, claiming to be a real snapshot). Signing the *.age ciphertext
// with this keypair and verifying BEFORE decrypt (src/lib/restore.ts) closes that gap.
// Wire-compatible with the reference `minisign` CLI (src/lib/minisign.ts) — a real
// `minisign -V -p sign-recipient.pub` can verify a *.minisig cypher-brain writes.
export const SIGN_IDENTITY = join(HOME, 'sign-identity.key'); // PRIVATE signing key — keep offline, same posture as IDENTITY
export const SIGN_RECIPIENT = join(HOME, 'sign-recipient.pub'); // PUBLIC verification key — safe to copy, same posture as RECIPIENT

// manifest.json's own `schema` field (#225): the highest version THIS build's restore
// logic knows how to interpret. snapshot() stamps every manifest it writes with this
// exact value (never a hand-typed literal) so the writer and the reader can never drift
// apart. restore() refuses (rather than guessing) when a manifest declares a HIGHER
// schema than this — Arweave permanence means a decades-old build may one day face a
// manifest shape it was never written to understand, and misinterpreting an unknown
// component/field shape as a known one is worse than a clear "upgrade cypher-brain"
// error. Bump this the day manifest.json's shape changes in a way older restore code
// would misread (new required field, changed meaning of an existing one, etc.) —
// purely additive/optional fields do not require a bump.
export const MANIFEST_SCHEMA_VERSION = 1;

export const AGE_MAGIC = 'age-encryption.org/v1';
// The first bytes of a *.minisig, beside AGE_MAGIC because they answer the same question
// for the other object type this project stores: "are these bytes the thing I asked for, or
// something a gateway handed me instead?" (#318). Kept identical to minisign.ts's
// COMMENT_PREFIX, which is what this project's own writer emits and what the format
// specifies for line 1.
export const MINISIG_MAGIC = 'untrusted comment: ';
export const AGE_ARMOR_HEADER = '-----BEGIN AGE ENCRYPTED FILE-----';

// Optional recipient allowlist. When set (including to a non-empty inline list or a
// path to a file of them), snapshot refuses to encrypt unless EVERY effective
// recipient is on this list — so a tampered recipient.txt / an injected extra
// --recipient (which would silently re-key future snapshots to an attacker) is
// caught at the input, before any ciphertext is produced. Inline (space/comma/
// newline-separated age1… keys) OR a path to a file of them.
//
// `undefined` (unset) means "no pin configured" — the check is skipped entirely.
// `''` (explicitly set to an empty string, e.g. a broken cron/systemd template that
// renders CYPHER_BRAIN_PIN_RECIPIENTS="") is NOT treated the same as unset: `||` would
// collapse both to the same falsy '' and silently disable the allowlist (fail-open).
// Kept as `string | undefined` so the two cases stay distinguishable at the call site,
// which must fail closed on the explicit-empty-string case.
export const PIN_RECIPIENTS: string | undefined = readEnv('CYPHER_BRAIN_PIN_RECIPIENTS');
// An age recipient: X25519 (age1 + bech32, bounded 50-63 so two unseparated keys
// can't fuse) OR a post-quantum HYBRID recipient (#205: `keygen --pq`, ML-KEM-768 +
// X25519 via typage's generateHybridIdentity()) — `age1pq1` + a MUCH longer bech32
// body (~1950 chars observed; bounded 1900-2000, still far short of 2x a hybrid
// recipient so two unseparated hybrid keys can't fuse either). The hybrid
// alternative is listed FIRST so it wins the leftmost-first alternation match
// instead of the plain age1 branch truncating it at its own tight bound — without
// this, resolvePinnedRecipients() (below) would silently mismatch every hybrid
// recipient against CYPHER_BRAIN_PIN_RECIPIENTS.
export const AGE_PUBKEY_RE = /age1pq1[0-9a-z]{1900,2000}|age1[0-9a-z]{50,63}/g;

// ---------- storage backend config (pluggable: storage only ever sees ciphertext) ----------
// Backends whose locator is NOT a content hash the fetched bytes are checked against —
// a post-assigned id (a tx id / data item id) for arweave/turbo, or the operator's own
// path/remote string for rclone (src/lib/backends/rclone.ts's own doc comment: "the
// locator IS the '<remote>:<path>' string itself"), so nothing stops the SAME locator
// from later serving different bytes. `file` is deliberately NOT in this set: its
// locator IS the sha256 of what was pushed, and its get() (src/lib/backends/file.ts)
// verifies the fetched bytes against that hash itself before ever returning them
// (#209 review) — a substitution there is caught unconditionally, not only when the
// caller happens to pass --sha256. Used by verify --level remote/drill (src/lib/
// restore.ts, #209) and the MCP verify_restore tool (src/mcp.ts) to warn when a pull ran
// with no sha256 pin: without one, for arweave/turbo/rclone, a gateway/remote that
// rolled back or substituted the object served at that same locator would not be caught.
// `ton` is here despite its bag id BEING a content address (a merkle root the P2P
// download path verifies every piece against): its get() may serve a pull via the SSH
// seeder fallback, which verifies nothing, and the caller cannot tell which path
// answered — so the pin warning must stay on (src/lib/backends/ton.ts header).
export const NON_CONTENT_ADDRESSED_BACKENDS = new Set(['arweave', 'turbo', 'rclone', 'ton']);
// #465: `pull --wait <seconds>` only has an effect for backends whose get() can throw
// util.ts's RetryableError — today that's arweave (a fresh L1 tx/bundle item can take
// minutes to propagate to a gateway) and turbo (its get() delegates straight to
// arweaveBackend().get() — src/lib/backends/turbo.ts — so it throws the same
// RetryableError on the same "not yet indexed" condition). file/rclone/ton/ton-provider's
// get() throws a plain Error on a not-yet-retrievable object, so pushpull.ts's retry loop
// (`!(e instanceof RetryableError)` at the top of its catch) exits on attempt 1 regardless
// of --wait — silently, before this issue, since nothing told the operator their --wait
// was accepted but ignored. Used by pushpull.ts's pull() to warn() when --wait is set for
// a backend not in this set. Keep in sync with any backend whose get() starts/stops
// throwing RetryableError.
export const WAIT_RETRY_BACKENDS = new Set(['arweave', 'turbo']);
export const FILE_DIR = readEnv('CYPHER_BRAIN_FILE_DIR') || join(HOME, 'store'); // file backend object store
// rclone backend (#204): the `rclone` binary name/path, same PATH-or-override
// pattern as PG_BIN above — most machines just need `rclone` on PATH; override
// for a non-standard install location.
export const RCLONE_BIN = readEnv('CYPHER_BRAIN_RCLONE_BIN') || 'rclone';
// --scan-secrets' gitleaks binary (#215), same PATH-or-override pattern as RCLONE_BIN.
// `schedule install --scan-secrets` sets this to the ABSOLUTE path it resolved, so the
// unattended run executes the scanner the operator was shown at install time rather than
// whatever a bare launchd/cron PATH resolves that name to (#307, multi-model review).
export const GITLEAKS_BIN = readEnv('CYPHER_BRAIN_GITLEAKS_BIN') || 'gitleaks';
// ton backend (src/lib/backends/ton.ts): the seeder box (an operator-run always-on
// machine with tonutils-storage) and the local binary for P2P pulls. The seeder's
// HTTP API stays bound to loopback ON that box — it is reached via ssh + curl, never
// exposed to the network — which is why there is a host and a loopback address here
// rather than a URL.
export const TON_SSH_HOST = readEnv('CYPHER_BRAIN_TON_SSH_HOST') || ''; // user@host of the seeder; required to push
export const TON_SSH_KEY = readEnv('CYPHER_BRAIN_TON_SSH_KEY') || ''; // optional -i identity file for ssh/scp
export const TON_REMOTE_DIR = readEnv('CYPHER_BRAIN_TON_REMOTE_DIR') || 'cypher-brain-ton'; // seeder-side layout root: plain relative (lands in the SSH user's home) or absolute — a literal `~` is refused (ssh quoting vs scp expansion diverge, backends/ton.ts)
export const TON_REMOTE_API = readEnv('CYPHER_BRAIN_TON_REMOTE_API') || '127.0.0.1:9955'; // tonutils-storage API addr AS SEEN FROM the seeder itself
export const TON_BIN = readEnv('CYPHER_BRAIN_TON_BIN') || 'tonutils-storage'; // local binary for the ephemeral P2P download daemon
// Validated, unlike the older Number() timeouts above (multi-model review W5): an
// invalid value here would make EVERY local daemon API call throw (AbortSignal.timeout
// rejects NaN/negative), which get() would read as "P2P failed" and silently steer
// every pull into the less-verifiable seeder fallback — a config typo must not be able
// to change what a successful pull proves. Invalid -> warn + default, never throw
// (this runs at import time; the CONFIG_FILE_ERROR pattern above explains why).
// Reuses parsePositiveMsOverride (declared below in this file, hoisted as a function
// declaration so this earlier call site can see it) — this is exactly the "validate
// positive integer ms, warn+default on invalid" logic the TON_PROVIDER_* overrides
// further down already use; hand-rolling it here a second time only risked the two
// drifting apart (#499). `|| undefined` preserves this variable's own pre-existing
// quirk (multi-model review, #499 fix): the old hand-rolled version computed
// `Number(raw || 30_000)`, so an explicitly-set-but-EMPTY-string value fell back to the
// default the same silent way an unset one does, with no warning — only a non-empty
// invalid value (e.g. "abc"/"0"/"-5") warned. Passing raw straight through here would
// change that one edge case (parsePositiveMsOverride treats "" as a defined-but-invalid
// "0" and would newly warn on it); the TON_PROVIDER_* overrides below intentionally keep
// that stricter behavior for their OWN empty-string case, since they never had this `||`
// shortcut to begin with.
export const TON_HTTP_TIMEOUT_MS = parsePositiveMsOverride(
  readEnv('CYPHER_BRAIN_TON_HTTP_TIMEOUT') || undefined,
  30_000,
  'CYPHER_BRAIN_TON_HTTP_TIMEOUT',
);
// STRICTLY '1', same reasoning as SKIP_FUNDS_CHECK below: this switch changes what a
// successful pull PROVES (P2P availability vs. merely "the seeder still had a copy"),
// so a stray `=0` must keep the default behaviour.
export const TON_NO_FALLBACK = readEnv('CYPHER_BRAIN_TON_NO_FALLBACK') === '1';
export const TON_NETWORK_CONFIG = readEnv('CYPHER_BRAIN_TON_NETWORK_CONFIG') || ''; // path to a TON global config (testnet); '' = daemon default (mainnet)
// `publish-latest` (src/lib/ton-dns.ts) only — resolves a .ton domain's NFT item address
// and polls its DNS resolution, both via tonapi.io's public REST API. Overridable so
// scripts/selftest-ton-dns.sh can point it at a local mock HTTP server instead of the
// real service (no real-network calls in CI).
export const TON_TONAPI_URL = readEnv('CYPHER_BRAIN_TON_TONAPI_URL') || 'https://tonapi.io';
// ton-provider backend (src/lib/backends/ton-provider.ts, issue #396): pays a live
// mytonprovider.org market provider instead of self-hosting a seeder. Mainnet-only —
// the provider market itself is a mainnet market (docs/ton-storage-status.md), so unlike
// arweave/turbo there is no meaningful testnet mode to gate behind a flag.
export const TON_PROVIDER_OWNER = readEnv('CYPHER_BRAIN_TON_PROVIDER_OWNER') || ''; // TON wallet address that will own the deployed StorageV1 contract (required to push)
const TON_PROVIDER_MAX_SPEND_RAW = readEnv('CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND');
// Unlike AR_MAX_SPEND (0/unset = no cap, the --yes guard alone gates spend), ton-provider.ts's
// put() deliberately REFUSES to push at all when this is 0/unset — a StorageV1 deploy has no
// SDK-computed "market price" the way arweave/turbo do, so there is no safe default amount to
// let through uncapped (Codex review: the prior wording here claimed the opposite of the
// enforced behavior). Separate variable from AR_MAX_SPEND — different backend, different
// native unit, so one accidental cap must never silently apply to the other's spend.
export const TON_PROVIDER_MAX_SPEND = TON_PROVIDER_MAX_SPEND_RAW ? BigInt(TON_PROVIDER_MAX_SPEND_RAW) : 0n;
// Path to a locally-built scripts/go/storage-v1-client binary (`go build` in that dir) —
// the ONLY step that needs it: notifying a provider over ADNL/RLDP has no mature
// TypeScript implementation (checked; even thekiba/tonutils's storage package is
// unimplemented), so this shells out to the tested Go program rather than reimplementing
// a P2P protocol handshake by hand. Cross-platform prebuilt-binary distribution is out of
// scope for this PR (issue #396) — an operator builds it once with a Go toolchain.
export const TON_PROVIDER_NOTIFY_BIN = readEnv('CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN') || '';
export const TON_PROVIDER_MYTONPROVIDER_URL =
  readEnv('CYPHER_BRAIN_TON_PROVIDER_MYTONPROVIDER_URL') || 'https://mytonprovider.org';
// Test-only overrides for how long/how often put() retries notify() waiting for the
// provider to report a full download — scripts/selftest-ton-provider.sh sets these short
// so its "push waits, does not succeed early" positive control finishes in seconds
// instead of the real 10-minute default a genuine push needs (a fresh provider fetch of
// a large brain over P2P is real network work, not instantaneous).
// Validated by the same parsePositiveMsOverride helper TON_HTTP_TIMEOUT_MS above calls
// (Codex review): an unvalidated NaN/Infinity/negative override would make
// notifyProviderWithRetry()'s `Date.now() > deadline` comparison never trip, silently
// leaving the paid deploy's local ephemeral daemon (and the temp directory it seeds
// from) retrying forever instead of the bounded failure this budget exists to guarantee.
function parsePositiveMsOverride(raw: string | undefined, defaultMs: number, name: string): number {
  if (raw === undefined) return defaultMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    warn(`${name} must be a positive integer (ms) — got ${JSON.stringify(raw)}; using the ${defaultMs}ms default`);
    return defaultMs;
  }
  return n;
}
export const TON_PROVIDER_NOTIFY_RETRY_MS = parsePositiveMsOverride(
  readEnv('CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS'),
  10 * 60_000,
  'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS',
);
export const TON_PROVIDER_NOTIFY_INTERVAL_MS = parsePositiveMsOverride(
  readEnv('CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS'),
  15_000,
  'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS',
);
// Test-only overrides for waitForContractActive()'s own poll loop (issue #480) — same
// reason as the notify overrides just above: a real deploy-confirmation wait is bounded
// at 20 real minutes (a human has to open Tonkeeper and sign, or an auto-signed broadcast
// has to actually land), and scripts/selftest-ton-provider.sh needs a positive control for
// BOTH the timeout error message wording (auto-sign vs. Tonkeeper-deeplink guidance) and
// the periodic progress line without waiting anywhere near that long.
export const TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS = parsePositiveMsOverride(
  readEnv('CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS'),
  20 * 60_000,
  'CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS',
);
export const TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS = parsePositiveMsOverride(
  readEnv('CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS'),
  5_000,
  'CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS',
);
// How often waitForContractActive() prints a "still waiting" line while polling (#480: a
// real 20-minute wait with zero output in between reads as a hang, not a wait) — separate
// knob from the poll interval above so a test can observe several progress lines without
// also having to poll tonapi's mock every few milliseconds.
export const TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS = parsePositiveMsOverride(
  readEnv('CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS'),
  30_000,
  'CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS',
);
// PR2 (auto-signing): path to a local TON wallet mnemonic file (`wallet create --chain ton`,
// src/lib/wallet.ts). When set AND present on disk, ton-provider.ts's put() signs and
// broadcasts the StorageV1 deploy itself instead of printing a Tonkeeper deeplink for a
// human to sign — the SAME "presence-checkable capability" pattern AR_WALLET already
// uses for arweave/turbo. Mirrors AR_WALLET exactly; kept as its own variable (not reused)
// because it names a DIFFERENT credential (a TON mnemonic, not a JWK) for a different chain.
export const TON_WALLET = readEnv('CYPHER_BRAIN_TON_WALLET') || '';
export const AR_HOST = readEnv('CYPHER_BRAIN_AR_HOST') || 'arweave.net';
export const AR_PORT = Number(readEnv('CYPHER_BRAIN_AR_PORT') || 443);
export const AR_PROTOCOL = readEnv('CYPHER_BRAIN_AR_PROTOCOL') || 'https';
export const AR_WALLET = readEnv('CYPHER_BRAIN_AR_WALLET') || ''; // path to a JWK key file
export const AR_PAID_BY = readEnv('CYPHER_BRAIN_AR_PAID_BY') || ''; // optional (turbo): an address that shared (delegated) Turbo Credits to the signer — passed as `paidBy` so the upload draws from that approval before the signer's own balance (the path for credits bought on a wallet we can't sign with, e.g. MetaMask, then shared to this JWK)
export const AR_DEFAULT_EXTRA_GATEWAYS = ['https://permagate.io']; // public mirror(s) tried after the primary (override the whole list with CYPHER_BRAIN_AR_GATEWAYS)
export const AR_HTTP_TIMEOUT_MS = Number(readEnv('CYPHER_BRAIN_AR_HTTP_TIMEOUT') || 60000); // bound the gateway read so a stall falls through to the L1 chunk fallback
// Public, unauthenticated USD/AR rate endpoint (ArDrive Turbo's payment service) — a
// plain JSON GET, no SDK or auth required (#170). arUsdRate() (src/lib/estimate.ts)
// fetches this directly instead of going through @ardrive/turbo-sdk, so the USD line
// works even when that optional peerDependency isn't installed.
export const AR_USD_RATE_URL = readEnv('CYPHER_BRAIN_AR_USD_RATE_URL') || 'https://payment.ardrive.io/v1/rates/usd';
// Turbo's own credit price sheet (#343): `GET /v1/rates` answers with the winc one GiB
// costs AND its fiat price — i.e. what buying these credits actually costs, fees
// included. The AR-spot rate above stays correct for the raw `arweave` L1 backend
// (that spend is real AR at market value), but pricing a TURBO upload with it
// understated the observed real cost by ~35%: turbo spends credits, and credits sell at
// Turbo's rate, not at AR spot. Same #170 posture: plain unauthenticated GET, no SDK.
export const AR_TURBO_RATES_URL = readEnv('CYPHER_BRAIN_AR_TURBO_RATES_URL') || 'https://payment.ardrive.io/v1/rates';
// Public, unauthenticated account-balance endpoint on the same payment service, queried
// as `<url>?address=<addr>` (#345). Same #170 reasoning as the rate URL above: the SDK
// exposes this as turbo.getBalance(), but it is a plain GET keyed on a PUBLIC address —
// no signature, no key material — so reading it must not require an optional
// peerDependency that a machine may not have (or, per #344, may not be installable on).
export const AR_BALANCE_URL = readEnv('CYPHER_BRAIN_AR_BALANCE_URL') || 'https://payment.ardrive.io/v1/balance';
// Spend guard: arweave/turbo uploads are irreversible and cost real funds. Require an
// explicit opt-in so an unattended nightly loop doesn't silently accumulate charges.
//   CYPHER_BRAIN_YES=1  — set in the nightly runner (`schedule install` writes it for paid backends) to suppress the --yes prompt
//   CYPHER_BRAIN_MAX_SPEND — abort if the upload cost estimate (in the backend's native
//     unit: winston for arweave L1, winc for turbo) exceeds this value; 0/unset = no cap
//     (the --yes guard still fires). Prevents runaway spend without changing behaviour
//     when the upload is well under budget.
export const CIPHER_YES = !!readEnv('CYPHER_BRAIN_YES');
const MAX_SPEND_RAW = readEnv('CYPHER_BRAIN_MAX_SPEND');
export const AR_MAX_SPEND = MAX_SPEND_RAW ? BigInt(MAX_SPEND_RAW) : 0n;
// Escape hatch for the turbo pre-upload funds check (#342). The check refuses an upload
// whose cost exceeds even the upper bound of reachable credit — a spend the payment
// service would reject anyway — but the balance read can lag a top-up made seconds
// earlier, and a stale read must not strand an operator who KNOWS they just funded it.
// One-run bypass, named in the refusal message itself. STRICTLY '1', unlike CIPHER_YES's
// any-non-empty reading: this switch DISABLES a protection, so a stray
// `CYPHER_BRAIN_SKIP_FUNDS_CHECK=0` (or `=false`) must keep the check ON — loose
// truthiness here would turn the spelling that obviously means "off" into "on"
// (Codex review). An unrecognized value self-corrects: the check still runs, and its
// refusal message spells out the exact `=1` form.
export const SKIP_FUNDS_CHECK = readEnv('CYPHER_BRAIN_SKIP_FUNDS_CHECK') === '1';
// The raw `arweave` backend posts one inline L1 tx; gateways reject single-tx bodies
// past ~12 MiB. Guard at a conservative 10 MiB and redirect large uploads to `turbo`
// (which streams + ANS-104-bundles). Override for a deliberate large L1 post.
export const AR_L1_MAX_BYTES = Number(readEnv('CYPHER_BRAIN_AR_L1_MAX') || 10 * 1024 * 1024);
// Overall wall-clock cap for the tar|age / age|tar streaming pipelines, the pre-stage
// tar, pg_restore, AND the rclone backend's copyto subprocess, so a wedged binary (or
// a FIFO/special file under --dir, or a stalled remote transfer) can't hang the CLI
// forever. Generous default (1h) — a real ~850 MB brain streams in seconds, so this
// only ever trips on a genuine hang. Override with CYPHER_BRAIN_PIPE_TIMEOUT (ms) for
// very large brains / restores / slow remotes.
export const PIPE_TIMEOUT_MS = Number(readEnv('CYPHER_BRAIN_PIPE_TIMEOUT') || 60 * 60 * 1000);
