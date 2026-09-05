// doctor — a read-only environment health check (#201).
//
// Several past issues were each a report of ONE way this tool's setup can silently be
// unsafe: #91 (loadIdentities() never checked identity permissions), #119 (a chmod
// failure on $CYPHER_BRAIN_HOME was swallowed instead of failing closed), #35 (the
// Arweave JWK wallet got weaker permission hygiene than the age identity), #101
// (CYPHER_BRAIN_PIN_RECIPIENTS="" used to fail OPEN, disabling the allowlist), #99 (the
// offline backup keypair's suggested default path sits on the SAME disk as the primary
// identity). Every one of those is fixed now (loadIdentities/keygenAt/wallet.ts all
// warn or fail closed on loose permissions today; snapshot.ts fail-closes on an empty
// pin) — but a fix landing once does not mean it STAYS true on a given machine: a
// config file can be hand-edited, a chmod can be undone, a home directory can be moved
// between machines. This command re-checks all of it, and adds the two things none of
// the individual fixes could: an identity/recipient pairing check, and the last
// scheduled run's outcome (reusing schedule.ts's own status computation).
//
// Design borrowed from Open Second Brain's `o2b brain doctor` (docs/prior-art.md,
// #201's issue comment) and adapted to this project's read-only posture:
//   1. health_score discounts KNOWN, already-flagged issues rather than re-charging the
//      FULL penalty for the same one on every single run — a check that just turned
//      WARN/FAIL for the first time costs more than one you have already seen and not
//      fixed yet, so the score mostly answers "did anything get WORSE since I last
//      looked" rather than "have I fixed literally everything yet" (which would sit low
//      forever for a risk you have deliberately accepted). It is a DISCOUNT, not a full
//      exclusion, on purpose: a lingering FAIL still pulls the score down, so it can
//      never read a healthy-looking 100/100 next to VERDICT: FAIL.
//   2. Each WARN/FAIL is marked known ("carryover", already seen last run) or 🆕 new
//      (first time), so a fresh problem does not get lost in a wall of ones you already
//      know about.
//   3. Every WARN/FAIL carries the exact remediation command, not just a description of
//      the problem.
//
// "Known vs new" needs a memory of the LAST run, so doctor keeps a small bookkeeping
// file at $CYPHER_BRAIN_HOME/doctor-state.json — check ids and timestamps only, never
// key material. It is written best-effort and ONLY when CYPHER_BRAIN_HOME already
// exists: doctor's whole premise is inspecting an EXISTING setup, so it must never
// create that directory just to leave its own bookkeeping file on a machine that has
// nothing set up yet (that would also stop being a purely read-only diagnostic).
import { stat, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { identityToRecipient } from 'age-encryption';
import {
  HOME,
  IDENTITY,
  RECIPIENT,
  SIGN_IDENTITY,
  AR_WALLET,
  TON_WALLET,
  PIN_RECIPIENTS,
  MCP_SOURCE_ROOTS,
  MCP_SOURCE_ROOTS_ERROR,
  CONFIG_FILE_PATH,
  AGE_MAGIC,
  AGE_ARMOR_HEADER,
  AUDIT_LOG,
  RECEIPT_LEDGER,
} from './config.js';
import { exists, errMsg } from './util.js';
import { recipientEntries, resolvePinnedRecipients } from './keys.js';
import { WALLET_DEFAULT_PATH, TON_WALLET_DEFAULT_PATH } from './wallet.js';
import { scheduleStatusReport, ScheduleNotInstalledError } from './schedule.js';
import { buildInfo, buildAgeDays, BUILD_STALE_DAYS } from './buildinfo.js';
import { readAuditLog, verifyAuditChain } from './audit.js';
import { readReceipts } from './receipt.js';
import { readSpendIntents, isUnsettled, PENDING_SPENDS_LOG, type SpendIntentRecord } from './pending-spend.js';
import { detectGbrainEngine, resolveGbrainConfigPath } from './gbrain.js';
import { printJson, printMascot, moodForVerdict } from './ui.js';
import type { CliOptions } from './types.js';

type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

type DoctorMarker = 'new' | 'carryover' | null;

interface DoctorCheckResult extends DoctorCheck {
  marker: DoctorMarker;
  /** ISO date this check FIRST turned WARN/FAIL — only set for warn/fail results. */
  since?: string;
}

interface DoctorResolved {
  id: string;
  message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheckResult[];
  readonly resolved: readonly DoctorResolved[];
  readonly health_score: number;
  readonly new_count: number;
  readonly carryover_count: number;
  readonly verdict: 'PASS' | 'FAIL' | 'PARTIAL';
  readonly state_path: string;
  readonly state_saved: boolean;
}

// ---------- individual checks ----------

const loosePerms = (mode: number): boolean => (mode & 0o077) !== 0;
const octal = (mode: number): string => (mode & 0o777).toString(8);

// A doctor-local stat, deliberately NOT util.ts's exists() (access(F_OK)): that helper
// folds every failure — a genuine ENOENT, but ALSO EACCES ("permission denied" on a
// parent directory) and ELOOP (a symlink cycle) — into a plain "not there", which is
// the right posture for its many callers (they just want a yes/no gate before
// proceeding) but the wrong one for a DIAGNOSTIC whose entire job is to surface exactly
// those conditions instead of quietly reporting "nothing to check" (Codex review,
// #333). Only ENOENT/ENOTDIR (nothing at this path, or a path component genuinely is
// not a directory) mean "not found" here — the same distinction util.ts's own
// requireFile/requirePath already draw; everything else is rethrown so callers can
// turn it into a FAIL instead of a false-negative SKIP.
function statOrNotFound(path: string): Promise<Stats | null> {
  return stat(path).catch((e) => {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  });
}

// A human-readable name for whatever a non-regular-file Stats describes — used when a
// check refuses to treat something as the plain file it expects (a key, an identity)
// instead of silently reading it.
function statKind(st: { isDirectory(): boolean; isFIFO(): boolean; isSocket(): boolean }): string {
  if (st.isDirectory()) return 'a directory';
  if (st.isFIFO()) return 'a FIFO/named pipe';
  if (st.isSocket()) return 'a socket';
  return 'not a regular file';
}

async function checkHomeDirPerms(): Promise<DoctorCheck> {
  const id = 'home-dir-perms';
  let st: Stats | null;
  try {
    st = await statOrNotFound(HOME);
  } catch (e) {
    return {
      id,
      status: 'fail',
      message: `could not check CYPHER_BRAIN_HOME (${HOME}): ${errMsg(e)}`,
      remediation: `check that every path component of ${HOME} is accessible — a permission-denied parent directory or a symlink loop prevents this check from seeing its real permissions`,
    };
  }
  if (!st) {
    return {
      id,
      status: 'skip',
      message: `no CYPHER_BRAIN_HOME directory yet at ${HOME} — run 'cypher-brain keygen' or 'cypher-brain init' to create one`,
    };
  }
  if (loosePerms(st.mode)) {
    return {
      id,
      status: 'fail',
      message: `CYPHER_BRAIN_HOME (${HOME}) is group/other-accessible (mode ${octal(st.mode)}) — it holds the private identity`,
      remediation: `chmod 700 ${HOME}`,
    };
  }
  return { id, status: 'pass', message: `CYPHER_BRAIN_HOME permissions are 0700 (${HOME})` };
}

// Shared by identity.age, sign-identity.key and the wallet JWK — all three are secret
// key material that should be 0600, and each already gets a warnIfLooseKeyPerms() call
// on its own read path (crypt.ts/minisign.ts/wallet.ts); this is the same check, framed
// as a re-runnable diagnostic instead of a side effect of some other command.
//
// explicitPath: true for the ONE case where a missing file is itself a misconfiguration
// rather than "not set up yet" — the Arweave wallet's path can be EXPLICITLY set via
// CYPHER_BRAIN_AR_WALLET instead of falling back to WALLET_DEFAULT_PATH, and a user who
// set it clearly intends to use a wallet there; nothing at that exact path should FAIL,
// not SKIP with the same wording an unconfigured-and-that-is-fine wallet gets (Codex
// review, #333).
async function checkKeyPerms(
  id: string,
  path: string,
  label: string,
  explicitPath = false,
  envName = 'CYPHER_BRAIN_AR_WALLET',
): Promise<DoctorCheck> {
  let st: Stats | null;
  try {
    st = await statOrNotFound(path);
  } catch (e) {
    return {
      id,
      status: 'fail',
      message: `could not check ${label} at ${path}: ${errMsg(e)}`,
      remediation: `check that every path component of ${path} is accessible — a permission-denied parent directory or a symlink loop prevents this check from seeing its real permissions`,
    };
  }
  if (!st) {
    if (explicitPath) {
      // Codex review, xhigh pass: this remediation is shared between the Arweave JWK
      // check (envName's default) and the TON wallet check (#396 PR2) — a bare
      // 'wallet create --out <path>' would create an ARWEAVE wallet at a path the
      // operator configured for TON, the exact "wrong credential at that path" mistake
      // this check exists to catch. `--chain ton` only when this IS the TON check.
      const chainFlag = envName === 'CYPHER_BRAIN_TON_WALLET' ? ' --chain ton' : '';
      return {
        id,
        status: 'fail',
        message: `${envName} is set to ${path}, but nothing is there`,
        remediation: `create the wallet ('cypher-brain wallet create${chainFlag} --out ${path}'), fix the ${envName} path, or unset it`,
      };
    }
    return { id, status: 'skip', message: `no ${label} at ${path} — nothing to check` };
  }
  if (!st.isFile()) {
    return {
      id,
      status: 'fail',
      message: `${path} is not a regular file (${statKind(st)}) — ${label} must be a plain file`,
      remediation: `remove whatever is at ${path} and regenerate/restore the ${label} as a plain file`,
    };
  }
  if (loosePerms(st.mode)) {
    return {
      id,
      status: 'fail',
      message: `${label} at ${path} is group/other-accessible (mode ${octal(st.mode)}) — it is a secret`,
      remediation: `chmod 600 ${path}`,
    };
  }
  return { id, status: 'pass', message: `${label} permissions are 0600 (${path})` };
}

// Doctor-local wrapper around keys.ts's recipientEntries(): confirms `path` is a
// regular file FIRST. recipientEntries() calls readFile() directly with no such
// guard — on e.g. a FIFO with no writer, that would BLOCK INDEFINITELY, turning this
// routine, read-only diagnostic into a hang (#742) exactly like an unchecked read of
// IDENTITY would (see checkIdentityRecipientPairing()'s own statOrNotFound()+isFile()
// guard on IDENTITY below, and util.ts's readJsonlLog(), which takes the identical
// stance for AUDIT_LOG/RECEIPT_LEDGER, #695). Same narrow TOCTOU window those two
// already accept, for the same reason (readJsonlLog()'s own doc comment): a path
// swapped for a FIFO in the gap between this stat() and recipientEntries()'s own
// readFile() could still hang — closing that would mean reading the path BLIND,
// reintroducing the exact hang this guard exists to prevent.
async function safeRecipientEntries(path: string): Promise<string[]> {
  const st = await statOrNotFound(path);
  if (st && !st.isFile()) {
    throw new Error(`${path} is not a regular file (${statKind(st)}) — refusing to read it`);
  }
  return recipientEntries(path);
}

// Does the age identity actually derive the public key recipient.txt records? A
// mismatch means one of the two files was replaced independently of the other — a
// stale recipient.txt copied from elsewhere, or an identity restored from the wrong
// backup. Skipped (not failed) when the identity is passphrase-wrapped: unwrapping it
// needs a passphrase prompt, which a routine diagnostic should not spring on someone
// running it non-interactively (e.g. from a script) — the check that DOES prove
// end-to-end restorability, `cypher-brain verify`, already prompts for exactly that
// when it needs to.
async function checkIdentityRecipientPairing(): Promise<DoctorCheck> {
  const id = 'identity-recipient-pairing';
  let idStat: Stats | null;
  try {
    idStat = await statOrNotFound(IDENTITY);
  } catch (e) {
    return { id, status: 'fail', message: `could not check ${IDENTITY}: ${errMsg(e)}` };
  }
  if (!idStat || !(await exists(RECIPIENT))) {
    return { id, status: 'skip', message: 'no identity/recipient pair to check yet' };
  }
  if (!idStat.isFile()) {
    // Never open it: readFile() below would BLOCK indefinitely on e.g. a FIFO with no
    // writer on the other end, turning this routine, read-only diagnostic into a hang
    // (Codex review, #333) — a stat()-only check never has that problem, so the file's
    // TYPE has to be confirmed before the first byte is ever read.
    return {
      id,
      status: 'fail',
      message: `${IDENTITY} is not a regular file (${statKind(idStat)}) — refusing to read it`,
      remediation: `remove whatever is at ${IDENTITY} and restore the real identity file`,
    };
  }
  const raw = await readFile(IDENTITY);
  const rawText = raw.toString('utf8');
  const wrapped =
    raw.subarray(0, AGE_MAGIC.length).toString('latin1') === AGE_MAGIC ||
    rawText.trimStart().startsWith(AGE_ARMOR_HEADER);
  if (wrapped) {
    return {
      id,
      status: 'skip',
      message: `${IDENTITY} is passphrase-wrapped — skipped rather than prompting during a routine diagnostic (run 'cypher-brain verify --in <a snapshot>' to prove restorability instead)`,
    };
  }
  const idLines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (idLines.length === 0) {
    return {
      id,
      status: 'fail',
      message: `${IDENTITY} has no identity lines`,
      remediation: 'cypher-brain keygen --force',
    };
  }
  let derived: string[];
  try {
    derived = await Promise.all(idLines.map((l) => identityToRecipient(l)));
  } catch {
    // Deliberately do NOT include the underlying error's message (Codex review,
    // #333): age-encryption's bech32 decoder reports a bad checksum by echoing the
    // FULL input string back — "Invalid checksum in AGE-SECRET-KEY-1...: expected
    // ..." — which for a corrupt/truncated identity line IS the secret key material.
    // Printing that verbatim would leak it into whatever this routine, read-only
    // diagnostic's output goes to (a terminal, a log file, --json piped somewhere).
    return {
      id,
      status: 'fail',
      message: `${IDENTITY} does not parse as a valid age identity — it may be corrupt or truncated`,
      remediation: `restore ${IDENTITY} from a backup, or run 'cypher-brain keygen --force' to regenerate a fresh identity (only if you accept losing access to anything encrypted solely under the old one)`,
    };
  }
  const derivedSet = new Set(derived);
  const actual = new Set(await safeRecipientEntries(RECIPIENT));
  const anyMatch = derived.some((d) => actual.has(d));
  if (!anyMatch) {
    return {
      id,
      status: 'fail',
      message: `${IDENTITY} does not match ${RECIPIENT} — deriving its public key gives a different value than what recipient.txt records; one of the two files was likely replaced independently`,
      remediation: `restore the correct pairing from a backup, or run 'cypher-brain keygen --force' to regenerate a fresh, MATCHING pair (only if you accept that any snapshot already encrypted under the old key stays recoverable solely by the old identity)`,
    };
  }
  // The identity's own key IS somewhere in recipient.txt — but is anything ELSE also in
  // there? A plain `cypher-brain snapshot` (no --recipient override) encrypts to EVERY
  // entry recipient.txt lists, so an extra one here is not inert: it gets a real
  // stanza on every future snapshot, same as if it had been passed as a deliberate
  // second --recipient (README's Threat model: "a box that can rewrite recipient.txt
  // ... could silently re-key future snapshots to an attacker while your own restore
  // still works"). The documented way to encrypt to more than one identity (e.g. an
  // offline backup key) is a SEPARATE --recipient pointing at a SEPARATE file, not
  // merging keys into this one — so anything here beyond what THIS identity derives is
  // unexpected by construction, not a normal multi-key setup (Codex review, #333: the
  // previous `derived.some(...)` PASSED as long as ONE derived key matched, even with
  // an attacker's recipient ALSO present).
  const unexpected = [...actual].filter((r) => !derivedSet.has(r));
  if (unexpected.length > 0) {
    return {
      id,
      status: 'fail',
      message: `${RECIPIENT} lists ${unexpected.length} recipient(s) that do not derive from ${IDENTITY} (${unexpected.join(', ')}) — an unexpected recipient here silently re-keys EVERY future plain "cypher-brain snapshot" to whoever holds its identity too`,
      remediation: `if this is a deliberate multi-recipient/backup setup, keep the additional recipient in its OWN file and pass it as a separate --recipient at snapshot time instead of adding it to ${RECIPIENT}; otherwise remove the unexpected line(s) from ${RECIPIENT}`,
    };
  }
  return { id, status: 'pass', message: `${IDENTITY} matches the public key recorded in ${RECIPIENT}` };
}

// #101 is fixed at snapshot() time (an explicitly empty pin fails closed rather than
// silently disabling the allowlist) — but that failure only surfaces the NEXT time
// something snapshots, possibly unattended at 03:30. Catching it here, ahead of time,
// is the whole point of a doctor command: the same misconfiguration, found before it
// breaks a run instead of during one.
async function checkPinRecipients(): Promise<DoctorCheck[]> {
  const configId = 'pin-recipients-config';
  if (PIN_RECIPIENTS === undefined) {
    return [
      {
        id: configId,
        status: 'skip',
        message: 'CYPHER_BRAIN_PIN_RECIPIENTS is not set — no recipient allowlist configured (optional)',
      },
    ];
  }
  if (PIN_RECIPIENTS === '') {
    return [
      {
        id: configId,
        status: 'fail',
        message:
          'CYPHER_BRAIN_PIN_RECIPIENTS is set but EMPTY — every "cypher-brain snapshot" now refuses to run until this is fixed (fail-closed behavior, #101)',
        remediation: `unset CYPHER_BRAIN_PIN_RECIPIENTS (remove it from the environment, or from ${CONFIG_FILE_PATH}) to run without an allowlist, or set it to the age1… recipient(s) you intend to pin`,
      },
    ];
  }
  let allowed: Set<string>;
  try {
    allowed = await resolvePinnedRecipients(PIN_RECIPIENTS);
  } catch (e) {
    return [{ id: configId, status: 'fail', message: `could not resolve CYPHER_BRAIN_PIN_RECIPIENTS: ${errMsg(e)}` }];
  }
  if (allowed.size === 0) {
    return [
      {
        id: configId,
        status: 'fail',
        message:
          'CYPHER_BRAIN_PIN_RECIPIENTS is set but names no recognizable age1… recipient (a typo, or every entry is commented out)',
        remediation: 'fix the value/file, or unset CYPHER_BRAIN_PIN_RECIPIENTS to run without an allowlist',
      },
    ];
  }
  const results: DoctorCheck[] = [
    { id: configId, status: 'pass', message: `CYPHER_BRAIN_PIN_RECIPIENTS resolves to ${allowed.size} recipient(s)` },
  ];
  const includedId = 'pin-recipients-primary-included';
  if (!(await exists(RECIPIENT))) {
    results.push({
      id: includedId,
      status: 'skip',
      message: 'no primary recipient.txt to check against the allowlist yet',
    });
    return results;
  }
  // snapshot() (#101) fails closed on the FIRST effective recipient entry that is not
  // allowlisted — EVERY entry in recipient.txt must be allowed, not just the primary
  // one. Checking `primary.some(r => allowed.has(r))` PASSED as soon as any single
  // entry matched, even with a second, un-allowlisted recipient sitting right next to
  // it — reporting doctor as healthy for a setup where the very next plain snapshot
  // would refuse to run (Codex review, #333).
  //
  // Caught locally (#742), not left to propagate: an unreadable/non-regular
  // recipient.txt here must FAIL just this one sub-check, not throw away the
  // pin-recipients-config PASS already pushed onto `results` above.
  let primary: string[];
  try {
    primary = await safeRecipientEntries(RECIPIENT);
  } catch (e) {
    results.push({
      id: includedId,
      status: 'fail',
      message: `could not check ${RECIPIENT} against the CYPHER_BRAIN_PIN_RECIPIENTS allowlist: ${errMsg(e)}`,
    });
    return results;
  }
  const notAllowed = primary.filter((r) => !allowed.has(r));
  if (notAllowed.length > 0) {
    results.push({
      id: includedId,
      status: 'warn',
      message: `${notAllowed.length} of ${primary.length} recipient(s) in ${RECIPIENT} are NOT in the CYPHER_BRAIN_PIN_RECIPIENTS allowlist (${notAllowed.join(', ')}) — snapshot() requires EVERY effective recipient to be allowlisted, so a plain "cypher-brain snapshot" with no --recipient override will be refused`,
      remediation:
        'add the missing recipient(s) to the allowlist, remove them from recipient.txt, or always pass --recipient with a pinned key',
    });
  } else {
    results.push({
      id: includedId,
      status: 'pass',
      message: 'every recipient in the primary recipient.txt is included in the CYPHER_BRAIN_PIN_RECIPIENTS allowlist',
    });
  }
  return results;
}

// #820: the MCP server's `snapshot_now` tool is fail-closed on two OPERATOR-set
// environment variables (assertSnapshotPolicy() in src/mcp.ts) — CYPHER_BRAIN_PIN_RECIPIENTS
// (mandatory for every call) and CYPHER_BRAIN_MCP_SOURCE_ROOTS (mandatory for any call
// naming `dirs`; a pg-only call needs no roots). Neither of doctor's existing checks said
// so: pin-recipients-config (#101) only covers the CLI's own snapshot() allowlist gate,
// never mentions MCP at all, and nothing here ever read CYPHER_BRAIN_MCP_SOURCE_ROOTS —
// so an operator running `cypher-brain-mcp` for the first time could see a clean doctor
// report and still have every snapshot_now call refused with CB-E025 the moment they tried
// it. This is WARN, not FAIL: a CLI-only setup is a completely normal, healthy state.
//
// SKIP, not WARN, on a machine with no identity yet at all — doctor's whole premise is
// inspecting an EXISTING setup (module doc comment above), and test (a)'s own invariant
// ("a not-yet-set-up home: every check SKIPs") is exactly that: a fresh checkout that has
// never run `keygen`/`init` has nothing to protect over MCP yet either, and nagging about
// an MCP policy before there is even a key to pin would be noise, not signal, on top of
// every OTHER check already reporting SKIP for the identical reason. Once an identity
// exists, this repo has something worth protecting, and that is when an unconfigured MCP
// policy becomes worth a WARN — "doctor has no way to tell whether this machine runs
// cypher-brain-mcp at all" only holds AFTER that point; before it, there is nothing to run
// the server against regardless.
async function checkMcpSnapshotPolicy(): Promise<DoctorCheck> {
  const id = 'mcp-snapshot-policy';
  if (!(await exists(IDENTITY))) {
    return { id, status: 'skip', message: 'no identity yet — nothing to protect over MCP yet' };
  }
  // Multi-model review: checking CYPHER_BRAIN_PIN_RECIPIENTS for non-emptiness alone
  // would PASS a value that resolves to zero usable age1… keys (a typo, a file that
  // exists but is empty/fully commented out) — exactly the case assertSnapshotPolicy()
  // in src/mcp.ts itself refuses on ("resolves to no age1… pubkeys"). Reuse the SAME
  // resolvePinnedRecipients() that check (and pin-recipients-config, above) already use,
  // so this cannot disagree with either about what counts as "usable".
  let pinMissing: boolean;
  if (PIN_RECIPIENTS === undefined || PIN_RECIPIENTS.trim() === '') {
    pinMissing = true;
  } else {
    try {
      pinMissing = (await resolvePinnedRecipients(PIN_RECIPIENTS)).size === 0;
    } catch {
      // Unreadable/unparsable — the dedicated pin-recipients-config check above already
      // reports the specific reason; here it is enough to know MCP would refuse too.
      pinMissing = true;
    }
  }
  const rootsMissing = MCP_SOURCE_ROOTS_ERROR !== null || MCP_SOURCE_ROOTS.length === 0;
  if (pinMissing || rootsMissing) {
    const reasons: string[] = [];
    if (pinMissing) reasons.push('CYPHER_BRAIN_PIN_RECIPIENTS is not set (or resolves to no usable age1… key)');
    if (MCP_SOURCE_ROOTS_ERROR)
      reasons.push(`CYPHER_BRAIN_MCP_SOURCE_ROOTS is malformed: ${MCP_SOURCE_ROOTS_ERROR.message}`);
    else if (MCP_SOURCE_ROOTS.length === 0) reasons.push('CYPHER_BRAIN_MCP_SOURCE_ROOTS is not set');
    // Multi-model review: CYPHER_BRAIN_PIN_RECIPIENTS gates EVERY snapshot_now call, but
    // CYPHER_BRAIN_MCP_SOURCE_ROOTS only gates a call that names `dirs` — a pinned,
    // pg-only MCP setup needs no roots at all (assertSnapshotPolicy()'s own "## 2." doc
    // comment). The lead sentence below (kept verbatim — selftest-doctor.sh asserts it)
    // would otherwise overstate the roots half for that legitimate configuration; this
    // trailing clause corrects it without changing which case WARNs.
    const rootsCaveat =
      !pinMissing && rootsMissing
        ? ' A pinned, pg-only snapshot_now call needs no roots at all and is unaffected by this.'
        : '';
    return {
      id,
      status: 'warn',
      message:
        'MCP snapshot_now will refuse until CYPHER_BRAIN_PIN_RECIPIENTS and CYPHER_BRAIN_MCP_SOURCE_ROOTS are ' +
        `set (#800) — ${reasons.join('; ')}. CLI-only users (never running cypher-brain-mcp) are unaffected.` +
        rootsCaveat,
      remediation:
        'If you run the MCP server: set both variables in its environment and restart it — see MANAGEMENT.md ' +
        '("MCP snapshot policy"). If you never run the MCP server, this is safe to ignore.',
    };
  }
  // Both configured and syntactically valid (MCP_SOURCE_ROOTS_ERROR === null): also check
  // each root actually exists on disk. Since #838 (#841) assertSnapshotPolicy() requires
  // every configured root to exist as a directory and refuses EVERY `dirs` call otherwise
  // (fail closed — it no longer falls back to the nearest existing ancestor), so a typo'd
  // root means every snapshot_now call with `dirs` is refused (pg-only calls still run).
  // Surfacing that here, rather than
  // leaving it to be discovered the first time a legitimate `dirs` call is refused.
  const missing: string[] = [];
  for (const root of MCP_SOURCE_ROOTS) {
    if (!(await exists(root))) missing.push(root);
  }
  if (missing.length > 0) {
    return {
      id,
      status: 'warn',
      message:
        `CYPHER_BRAIN_MCP_SOURCE_ROOTS names ${missing.length} of ${MCP_SOURCE_ROOTS.length} root(s) that do not ` +
        `exist on disk (${missing.join(', ')}) — snapshot_now refuses every dirs call while any configured root ` +
        'is missing (fail closed, #838); pg-only calls are unaffected. Fix the path before relying on MCP snapshots.',
      remediation: `Fix the missing path(s) in CYPHER_BRAIN_MCP_SOURCE_ROOTS, or create the directory/directories.`,
    };
  }
  return {
    id,
    status: 'pass',
    message: `CYPHER_BRAIN_PIN_RECIPIENTS is set and CYPHER_BRAIN_MCP_SOURCE_ROOTS resolves to ${MCP_SOURCE_ROOTS.length} existing root(s) — MCP snapshot_now is configured (#800)`,
  };
}

// #99's fix was UX-only (the `init` wizard warns "same disk unless you change this" and
// suggests a default path) — there is no enforced separation, so this can only ever
// check the wizard's OWN suggested default (`${HOME}-backup`, wizard.ts's
// defaultBackupHome); a backup keypair generated at a custom path is invisible here.
const DEFAULT_BACKUP_HOME = `${HOME}-backup`;

async function checkOfflineBackupDisk(): Promise<DoctorCheck> {
  const id = 'offline-backup-different-disk';
  const backupIdentity = join(DEFAULT_BACKUP_HOME, 'identity.age');
  let homeStat: Stats | null;
  let backupStat: Stats | null;
  try {
    // Stat IDENTITY itself, not HOME: the message below (and the whole point of this
    // check) is comparing the PRIMARY IDENTITY's disk against the backup's, and while
    // identity.age normally sits directly under HOME (same device either way), a HOME
    // whose identity.age is itself a symlink onto another filesystem would make the
    // two diverge — stat'ing HOME would then compare the wrong device (Codex review).
    [homeStat, backupStat] = await Promise.all([statOrNotFound(IDENTITY), statOrNotFound(backupIdentity)]);
  } catch (e) {
    return { id, status: 'fail', message: `could not check ${backupIdentity} against ${HOME}: ${errMsg(e)}` };
  }
  if (!homeStat || !backupStat) {
    return {
      id,
      status: 'skip',
      message: `no offline backup keypair found at the default location (${backupIdentity}) — this check only recognizes the 'init' wizard's suggested default path; a custom path is not detectable`,
    };
  }
  // st_dev is a FILESYSTEM/mount id, not a physical-disk id: two different partitions
  // on ONE physical disk get two different st_dev values just as two different disks
  // do, so a difference here is not proof of separate hardware — and, in the other
  // direction, bind mounts can make the same filesystem show up under two paths with
  // the SAME st_dev. Both directions are worded as a signal, not a guarantee (Codex
  // review, #333: the original wording claimed "different disk"/"same disk" outright).
  if (homeStat.dev === backupStat.dev) {
    return {
      id,
      status: 'warn',
      message: `the offline backup keypair (${backupIdentity}) reports the SAME filesystem/device id as the primary identity (${IDENTITY}) — likely the same disk (though a device id alone cannot rule out separate physical disks sharing one mount)`,
      remediation: `move ${DEFAULT_BACKUP_HOME} to a different disk or machine (e.g. an encrypted USB drive kept off-box)`,
    };
  }
  return {
    id,
    status: 'pass',
    message:
      'the offline backup keypair reports a different filesystem/device id than the primary identity (a reasonable, but not airtight, signal that they are on different disks)',
  };
}

// #456: doctor's own --help has always advertised CYPHER_BRAIN_AUDIT_LOG in its
// Storage/env section, so a reasonable user assumes doctor would surface a broken hash
// chain here — but until now nothing ever read the log at all, so doctor could report a
// healthy 100/100 in the very same $CYPHER_BRAIN_HOME where `cypher-brain audit` reports
// VERDICT: FAIL. Reuses audit.ts's OWN readAuditLog()/verifyAuditChain() (never
// re-implements the hash-chain math here) and mirrors its `audit()` command's exact
// overallOk computation, so this check can never disagree with what `cypher-brain audit`
// itself reports — same "reuse the source of truth" posture checkSchedule() already
// takes toward scheduleStatusReport(). No log yet (a machine that has never run
// push/restore/verify) is a normal, not-yet-used state, same posture the other
// optional-until-used checks above take — SKIP, not WARN/FAIL.
async function checkAuditChain(): Promise<DoctorCheck> {
  const id = 'audit-chain-integrity';
  let entries: Awaited<ReturnType<typeof readAuditLog>>['entries'];
  let skippedLines: number;
  try {
    ({ entries, skippedLines } = await readAuditLog());
  } catch (e) {
    return {
      id,
      status: 'fail',
      message: `could not read the audit log at ${AUDIT_LOG}: ${errMsg(e)}`,
      remediation: `check that every path component of ${AUDIT_LOG} is accessible, or run 'cypher-brain audit' directly for more detail`,
    };
  }
  // Deliberately NOT the same "explicit path, nothing there = FAIL" convention
  // checkKeyPerms()'s explicitPath does for a user-supplied wallet/identity path (Codex
  // review): those are key material the user must have generated BEFORE pointing an env
  // var at them, so an explicit path with nothing there is itself a misconfiguration.
  // AUDIT_LOG/RECEIPT_LEDGER are the OPPOSITE — CLI-WRITTEN artifacts (appendAuditEntry/
  // appendReceipt create them on first push/restore/verify via mkdir+append) — pointing
  // CYPHER_BRAIN_AUDIT_LOG at a custom path BEFORE ever running one of those commands is
  // a completely ordinary, forward-looking setup, indistinguishable from (and no less
  // valid than) the default path never having been used yet. Also deliberately does NOT
  // try to distinguish "file never existed" from "file exists but is fully empty"
  // (Codex review, Suggestion): verifyAuditChain() itself treats a zero-entry chain as
  // trivially ok, and audit.ts's own header comment documents a full truncation of the
  // log as an ACCEPTED, undetectable-by-design limitation of the underlying mechanism
  // (only an in-place edit or a middle-of-the-log deletion breaks the hash chain) — this
  // check must never claim to catch more than `cypher-brain audit` itself can.
  if (entries.length === 0 && skippedLines === 0) {
    return {
      id,
      status: 'skip',
      message: `no audit log yet at ${AUDIT_LOG} — nothing has run push/restore/verify on this machine yet`,
    };
  }
  const result = verifyAuditChain(entries);
  // Same "any skipped line is a POSSIBLE tamper, not a benign gap" reasoning audit.ts's
  // own audit() command documents (Codex review, #226): a deleted/corrupted entry
  // vanishes from `entries` entirely rather than show up as a broken link, so
  // result.ok alone is not sufficient here either.
  const overallOk = result.ok && skippedLines === 0;
  if (overallOk) {
    return {
      id,
      status: 'pass',
      message: `audit log hash chain verifies (${result.totalEntries} ${result.totalEntries === 1 ? 'entry' : 'entries'})`,
    };
  }
  const reasons: string[] = [];
  if (!result.ok) reasons.push(`chain broken at entry index ${result.brokenAtIndex}`);
  if (skippedLines > 0) reasons.push(`${skippedLines} unreadable line(s) could hide a deleted/altered entry`);
  return {
    id,
    status: 'fail',
    message: `audit log integrity check failed: ${reasons.join('; ')}`,
    remediation: `run 'cypher-brain audit' for full detail — this is a possible tamper of ${AUDIT_LOG} and should be investigated before trusting further push/restore/verify history`,
  };
}

// #456, the receipt-ledger half: reuses receipt.ts's OWN readReceipts() rather than
// re-parsing the ledger here. Unlike the audit log, an unreadable receipt-ledger line is
// a DATA-QUALITY problem — ledger.ts's own cumulative totals may undercount actual spend
// (its --json already surfaces this as `skipped_lines`) — not evidence of a broken
// security boundary the way a broken hash chain is, so this WARNs rather than FAILs. No
// ledger yet (a machine that has never done a paid arweave/turbo push) is a normal,
// not-yet-used state — SKIP, same posture the audit-chain check above takes.
async function checkReceiptLedger(): Promise<DoctorCheck> {
  const id = 'receipt-ledger-readability';
  let receipts: Awaited<ReturnType<typeof readReceipts>>['receipts'];
  let skippedLines: number;
  try {
    ({ receipts, skippedLines } = await readReceipts());
  } catch (e) {
    return {
      id,
      status: 'fail',
      message: `could not read the receipt ledger at ${RECEIPT_LEDGER}: ${errMsg(e)}`,
      remediation: `check that every path component of ${RECEIPT_LEDGER} is accessible, or run 'cypher-brain ledger' directly for more detail`,
    };
  }
  if (receipts.length === 0 && skippedLines === 0) {
    return {
      id,
      status: 'skip',
      message: `no receipt ledger yet at ${RECEIPT_LEDGER} — no paid (arweave/turbo) push has run on this machine yet`,
    };
  }
  if (skippedLines > 0) {
    return {
      id,
      status: 'warn',
      message: `${skippedLines} unreadable line(s) in the receipt ledger (${RECEIPT_LEDGER}) — 'cypher-brain ledger' totals may undercount actual spend`,
      remediation: `run 'cypher-brain ledger' for detail, or inspect ${RECEIPT_LEDGER} directly for the malformed line(s)`,
    };
  }
  return {
    id,
    status: 'pass',
    message: `receipt ledger is readable (${receipts.length} receipt${receipts.length === 1 ? '' : 's'})`,
  };
}

// How long an unsettled pending-spend intent is treated as "still in flight" rather than
// stale (#808). It has to cover the whole of one put()'s confirm-then-record stretch —
// waitForContractActive()'s on-chain poll plus persistReceipt()'s hash of a brain-sized
// ciphertext — because a doctor run alongside a live push must not report that push's own
// in-progress intent as a lost spend. It does NOT have to cover notify: the intent is
// settled BEFORE notifyProviderWithRetry() runs. Generous rather than tight, since the
// cost of waiting is a delayed report and the cost of being early is a false alarm on the
// one check whose whole value is that it only fires on something real.
const PENDING_SPEND_STALE_MS = 30 * 60 * 1000; // 30 minutes

function describeIntent(i: SpendIntentRecord): string {
  const amount = i.amount_nano ? `${i.amount_nano} nanoTON` : 'an unrecorded amount';
  return `${i.contract_address} (${amount}, ${i.state}, recorded ${i.timestamp})`;
}

// #808: a ton-provider deploy writes a pending-spend intent BEFORE it broadcasts and
// settles it only once the receipt is verifiably in the ledger. An intent still unsettled
// long afterwards is therefore one of exactly two things, and both are worth an
// operator's attention:
//
//   - `confirmed` — the contract went live, so the money IS gone, and the receipt never
//     reached disk. `ledger`/`audit` totals understate real spend by this amount until a
//     later push of the same artifact writes the missing receipt (ton-provider.ts's
//     already-active branch does that automatically).
//   - `pending` — the transfer was broadcast and this machine never saw it confirm. That
//     is the #822 uncertain-spend case exactly: only an operator looking at the contract
//     address on an explorer can say whether the funds moved.
//
// WARN, never FAIL: nothing here is insecure or broken, and both states resolve — one by
// pushing the same artifact again, one by looking. A FAIL would also flip `verify`-style
// exit codes for what is, at worst, an incomplete cost record.
async function checkPendingSpends(): Promise<DoctorCheck> {
  const id = 'pending-spend-intents';
  let intents: SpendIntentRecord[];
  let skippedLines: number;
  try {
    ({ intents, skippedLines } = await readSpendIntents());
  } catch (e) {
    return {
      id,
      status: 'fail',
      message: `could not read the pending-spend log at ${PENDING_SPENDS_LOG}: ${errMsg(e)}`,
      remediation: `check that every path component of ${PENDING_SPENDS_LOG} is accessible — while it cannot be read, a confirmed-but-unrecorded spend cannot be detected at all`,
    };
  }
  const cutoff = Date.now() - PENDING_SPEND_STALE_MS;
  const stale = intents.filter((i) => isUnsettled(i) && !(Date.parse(i.updated_at) > cutoff));
  if (skippedLines > 0) {
    return {
      id,
      status: 'warn',
      message: `${skippedLines} unreadable line(s) in the pending-spend log (${PENDING_SPENDS_LOG})${stale.length ? `, alongside ${stale.length} stale intent(s)` : ''} — an unrecorded ton-provider spend could be hiding in them`,
      remediation: `inspect ${PENDING_SPENDS_LOG} directly for the malformed line(s); each readable line names the contract address to check on a TON explorer`,
    };
  }
  if (intents.length === 0) {
    return {
      id,
      status: 'skip',
      message: `no pending-spend log yet at ${PENDING_SPENDS_LOG} — no ton-provider push has run on this machine yet`,
    };
  }
  if (stale.length === 0) {
    return {
      id,
      status: 'pass',
      message: `every recorded ton-provider spend is settled against the receipt ledger (${intents.length} intent${intents.length === 1 ? '' : 's'})`,
    };
  }
  const unconfirmed = stale.filter((i) => i.state === 'pending').length;
  const listed = stale.slice(0, 3).map(describeIntent).join('; ');
  const more = stale.length > 3 ? `; and ${stale.length - 3} more` : '';
  return {
    id,
    status: 'warn',
    message:
      `${stale.length} ton-provider spend(s) recorded but never settled: ${listed}${more}` +
      (unconfirmed > 0
        ? ` — ${unconfirmed} of them never confirmed on-chain from this machine, so whether the funds moved is UNKNOWN`
        : ' — the funds moved; the receipt ledger is short by them'),
    remediation:
      "re-run 'cypher-brain push' for the same artifact (the already-active branch writes the missing receipt and settles the record), and check each 'pending' contract address on a TON explorer first — that state means this machine never saw the transfer confirm",
  };
}

// #542: detectGbrainEngine() (gbrain.ts, #367) was, until now, wired ONLY into the init
// wizard's one-time snapshot-source prompt — and `init` itself refuses to rerun once an
// identity already exists, so a gbrain install that later CHANGES engine (e.g. migrates
// PGLite -> Postgres, or the reverse) left the operator with no way to notice their
// init-time --pg answer had gone stale, short of re-reading the wizard's own source. This
// surfaces the SAME detection standalone, re-checkable on every doctor run.
//
// Deliberately informational: PASS-with-note for a genuine detection, WARN (never FAIL)
// for an unreadable config — there is nothing insecure about ANY detected engine, this is
// a heads-up, not a health problem the other checks above are. Standalone, not
// cross-referenced against an installed schedule's own --pg flag (the issue's own
// suggested fallback when wiring that in is too invasive): schedule.ts's ScheduleConfig
// keeps `pg` (a connection string, which can embed a credential) out of its public
// ScheduleStatusReport entirely — see that type's own "names only, never values" posture
// on `config_file.variables` — so reaching in for it here would be new, privileged
// plumbing this check does not need to do its job.
// #811: a `keygen --force`/`keygen --sign --force` run about to replace an EXISTING
// identity now backs it up first, unconditionally, as a sibling `<path>.bak-<timestamp>-
// <random>` file (backupIdentityFile() in keys.ts, shared by keygenAt() for the age
// identity and keygenSignAt() in minisign.ts for the signing identity — same mechanism,
// same file-naming convention, so this check scans for both). That backup is exactly
// what makes a --force run non-destructive, but nothing ever tells the operator these
// files pile up on disk, one per --force run, forever — this surfaces the count so they
// do not go unnoticed indefinitely.
//
// WARN, not FAIL: an accumulating backup is a housekeeping note, not a security problem
// (each one is written at mode 0600, same posture as the identity it copies) — the
// remediation is "clean these up when you no longer need them", not "fix this now".
// The oldest mtime (epoch ms) among `names` under `dir`, or Infinity if none stat'd
// successfully (an unreadable/vanished file between readdir() and stat() is skipped
// rather than failing the whole check — the count from readdir() already reflects it).
async function oldestMtimeMs(dir: string, names: readonly string[]): Promise<number> {
  let oldestMs = Infinity;
  for (const name of names) {
    const st = await stat(join(dir, name)).catch(() => null);
    if (st && st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
  }
  return oldestMs;
}

async function checkIdentityBackups(): Promise<DoctorCheck> {
  const id = 'identity-backup-accumulation';
  const dir = HOME;
  const agePrefix = `${IDENTITY.slice(dir.length + 1)}.bak-`;
  const signPrefix = `${SIGN_IDENTITY.slice(dir.length + 1)}.bak-`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { id, status: 'skip', message: 'no identity backup files (no CYPHER_BRAIN_HOME yet)' };
    return { id, status: 'fail', message: `could not list ${dir} to check for identity backup files: ${errMsg(e)}` };
  }
  const ageBackups = entries.filter((name) => name.startsWith(agePrefix));
  const signBackups = entries.filter((name) => name.startsWith(signPrefix));
  const total = ageBackups.length + signBackups.length;
  if (total === 0) {
    return {
      id,
      status: 'skip',
      message: 'no identity backup files (identity.age.bak-*/sign-identity.key.bak-*) found',
    };
  }
  const oldestMs = Math.min(await oldestMtimeMs(dir, ageBackups), await oldestMtimeMs(dir, signBackups));
  const oldest = Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString().slice(0, 10) : 'unknown date';
  // Multi-model review: age-identity and signing-identity backups preserve DIFFERENT
  // things — an identity.age backup is a decryption key (safe to delete once every
  // snapshot it could decrypt has been re-encrypted), a sign-identity.key backup is an
  // AUTHENTICITY key (safe to delete once no .minisig made with it still needs
  // verifying) — reporting a single count with only the age-identity condition, as an
  // earlier version of this check did, would misstate the reason for a sign-identity
  // backup whenever one exists.
  const conditions: string[] = [];
  if (ageBackups.length > 0) {
    conditions.push(
      `the ${ageBackups.length} age identity backup(s) (identity.age.bak-*) are safe to delete once every ` +
        'snapshot encrypted to the OLD recipient each preserves has been re-encrypted to the current identity, ' +
        'or is no longer needed',
    );
  }
  if (signBackups.length > 0) {
    conditions.push(
      `the ${signBackups.length} signing identity backup(s) (sign-identity.key.bak-*) are safe to delete once ` +
        'no .minisig signature made with that OLD signing key still needs verifying (everything has been ' +
        're-signed with the current one, or is no longer needed)',
    );
  }
  return {
    id,
    status: 'warn',
    message:
      `${total} identity backup file(s) from past 'keygen --force'/'keygen --sign --force' runs are sitting in ` +
      `${dir} (oldest: ${oldest}) — ${conditions.join('; ')} (MANAGEMENT.md "Cleaning up identity backups", #811).`,
    remediation: `review and 'rm' the ones you no longer need — each is named <original>.bak-<timestamp>-<random> under ${dir}`,
  };
}

async function checkGbrainEngine(): Promise<DoctorCheck> {
  const id = 'gbrain-engine-detection';
  const { path: gbrainConfigPath, invalidOverride } = resolveGbrainConfigPath();
  if (invalidOverride) {
    // GBRAIN_HOME is set but invalid (see resolveGbrainConfigPath's own doc comment) —
    // gbrain itself will refuse to start with it, so a PASS below on whatever the
    // ~/.gbrain fallback finds would be a false "this works" (it may just be a stale
    // config from before GBRAIN_HOME was set). WARN, never FAIL, matching this check's
    // own informational posture elsewhere.
    return {
      id,
      status: 'warn',
      message: `GBRAIN_HOME="${process.env.GBRAIN_HOME}" is invalid (must be an absolute path with no '..' segments) — gbrain itself refuses to start with this value; the default ${gbrainConfigPath} was checked instead, but gbrain will NOT actually use it until GBRAIN_HOME is fixed or unset`,
      remediation: `fix GBRAIN_HOME to an absolute path with no '..' segments, or unset it to use the default ~/.gbrain`,
    };
  }
  if (!(await exists(gbrainConfigPath))) {
    return {
      id,
      status: 'skip',
      message: `no gbrain config found at ${gbrainConfigPath} — gbrain is not set up on this machine`,
    };
  }
  const gbrain = await detectGbrainEngine(gbrainConfigPath);
  if (gbrain.readError) {
    return {
      id,
      status: 'warn',
      message: `gbrain config at ${gbrainConfigPath} could not be read — its engine could not be determined (defaulted to postgres for any --pg decision); if this machine actually runs PGLite, that default is wrong until the config is fixed`,
      remediation: `inspect ${gbrainConfigPath} by hand — it should be valid JSON with an "engine" field ("pglite" or "postgres")`,
    };
  }
  if (gbrain.engine === 'pglite') {
    const where = gbrain.dataPath
      ? `store recorded at ${gbrain.dataPath}`
      : gbrain.relativeDataPath
        ? `store recorded as a relative path (${gbrain.relativeDataPath}) — its real location cannot be resolved from here`
        : 'no database_path recorded — its location cannot be told from here';
    return {
      id,
      status: 'pass',
      message: `gbrain engine: PGLite (${where}) — no Postgres dump is needed; back up the directory itself`,
    };
  }
  return {
    id,
    status: 'pass',
    message: `gbrain engine: Postgres — a "cypher-brain snapshot --pg <connection string>" is needed to include gbrain's actual data in a backup`,
  };
}

// How old is the code that is actually running (#348)? The real incident: a
// hand-copied dist ran the snapshot host for 5+ weeks, silently missing documented
// features — nothing surfaced its age, and the version string (0.0.1 on every build to
// date) cannot. The age is ALWAYS in the message — the incident build was 39 days old,
// under any sane warn threshold, and the visible line is what would have caught it;
// WARN fires only at real drift (~3 missed monthly-push cycles). No network: comparing
// against a "latest release" is deferred until releases exist to compare against
// (#144) — a probe of an endpoint that answers 404 today would be untestable
// against reality.
function checkBuildProvenance(): DoctorCheck {
  const info = buildInfo();
  if (info === null) {
    return {
      id: 'build-provenance',
      status: 'skip',
      message:
        'build provenance unknown — this build predates the #348 stamp, or was built/run without git; ' +
        'rebuild from a git checkout (`npm run build`) to get a stamped dist',
    };
  }
  const age = buildAgeDays(info.commit_date, Date.now());
  const label =
    `${info.source === 'stamped' ? 'built from' : 'running source at'} commit ${info.commit.slice(0, 12)}` +
    `${info.dirty ? ' (+uncommitted changes)' : ''}, committed ${info.commit_date.slice(0, 10)}`;
  // A stamp whose date cannot be parsed is NOT healthy: assessing the build's age is
  // this check's entire job, and "pass" on garbage would be the same false green light
  // doctor exists to remove (Codex review).
  if (age === null) {
    return {
      id: 'build-provenance',
      status: 'warn',
      message: `${label} — the stamped commit date is unparseable, so the build's age cannot be assessed`,
      remediation: 'rebuild dist from a current git checkout (`npm run build`) to get a well-formed stamp',
    };
  }
  if (age >= BUILD_STALE_DAYS) {
    return {
      id: 'build-provenance',
      status: 'warn',
      message: `${label} (${age} day(s) ago) — ${BUILD_STALE_DAYS}+ days old`,
      remediation:
        'this deployment has drifted well behind development; rebuild and redeploy dist/cli.mjs from a current checkout',
    };
  }
  return { id: 'build-provenance', status: 'pass', message: `${label} (${age} day(s) ago)` };
}

// Reuses schedule.ts's OWN status computation (scheduleStatusReport) rather than
// re-parsing logs itself, so this can never disagree with `cypher-brain schedule
// status` about what the last run did.
async function checkSchedule(): Promise<DoctorCheck[]> {
  let report: Awaited<ReturnType<typeof scheduleStatusReport>>;
  try {
    report = await scheduleStatusReport();
  } catch (e) {
    if (e instanceof ScheduleNotInstalledError) {
      return [
        {
          id: 'schedule-last-run',
          status: 'skip',
          message:
            'no schedule installed (optional) — run "cypher-brain schedule install" to automate nightly snapshots',
        },
      ];
    }
    // Anything else — a corrupt schedule.json, a crontab/launchctl call that itself
    // errored — is a REAL problem with an EXISTING schedule setup, not "nothing
    // installed"; the original catch-all folded every exception into the same skip a
    // fresh machine gets, which would hide it (Codex review, #333).
    return [
      {
        id: 'schedule-last-run',
        status: 'fail',
        message: `could not read the installed schedule's status: ${errMsg(e)}`,
        remediation:
          'run "cypher-brain schedule status" directly for more detail, or "cypher-brain schedule install" again if the config looks corrupt',
      },
    ];
  }
  const results: DoctorCheck[] = [];
  if (!report.last_run) {
    results.push({ id: 'schedule-last-run', status: 'pass', message: 'schedule installed, no runs recorded yet' });
  } else if (report.last_run.rc_line.startsWith('FAILED')) {
    results.push({
      id: 'schedule-last-run',
      status: 'fail',
      message: `last scheduled run (${report.last_run.log}) failed: ${report.last_run.rc_line}`,
      remediation: `inspect ${report.last_run.log} in the schedule's logs directory for the cause, fix it, then confirm with a manual snapshot+push before trusting the next unattended run`,
    });
  } else if (report.last_run.rc_line.startsWith('OK')) {
    // #432: an OK exit code says the pipeline didn't error — it says nothing about
    // whether the run itself flagged something a human needs to see (e.g. "snapshot
    // encrypted to a SINGLE recipient key — UNRECOVERABLE"). warning_count is read
    // back from the SAME rc_line (schedule.ts's lastLog()). `null` is genuinely
    // UNKNOWN (an old-format log from before #432 that never recorded a count) — NOT
    // the same as a real, counted `0` — so it gets its OWN warn branch rather than
    // silently falling into the same `if (falsy)` bucket as zero (Codex review round
    // 3: doing that would give false assurance for an old log that may well have had
    // warnings this doctor simply cannot see).
    if (report.last_run.warning_count === null) {
      results.push({
        id: 'schedule-last-run',
        status: 'warn',
        message: `last scheduled run (${report.last_run.log}) succeeded (${report.last_run.rc_line}), but this log predates warning-count tracking (#432) — this doctor cannot tell whether it recorded any warnings a human should see`,
        remediation: `inspect ${report.last_run.log} directly for a "run summary" block, or wait for the next scheduled run (its trailing line will carry warnings=N going forward)`,
      });
    } else if (report.last_run.warning_count > 0) {
      results.push({
        id: 'schedule-last-run',
        status: 'warn',
        message: `last scheduled run (${report.last_run.log}) succeeded but recorded ${report.last_run.warning_count} warning(s) a human should see: ${report.last_run.rc_line}`,
        remediation: `inspect ${report.last_run.log} in the schedule's logs directory — its run summary block names each warning`,
      });
    } else {
      results.push({
        id: 'schedule-last-run',
        status: 'pass',
        message: `last scheduled run (${report.last_run.log}) succeeded: ${report.last_run.rc_line}`,
      });
    }
  } else {
    // Neither "OK rc=0" nor "FAILED rc=N" — schedule.ts's own documented final-line
    // format (install()'s printed message: `final line: "OK rc=0" or "FAILED rc=N"`).
    // A truncated write or a corrupted log lands here too; the original logic treated
    // anything not starting with "FAILED" as a success, which would report a healthy
    // PASS for a line this check cannot actually vouch for (Codex review, #333).
    results.push({
      id: 'schedule-last-run',
      status: 'warn',
      message: `last scheduled run (${report.last_run.log}) ended with an unrecognized status line (${JSON.stringify(report.last_run.rc_line)}) — expected "OK rc=0" or "FAILED rc=N"; possibly a truncated or corrupted log`,
      remediation: `inspect ${report.last_run.log} directly`,
    });
  }
  if (report.trigger.loaded === 'no') {
    results.push({
      id: 'schedule-trigger-loaded',
      status: 'warn',
      message: `the ${report.trigger.type} trigger is written but not currently loaded/registered — scheduled runs will not happen`,
      remediation: 'cypher-brain schedule install (re-run with the same flags to re-register)',
    });
  } else if (report.trigger.loaded === 'unknown') {
    // Distinct from BOTH 'yes' and 'no': the loaded-check itself failed (e.g. crontab
    // errored) rather than answering either way. The original logic fell through to
    // the "registered" pass branch for anything that wasn't literally 'no' — reporting
    // confidence this check does not actually have (Codex review, #333).
    results.push({
      id: 'schedule-trigger-loaded',
      status: 'warn',
      message: `could not determine whether the ${report.trigger.type} trigger is currently loaded/registered (the check itself failed) — scheduled runs may or may not be happening`,
      remediation: 'cypher-brain schedule status for more detail, or re-run "cypher-brain schedule install" to be sure',
    });
  } else {
    results.push({
      id: 'schedule-trigger-loaded',
      status: 'pass',
      message: `the ${report.trigger.type} trigger is registered`,
    });
  }
  return results;
}

// ---------- known-vs-new bookkeeping ----------

const STATE_SCHEMA = 1;

interface DoctorStateFile {
  schema: number;
  last_run: string;
  non_passing: Record<string, { status: 'warn' | 'fail'; since: string }>;
}

const doctorStatePath = (): string => join(HOME, 'doctor-state.json');

// A structurally valid non_passing ENTRY: report assembly below reads entry.since as a
// string unconditionally (`.slice(0, 10)`) — a hand-edited or corrupted doctor-state.json
// with e.g. `"since": null` on just one entry must not crash report assembly for every
// check that already ran successfully (#763). Any entry that doesn't match this shape is
// dropped rather than accepted or used to reject the WHOLE file's history.
function isValidNonPassingEntry(v: unknown): v is DoctorStateFile['non_passing'][string] {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (e.status === 'warn' || e.status === 'fail') && typeof e.since === 'string' && e.since.length > 0;
}

async function loadDoctorState(statePath: string): Promise<DoctorStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<DoctorStateFile>;
    if (parsed.schema !== STATE_SCHEMA || typeof parsed.non_passing !== 'object' || parsed.non_passing === null) {
      return null; // unknown/corrupt shape — treat as "no history" rather than guessing
    }
    // Validate every entry INDEPENDENTLY (#763) rather than trusting the object shape
    // check above to mean every value inside it is well-formed too.
    const non_passing: DoctorStateFile['non_passing'] = {};
    for (const [id, entry] of Object.entries(parsed.non_passing)) {
      if (isValidNonPassingEntry(entry)) non_passing[id] = entry;
    }
    return {
      schema: STATE_SCHEMA,
      last_run: typeof parsed.last_run === 'string' ? parsed.last_run : '',
      non_passing,
    };
  } catch {
    return null; // missing (first-ever run) or unreadable
  }
}

