// Hash-chain audit trail (#226, parts 1+2 merged into one mechanism): one JSONL line
// per push/restore/verify run (success OR failure), each line's hash binding it to the
// PREVIOUS line's hash. This is a LOCAL INTEGRITY check against accidental or casual
// tampering, not a cryptographically authenticated log — there is no independent,
// externally-anchored checkpoint, so a full local rewrite of the file (or a clean
// truncation from the end) is undetectable by design: same trust boundary as any other
// file under $CYPHER_BRAIN_HOME, the identity key included. What it DOES catch: an
// in-place edit of an entry, or deleting/corrupting one from the MIDDLE of the log —
// either breaks the hash chain for every entry after it. This is a DIFFERENT concept
// from receipt.ts (cost data, paid backends only) and from idempotency.ts (replay
// detection, read-modify-rename under a lock). Closest precedent is receipt.ts's
// pure-append shape: `appendFile(path, line, {flag:'a'})`, a `{entries, skippedLines}`
// read contract, ENOENT-vs-other-errors distinguished (readAuditLog() applies the SAME
// Critical-review fix receipt.ts's readReceipts() needed in #232, from the start) —
// PLUS a stricter shape check on nullable fields than receipt.ts's own (Codex review,
// Critical: coercing a wrong-typed nullable field to `null` on read let a field that
// was ALREADY `null` be tampered to any other value and silently launder back to the
// SAME `null` the stored hash was computed against; every nullable field here must be
// exactly `null` or a `string`, or the whole line is rejected).
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { AUDIT_LOG } from './config.js';
import { errMsg, readJsonlLog, sha256 } from './util.js';
import { readRecipientsFingerprint } from './plan.js';
import { printJson } from './ui.js';
import { warn } from './warn.js';
import type { CliOptions } from './types.js';

export const AUDIT_VERSION = 1;

export interface AuditEntry {
  cypher_brain_audit_version: typeof AUDIT_VERSION;
  timestamp: string; // ISO 8601 — when the entry was recorded, right after the run concluded
  command: 'push' | 'restore' | 'verify';
  backend: string | null; // null for restore/verify, which never take --backend
  locator: string | null;
  artifact_sha256: string | null;
  machine: string; // os.hostname()
  recipients_fingerprint: string | null; // best-effort, from the "<in>.recipients-fingerprint" sidecar
  exit_code: number;
  duration_ms: number;
  prev_hash: string | null; // null ONLY for the very first entry in the log
  // sha256(canonical-JSON of every OTHER field, PREV_HASH INCLUDED, fixed key order —
  // Codex review: an earlier version of this comment described a "prev_hash + JSON"
  // string-concatenation form that does not match canonicalize()'s actual behavior,
  // which serializes prev_hash as an ordinary field of the same JSON object rather
  // than prefixing it separately; internal verification was never affected since the
  // writer and reader agree, but the comment itself was wrong).
  hash: string;
}

// Canonical = a FIXED key order every process writes in, so two processes hashing the
// SAME logical entry always agree. A literal object with fields always written in this
// same order is sufficient (JSON.stringify preserves insertion order for string keys —
// nothing here has a numeric-like key, the one case where that could diverge).
function canonicalize(e: Omit<AuditEntry, 'hash'>): string {
  return JSON.stringify({
    cypher_brain_audit_version: e.cypher_brain_audit_version,
    timestamp: e.timestamp,
    command: e.command,
    backend: e.backend,
    locator: e.locator,
    artifact_sha256: e.artifact_sha256,
    machine: e.machine,
    recipients_fingerprint: e.recipients_fingerprint,
    exit_code: e.exit_code,
    duration_ms: e.duration_ms,
    prev_hash: e.prev_hash,
  });
}

// Exported (not just internal) so scripts/selftest-audit.mjs can build a tampered
// entry with a CORRECT, recomputed hash — needed to isolate "the link to the
// predecessor is wrong" from "this entry's own content changed" as two genuinely
// distinct positive controls (Codex review, Suggestion — an earlier version of that
// test changed prev_hash without recomputing the hash, so it exercised the
// content-mismatch branch either way, not the link-mismatch branch specifically).
export function computeHash(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalize(e)).digest('hex');
}

export interface ReadAuditLogResult {
  entries: AuditEntry[];
  // Lines that existed but could not be read as an entry at all (malformed JSON, wrong
  // shape, a future version) — distinct from the chain-verification concept
  // (verifyAuditChain() below): a skipped line is invisible to the chain math
  // entirely, not a "broken link" in it. Surfaced so "0 entries" can never be silently
  // confused with "N lines exist but none were readable" (same #232 lesson receipt.ts
  // already applied).
  skippedLines: number;
}

