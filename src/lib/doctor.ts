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
import { stat, readFile, writeFile, rename, rm } from 'node:fs/promises';
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
  const actual = new Set(await recipientEntries(RECIPIENT));
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
  const primary = await recipientEntries(RECIPIENT);
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
    [homeStat, backupStat] = await Promise.all([statOrNotFound(HOME), statOrNotFound(backupIdentity)]);
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

async function loadDoctorState(statePath: string): Promise<DoctorStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<DoctorStateFile>;
    if (parsed.schema !== STATE_SCHEMA || typeof parsed.non_passing !== 'object' || parsed.non_passing === null) {
      return null; // unknown/corrupt shape — treat as "no history" rather than guessing
    }
    return parsed as DoctorStateFile;
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

function printDoctorReport(report: DoctorReport): void {
  console.log('cypher-brain doctor — environment health check\n');
  for (const c of report.checks) {
    const marker =
      c.marker === 'new'
        ? ' \u{1F195} new'
        : c.marker === 'carryover'
          ? ` (known since ${(c.since ?? '').slice(0, 10)})`
          : '';
    console.log(`[${STATUS_TAG[c.status]}]${marker} ${c.message}`);
    if (c.remediation) console.log(`         remediation: ${c.remediation}`);
  }
  if (report.resolved.length > 0) {
    console.log('\nResolved since last run:');
    for (const r of report.resolved) console.log(`  [RESOLVED] ${r.message}`);
  }
  const scoreNote =
    report.new_count === 0 && report.carryover_count === 0
      ? '(no issues found)'
      : `(${report.new_count} new issue(s) counted in full; ${report.carryover_count} known, already-flagged issue(s) counted at a reduced weight — see remediation above)`;
  console.log(`\nhealth_score: ${report.health_score}/100 ${scoreNote}`);
  console.log(`VERDICT: ${report.verdict}`);
  if (!report.state_saved && (report.new_count > 0 || report.carryover_count > 0)) {
    console.log(
      `(note: could not persist ${report.state_path} — known-vs-new tracking will not carry over to the next run)`,
    );
  }
}

export async function computeDoctorReport(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkBuildProvenance(),
    await checkHomeDirPerms(),
    await checkKeyPerms('identity-perms', IDENTITY, 'age identity (private key)'),
    await checkKeyPerms('sign-identity-perms', SIGN_IDENTITY, 'signing identity (private key)'),
    await checkKeyPerms('wallet-perms', AR_WALLET || WALLET_DEFAULT_PATH, 'arweave JWK wallet', AR_WALLET !== ''),
    await checkKeyPerms(
      'ton-wallet-perms',
      TON_WALLET || TON_WALLET_DEFAULT_PATH,
      'TON wallet mnemonic',
      TON_WALLET !== '',
      'CYPHER_BRAIN_TON_WALLET',
    ),
    await checkIdentityRecipientPairing(),
    ...(await checkPinRecipients()),
    await checkOfflineBackupDisk(),
    ...(await checkSchedule()),
    await checkAuditChain(),
    await checkReceiptLedger(),
    await checkGbrainEngine(),
  ];

  const statePath = doctorStatePath();
  const prior = await loadDoctorState(statePath);
  const nowIso = new Date().toISOString();

  const results: DoctorCheckResult[] = [];
  const nextNonPassing: DoctorStateFile['non_passing'] = {};
  for (const c of checks) {
    if (c.status === 'warn' || c.status === 'fail') {
      const priorEntry = prior?.non_passing[c.id];
      const since = priorEntry?.since ?? nowIso;
      nextNonPassing[c.id] = { status: c.status, since };
      results.push({ ...c, marker: priorEntry ? 'carryover' : 'new', since });
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
