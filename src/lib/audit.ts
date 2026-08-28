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
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
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

// Append one entry, hash-chained to the log's current LAST line. No lock (unlike
// idempotency.ts): this is an audit/observability record, not a spend-safety gate — a
// concurrent-append race (two processes both reading the same prev_hash and appending
// against it) is a KNOWN, ACCEPTED limitation for this MVP, same posture receipt.ts's
// own header comment takes toward a similar concurrent-append edge case, not silently
// assumed away. Reads the WHOLE file to find the last hash (not tail-only): matches
// idempotency.ts's own "read whole file" philosophy — this log grows at
// CLI-invocation cadence (a handful of runs a day), not high-frequency-log cadence.
//
// Best-effort: NEVER throws to the caller. A write failure here must not mask a real
// push/restore/verify outcome — the exact posture pushpull.ts's persistReceiptIfAny()
// already takes toward its own (cost) receipt writes.
export async function appendAuditEntry(
  partial: Omit<AuditEntry, 'cypher_brain_audit_version' | 'prev_hash' | 'hash'>,
): Promise<void> {
  try {
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