// Reads every entry ever appended. No log FILE yet -> zero entries, zero skipped lines
// — a normal state (a machine that has never run push/restore/verify), not a failure.
// Any OTHER read failure (permissions, I/O error, a directory sitting where the file
// should be, ...) THROWS instead of silently reporting an empty log: this is an audit
// tool, and "no history" must never be indistinguishable from "could not read the
// history" (the exact Critical fix receipt.ts's readReceipts() needed in #232 —
// applied here from the start). The read/ENOENT/split/parse/skippedLines scaffolding
// itself is util.ts's shared readJsonlLog() (#503) — only the per-entry shape
// validation below (deliberately STRICTER than receipt.ts's own, see this file's
// header comment) is specific to an audit entry.
export async function readAuditLog(): Promise<ReadAuditLogResult> {
  const { items, skippedLines } = await readJsonlLog<AuditEntry>(AUDIT_LOG, 'audit log', (parsed) => {
    const p = parsed as Partial<AuditEntry> | null;
    // Every nullable field is checked as EXACTLY null-or-string here, not coerced —
    // Codex review, Critical: the original version accepted ANY wrong-typed value
    // for a nullable field (e.g. an object, or the key deleted entirely) and folded
    // it down to `null` when rebuilding the entry. For a field that was ALREADY
    // `null` in the original entry (restore/verify's `backend`, or any command's
    // `locator`/`artifact_sha256`/`recipients_fingerprint` when unavailable), this
    // let a tampered value launder back to the SAME `null` the stored hash was
    // computed against — verifyAuditChain() then recomputed the identical hash and
    // reported the tampered line as valid. Rejecting (skipping) anything that is
    // not exactly `null` or a `string` closes that hole: a line altered this way is
    // now unreadable rather than silently normalized, and audit()'s VERDICT below
    // treats any skipped line as a possible tamper, not a benign gap.
    if (
      !p ||
      typeof p !== 'object' ||
      p.cypher_brain_audit_version !== AUDIT_VERSION ||
      typeof p.timestamp !== 'string' ||
      (p.command !== 'push' && p.command !== 'restore' && p.command !== 'verify') ||
      (p.backend !== null && typeof p.backend !== 'string') ||
      (p.locator !== null && typeof p.locator !== 'string') ||
      (p.artifact_sha256 !== null && typeof p.artifact_sha256 !== 'string') ||
      typeof p.machine !== 'string' ||
      (p.recipients_fingerprint !== null && typeof p.recipients_fingerprint !== 'string') ||
      typeof p.exit_code !== 'number' ||
      typeof p.duration_ms !== 'number' ||
      typeof p.hash !== 'string' ||
      (p.prev_hash !== null && typeof p.prev_hash !== 'string')
    ) {
      return null; // wrong shape (foreign line, future version, or a tampered field) — skip, don't crash a read
    }
    return {
      cypher_brain_audit_version: AUDIT_VERSION,
      timestamp: p.timestamp,
      command: p.command,
      // `?? null` here is SAFE (not a normalization) only because the guard above
      // already proved each of these is exactly `null` or a `string` — this is a
      // type narrowing, not a coercion of a wrong-typed value.
      backend: p.backend ?? null,
      locator: p.locator ?? null,
      artifact_sha256: p.artifact_sha256 ?? null,
      machine: p.machine,
      recipients_fingerprint: p.recipients_fingerprint ?? null,
      exit_code: p.exit_code,
      duration_ms: p.duration_ms,
      prev_hash: p.prev_hash ?? null,
      hash: p.hash,
    };
  });
  return { entries: items, skippedLines };
}