async function saveDoctorState(
  statePath: string,
  nonPassing: DoctorStateFile['non_passing'],
  nowIso: string,
): Promise<boolean> {
  if (!(await exists(HOME))) return false; // never create HOME just to leave this file behind
  const body: DoctorStateFile = { schema: STATE_SCHEMA, last_run: nowIso, non_passing: nonPassing };
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  // Exclusive-create-then-rename — the SAME no-clobber write technique keys.ts's
  // writeKeyFile() and wizard.ts's recovery-kit write already use for this codebase's
  // other durable writes — instead of a plain writeFile() straight at the predictable
  // doctor-state.json path. writeFile() truncates and writes THROUGH an existing
  // symlink; rename() instead atomically replaces the directory ENTRY at statePath,
  // whatever it was, so a symlink planted there (e.g. by another user able to write
  // into a group/world-writable CYPHER_BRAIN_HOME — exactly what home-dir-perms exists
  // to catch) cannot redirect this write into overwriting an arbitrary file (Codex
  // review, #333).
  const tmp = `${statePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, payload, { mode: 0o644, flag: 'wx' });
    await rename(tmp, statePath);
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return false; // best-effort: a read-only CYPHER_BRAIN_HOME still gets a full report
  }
}

// ---------- report assembly + printing ----------

const STATUS_TAG: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };

// Every line below can embed a value this process does not fully control — an
// environment variable a check echoes back verbatim (e.g. GBRAIN_HOME), a path built
// from one, a recipient string read from a file the operator (or, on a shared/
// compromised machine, someone else) wrote. --json output already can't be abused this
// way: JSON.stringify() never emits a literal control character, so an embedded
// newline or ANSI escape sequence shows up escaped, not literally. This is the plain
// renderer's equivalent (#764): a raw newline could forge a convincing extra
// "[PASS] forged-health" line, and a raw ANSI escape sequence (ESC = \x1b, always a C0
// control character) could redraw or clear whatever is already on screen. Collapse
// newlines to a space so the line stays readable, then strip every other C0/DEL
// character outright — none should ever appear in a genuine message.
function sanitizeForPlainText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
}

function printDoctorReport(report: DoctorReport): void {
  console.log('cypher-brain doctor — environment health check\n');
  for (const c of report.checks) {
    const marker =
      c.marker === 'new'
        ? ' \u{1F195} new'
        : c.marker === 'carryover'
          ? ` (known since ${(c.since ?? '').slice(0, 10)})`
          : '';
    console.log(sanitizeForPlainText(`[${STATUS_TAG[c.status]}]${marker} ${c.message}`));
    if (c.remediation) console.log(sanitizeForPlainText(`         remediation: ${c.remediation}`));
  }
  if (report.resolved.length > 0) {
    console.log('\nResolved since last run:');
    for (const r of report.resolved) console.log(sanitizeForPlainText(`  [RESOLVED] ${r.message}`));
  }
  const scoreNote =
    report.new_count === 0 && report.carryover_count === 0
      ? '(no issues found)'
      : `(${report.new_count} new issue(s) counted in full; ${report.carryover_count} known, already-flagged issue(s) counted at a reduced weight — see remediation above)`;
  console.log(`\nhealth_score: ${report.health_score}/100 ${scoreNote}`);
  console.log(`VERDICT: ${report.verdict}`);
  if (!report.state_saved && (report.new_count > 0 || report.carryover_count > 0)) {
    console.log(
      sanitizeForPlainText(
        `(note: could not persist ${report.state_path} — known-vs-new tracking will not carry over to the next run)`,
      ),
    );
  }
}

// Every entry below is one INDEPENDENT check, run in isolation from every other one
// (#742): a single check's own I/O failure (a chmod'd-000 IDENTITY, a non-regular
// RECIPIENT) used to reject the `await` chain computeDoctorReport() built these from
// directly, which propagated out of the whole function — the CLI printed a raw
// top-level error instead of a DoctorReport, and every check listed AFTER the failing
// one never ran at all. `id` here is only the fallback id used if `run()` itself
// throws (checks that report more than one sub-id, like pin-recipients/schedule,
// already convert their OWN internal failures into named DoctorChecks — this is the
// last-resort net for anything that still gets through uncaught).
const CHECK_DEFS: ReadonlyArray<{
  id: string;
  run: () => DoctorCheck | DoctorCheck[] | Promise<DoctorCheck | DoctorCheck[]>;
}> = [
  { id: 'build-provenance', run: () => checkBuildProvenance() },
  { id: 'home-dir-perms', run: () => checkHomeDirPerms() },
  { id: 'identity-perms', run: () => checkKeyPerms('identity-perms', IDENTITY, 'age identity (private key)') },
  {
    id: 'sign-identity-perms',
    run: () => checkKeyPerms('sign-identity-perms', SIGN_IDENTITY, 'signing identity (private key)'),
  },
  {
    id: 'wallet-perms',
    run: () => checkKeyPerms('wallet-perms', AR_WALLET || WALLET_DEFAULT_PATH, 'arweave JWK wallet', AR_WALLET !== ''),
  },
  {
    id: 'ton-wallet-perms',
    run: () =>
      checkKeyPerms(
        'ton-wallet-perms',
        TON_WALLET || TON_WALLET_DEFAULT_PATH,
        'TON wallet mnemonic',
        TON_WALLET !== '',
        'CYPHER_BRAIN_TON_WALLET',
      ),
  },
  { id: 'identity-recipient-pairing', run: () => checkIdentityRecipientPairing() },
  { id: 'pin-recipients-config', run: () => checkPinRecipients() },
  { id: 'mcp-snapshot-policy', run: () => checkMcpSnapshotPolicy() },
  { id: 'offline-backup-different-disk', run: () => checkOfflineBackupDisk() },
  { id: 'schedule-last-run', run: () => checkSchedule() },
  { id: 'audit-chain-integrity', run: () => checkAuditChain() },
  { id: 'receipt-ledger-readability', run: () => checkReceiptLedger() },
  { id: 'pending-spend-intents', run: () => checkPendingSpends() },
  { id: 'gbrain-engine-detection', run: () => checkGbrainEngine() },
  { id: 'identity-backup-accumulation', run: () => checkIdentityBackups() },
];

export async function computeDoctorReport(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  for (const def of CHECK_DEFS) {
    try {
      const result = await def.run();
      checks.push(...(Array.isArray(result) ? result : [result]));
    } catch (e) {
      checks.push({
        id: def.id,
        status: 'fail',
        message: `the '${def.id}' check crashed unexpectedly and could not complete: ${errMsg(e)}`,
        remediation: 'this is a bug in doctor itself — please report it, including the message above',
      });
    }
  }

  const statePath = doctorStatePath();
  const prior = await loadDoctorState(statePath);
  const nowIso = new Date().toISOString();

  const results: DoctorCheckResult[] = [];
  const nextNonPassing: DoctorStateFile['non_passing'] = {};
  for (const c of checks) {
    if (c.status === 'warn' || c.status === 'fail') {
      const priorEntry = prior?.non_passing[c.id];
      const since = priorEntry?.since ?? nowIso;
      // A WARN that escalated to FAIL is treated as 'new', not 'carryover' — the health
      // score below charges carryover FAILs less than a brand-new one (10 vs. 30), and
      // this check's OWN severity genuinely got worse, which is exactly what this
      // module's scoring exists to surface (see the file header: "did anything get
      // WORSE since I last looked"). Leaving it 'carryover' would silently discount a
      // real deterioration as if it were the same already-known issue (Codex review).
      const escalated = priorEntry?.status === 'warn' && c.status === 'fail';
      nextNonPassing[c.id] = { status: c.status, since };
      results.push({ ...c, marker: priorEntry && !escalated ? 'carryover' : 'new', since });
    } else {
      results.push({ ...c, marker: null });
    }
  }

  const resolved: DoctorResolved[] = [];
  if (prior) {
    for (const [id, entry] of Object.entries(prior.non_passing)) {
      if (!(id in nextNonPassing)) {
        resolved.push({
          id,
          message: `${id}: previously ${entry.status} (since ${entry.since.slice(0, 10)}) — no longer flagged (fixed, or the check no longer applies this run)`,
        });
      }
    }
  }

  const stateSaved = await saveDoctorState(statePath, nextNonPassing, nowIso);

  // A NEW warn/fail costs more than the SAME one seen last run too — that discount (not
  // a full exclusion) is what "known issues excluded from the score" means here: a
  // lingering, already-flagged problem still pulls the score down (so a FAIL still
  // reads FAIL, never a misleading 100/100 next to VERDICT: FAIL), it just does not
  // re-trigger the FULL "something just got worse" penalty on every single run you
  // happen to check again without having fixed it yet.
  let healthScore = 100;
  let newCount = 0;
  let carryoverCount = 0;
  for (const r of results) {
    if (r.marker === 'new') {
      newCount++;
      healthScore -= r.status === 'fail' ? 30 : 10;
    } else if (r.marker === 'carryover') {
      carryoverCount++;
      healthScore -= r.status === 'fail' ? 10 : 3;
    }
  }
  healthScore = Math.max(0, healthScore);

  const anyFail = results.some((r) => r.status === 'fail');
  const anyWarn = results.some((r) => r.status === 'warn');
  const verdict: DoctorReport['verdict'] = anyFail ? 'FAIL' : anyWarn ? 'PARTIAL' : 'PASS';

  return {
    checks: results,
    resolved,
    health_score: healthScore,
    new_count: newCount,
    carryover_count: carryoverCount,
    verdict,
    state_path: statePath,
    state_saved: stateSaved,
  };
}

export async function doctor(o: CliOptions): Promise<void> {
  const report = await computeDoctorReport();
  if (o.json) {
    printJson(report);
  } else {
    printDoctorReport(report);
  }
  if (report.verdict === 'FAIL') process.exitCode = 1;
  else if (report.verdict === 'PARTIAL') process.exitCode = 2; // same convention as `verify`
  if (!o.json) printMascot(moodForVerdict(report.verdict));
}