// #744: cross-process serialization for the read-tail -> append critical section
// below. A bare "read the last hash, then append" has no mutual exclusion between two
// processes racing the same await point — both can read the SAME tail hash, each
// append an entry whose prev_hash points at it, and the SECOND becomes a sibling
// rather than a child of the first. verifyAuditChain() then reports that as a broken
// link — a PERMANENT, false "possible tamper" verdict for what was actually two
// legitimate concurrent runs (two CLI/MCP processes finishing push/restore/verify at
// the same time is ordinary, not adversarial). This was a KNOWN, ACCEPTED limitation
// for the MVP (this file's header comment used to say so); it no longer is one.
//
// Exclusive-create lockfile (`wx`) with a staleness-based steal, mirroring
// idempotency.ts's own withLogLock (#617/#636) — duplicated rather than imported, same
// posture this file already takes toward receipt.ts's JSONL-read shape (see this
// file's header comment: independently-evolved per-module logic stays local rather
// than being forced into a shared shape). An OS-level flock(2) would close the
// crash-while-holding case more completely with no staleness guessing at all, but
// Node's core `fs` module does not expose one, and adding a native dependency is out
// of scope for this fix (same reasoning idempotency.ts's own claimIdempotencyKey doc
// comment already gives for not doing the equivalent there).
//
// Ownership-TOKEN-checked, not bare-pid (Codex review): withLogLock's own release
// unconditionally `rm()`s the lock path with no check that it is still OUR lock. Two
// compounding races that omission opens: (a) this waiter's OWN staleness-steal below
// racing the original holder's normal (non-crashed, just slow) completion — the
// original holder finishes and releases, a THIRD process acquires a fresh lock in that
// gap, and this waiter's `rm()` (believing it is removing an abandoned lock) deletes
// the fresh holder's live one instead; (b) the ORIGINAL holder's own delayed release,
// AFTER having been stolen from under it in scenario (a), deleting whatever NEW lock
// happens to occupy that path by the time it finally gets there. Either lets two
// processes into the critical section at once — exactly the fork this whole mechanism
// exists to prevent. A random per-attempt token (mirroring claimIdempotencyKey's own
// token, not shared with it) written as the lock file's CONTENT lets both removal
// sites verify "is this still the lock I think it is" immediately beforehand, closing
// the specific "delete a DIFFERENT, unrelated holder's live lock" failure mode.
//
// This does NOT make the lock fully race-free — see claimIdempotencyKey's own doc
// comment for why closing that fully needs an OS-level lock this file already ruled
// out above — a content check immediately before rm() still leaves a (much narrower)
// window between that check and the rm() call itself. Reaching it requires the
// ORIGINAL holder to legitimately run longer than AUDIT_LOCK_STALE_MS (10s — ordinary
// push/restore/verify audit-log appends read+write a small file, taking milliseconds,
// not seconds) AND a third process to land inside a now-microsecond-scale gap. Refusing
// to pretend this is fully closed (rather than silently asserting a stronger guarantee
// than the mechanism actually provides) matches this codebase's own posture toward the
// analogous residual gap in claimIdempotencyKey's release.
const AUDIT_LOCK_STALE_MS = 10_000; // longer than this and the holder is presumed crashed, not slow
const AUDIT_LOCK_RETRY_DELAY_MS = 50;
const AUDIT_LOCK_MAX_WAIT_MS = AUDIT_LOCK_STALE_MS + AUDIT_LOCK_RETRY_DELAY_MS * 20;

// Best-effort, ownership-checked removal: only removes `lockPath` if its current
// content still equals `token` (the value observed a moment ago, or this call's own
// acquisition token) — never a blind `rm()` of whatever currently occupies that path.
async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await readFile(lockPath, 'utf8');
    if (current === token) await rm(lockPath, { force: true });
    // else: the content changed since we last observed it — a different holder now
    // owns this path (or nobody does and it raced to ENOENT already, caught below);
    // leave it alone either way.
  } catch {
    // ENOENT (already gone) or any other read failure: best-effort only, never throw
    // out of a lock-cleanup path.
  }
}

async function withAuditLogLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${AUDIT_LOG}.lock`;
  await mkdir(dirname(AUDIT_LOG), { recursive: true });
  // Pid+timestamp+128-bit-random, same shape claimIdempotencyKey's own token uses —
  // enough entropy that an accidental collision with any other lock attempt, this
  // process or another, is astronomically unlikely.
  const token = `${process.pid}.${Date.now()}.${randomBytes(16).toString('hex')}`;
  const deadline = Date.now() + AUDIT_LOCK_MAX_WAIT_MS;
  for (;;) {
    // Checked at the TOP of every iteration (Codex review), not only on the
    // still-held/not-stale branch below: both `continue` paths further down (a
    // just-stolen stale lock, or one that disappeared between our failed create and the
    // stat() that follows it) used to loop back to `writeFile` with NEITHER this check
    // NOR the retry delay below it. A lock whose steal attempt keeps failing (e.g.
    // removeOwnedLock's rm() hitting a persistent, non-EEXIST-class error swallowed by
    // its own best-effort catch) span this exact gap: it always looks stale, is never
    // actually removed, and every iteration took the `continue` branch that skipped
    // AUDIT_LOCK_MAX_WAIT_MS entirely — a tight CPU-spinning loop with no timeout, the
    // opposite of what that constant's own name promises callers.
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${AUDIT_LOCK_MAX_WAIT_MS}ms waiting for the audit log lock at ${lockPath} ` +
          `(held by another process) — refusing to append without it rather than risk forking the chain`,
      );
    }
    try {
      // Exclusive create: succeeds only if no OTHER holder currently owns the lock —
      // this (not the read-then-append itself) is the actual mutual-exclusion primitive.
      await writeFile(lockPath, token, { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      // Someone else holds it — unless it looks abandoned (a process that crashed
      // between acquiring and releasing it), in which case steal it rather than wait
      // forever for a lock nobody will ever release.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > AUDIT_LOCK_STALE_MS) {
          // Ownership-checked steal (see this function group's own doc comment above):
          // re-read the content we are ABOUT to remove and only remove exactly that
          // value, narrowing (not eliminating) the window against the original holder
          // finishing normally and a third process acquiring a fresh lock in between.
          const staleContent = await readFile(lockPath, 'utf8').catch(() => null);
          if (staleContent !== null) await removeOwnedLock(lockPath, staleContent);
          continue; // deadline re-checked at the top of the loop
        }
      } catch {
        continue; // the lock disappeared between our failed create and this stat — retry now (deadline re-checked at the top of the loop)
      }
      await new Promise((r) => setTimeout(r, AUDIT_LOCK_RETRY_DELAY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await removeOwnedLock(lockPath, token);
  }
}

// Append one entry, hash-chained to the log's current LAST line — the read-tail ->
// append sequence below runs under withAuditLogLock (#744, see its own doc comment
// above) so two racing processes can no longer both read the same tail and fork the
// chain. Reads the WHOLE file to find the last hash (not tail-only): matches
// idempotency.ts's own "read whole file" philosophy — this log grows at
// CLI-invocation cadence (a handful of runs a day), not high-frequency-log cadence.
//
// Best-effort: NEVER throws to the caller. A write failure here (including a lock
// timeout) must not mask a real push/restore/verify outcome — the exact posture
// pushpull.ts's persistReceiptIfAny() already takes toward its own (cost) receipt
// writes.
export async function appendAuditEntry(
  partial: Omit<AuditEntry, 'cypher_brain_audit_version' | 'prev_hash' | 'hash'>,
): Promise<void> {
  try {
    await withAuditLogLock(async () => {
      const { entries } = await readAuditLog();
      const prevHash = entries.length > 0 ? entries[entries.length - 1].hash : null;
      const withoutHash: Omit<AuditEntry, 'hash'> = {
        cypher_brain_audit_version: AUDIT_VERSION,
        prev_hash: prevHash,
        ...partial,
      };
      const entry: AuditEntry = { ...withoutHash, hash: computeHash(withoutHash) };
      await mkdir(dirname(AUDIT_LOG), { recursive: true });
      await appendFile(AUDIT_LOG, `${JSON.stringify(entry)}\n`, { flag: 'a' });
    });
  } catch (e) {
    warn(`could not append to the audit log (${errMsg(e)}) — the ${partial.command} itself is unaffected`);
  }
}

export interface ChainVerifyResult {
  ok: boolean;
  brokenAtIndex: number | null;
  totalEntries: number;
}

// Pure function: recompute each entry's expected hash from its OWN fields + the
// PRECEDING entry's recorded hash, compare to its stored `hash`. Two independent ways
// a chain can break, both caught here: (1) an entry's own content was altered after
// the fact (its recomputed hash no longer matches the stored one), (2) an entry's
// prev_hash no longer matches its predecessor's actual hash (a line was deleted,
// reordered, or spliced in). Empty log: ok trivially. The first entry's prev_hash must
// be exactly null for the chain to be considered starting cleanly.
export function verifyAuditChain(entries: AuditEntry[]): ChainVerifyResult {
  if (entries.length === 0) return { ok: true, brokenAtIndex: null, totalEntries: 0 };
  let prevHash: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prev_hash !== prevHash) return { ok: false, brokenAtIndex: i, totalEntries: entries.length };
    const { hash, ...rest } = e;
    if (computeHash(rest) !== hash) return { ok: false, brokenAtIndex: i, totalEntries: entries.length };
    prevHash = e.hash;
  }
  return { ok: true, brokenAtIndex: null, totalEntries: entries.length };
}

// Shared helper push()/restore()/verify()'s own wrappers call — resolves
// artifact_sha256/recipients_fingerprint best-effort, so a caller need only supply
// what it definitely knows. The WHOLE body is wrapped in try/catch (Codex review,
// Critical): appendAuditEntry() alone being advisory-only is not sufficient —
// sha256()/readRecipientsFingerprint() ran OUTSIDE that protection in an earlier
// version, so if either ever threw (both are documented never-throw today, but that
// is an implementation detail of two OTHER modules this function does not control),
// recordAudit() itself would reject, and push()/restore()/verify()'s own wrapper
// would then either replace a real thrown error with this one, or turn an otherwise-
// successful run into a reported failure. This function's own contract — advisory
// only, NEVER throws — is now guaranteed at its own boundary, not borrowed from
// callees.
export async function recordAudit(args: {
  command: AuditEntry['command'];
  o: CliOptions;
  backend: string | null;
  locator: string | null;
  exitCode: number;
  startedAt: number;
}): Promise<void> {
  try {
    const artifactSha256 = args.o.in ? await sha256(args.o.in).catch(() => null) : null;
    const recipientsFingerprint = args.o.in ? await readRecipientsFingerprint(args.o.in) : null;
    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      command: args.command,
      backend: args.backend,
      locator: args.locator,
      artifact_sha256: artifactSha256,
      machine: hostname(),
      recipients_fingerprint: recipientsFingerprint,
      exit_code: args.exitCode,
      duration_ms: Date.now() - args.startedAt,
    });
  } catch (e) {
    warn(
      `could not record an audit entry for ${args.command} (${errMsg(e)}) — the ${args.command} itself is unaffected`,
    );
  }
}

// CLI `audit [--json]`: read-only chain verification. Mirrors doctor.ts's PASS/FAIL/
// VERDICT convention and ledger.ts's [--json] convention.
export async function audit(o: CliOptions): Promise<void> {
  const { entries, skippedLines } = await readAuditLog();
  if (skippedLines > 0) {
    warn(`audit: ${skippedLines} line(s) in the audit log could not be read (malformed/wrong-shape/future-version)`);
  }
  const result = verifyAuditChain(entries);
  // Codex review, Warning: a chain that verifies against the entries readAuditLog()
  // COULD parse is not proof nothing is missing — deleting an entry outright, or
  // corrupting it into an unreadable shape, makes it disappear from `entries`
  // entirely rather than show up as a broken link, so `result.ok` alone used to stay
  // true even when a line was silently dropped. Any skipped line is now treated as a
  // POSSIBLE deletion/tamper, not a benign gap: the overall VERDICT/exit code fails
  // whenever skippedLines > 0, even if the entries that WERE readable form a
  // perfectly valid chain among themselves (`chain_valid` in --json output keeps its
  // narrower, original meaning — that sub-result alone).
  const overallOk = result.ok && skippedLines === 0;
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  if (o.json) {
    printJson({
      total_entries: result.totalEntries,
      chain_valid: result.ok,
      broken_at_index: result.brokenAtIndex,
      skipped_lines: skippedLines,
      last_entry: lastEntry,
      // #458: the only CLI-level way to list/browse the FULL trail (previously only
      // last_entry was exposed, forcing anyone who wanted the other entries to read
      // $CYPHER_BRAIN_HOME/audit-log.jsonl directly, bypassing the CLI's own read/parse/
      // validate path entirely). Same precedent as ledger.ts's `receipts` array in its
      // own --json output: the aggregate/summary fields above PLUS every source record,
      // in one call, kept in log order (oldest first) so index N here lines up with
      // chain position N (and with `broken_at_index` above, when set).
      entries,
    });
    if (!overallOk) process.exitCode = 1;
    return;
  }
  console.log('cypher-brain audit — hash-chain verification');
  console.log('');
  console.log(`total entries: ${result.totalEntries}`);
  if (skippedLines > 0) console.log(`unreadable lines skipped: ${skippedLines}`);
  if (lastEntry) {
    console.log(`last entry: ${lastEntry.timestamp} ${lastEntry.command} (exit ${lastEntry.exit_code})`);
  }
  console.log('');
  const reasons: string[] = [];
  if (!result.ok) reasons.push(`chain broken at entry index ${result.brokenAtIndex}`);
  if (skippedLines > 0) reasons.push(`${skippedLines} unreadable line(s) could hide a deleted/altered entry`);
  console.log(`VERDICT: ${overallOk ? 'PASS' : 'FAIL'}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`);
  if (!overallOk) process.exitCode = 1;
}
