// Idempotency-key bookkeeping for cypher-brain-mcp's paid tools (issue #220): an AI
// agent's own retry logic — a network blip after snapshot_now already pushed to
// arweave/turbo, say — must never be able to spend twice for what the agent believes is
// one call. Stripe's Idempotency-Key pattern is the model (docs/prior-art.md): the caller
// names a key, and a repeat call carrying the SAME key gets back the FIRST call's result
// instead of doing the paid work again.
//
// Storage follows the same shape push --skip-unchanged already uses (src/lib/pushpull.ts):
// a small file under CYPHER_BRAIN_HOME, read before the paid work and written after it
// succeeds — no new persistence mechanism, no database, no lock server, no new runtime
// dependency. Unlike the save-locator file (one line, always overwritten with the latest
// push), this is a JSONL log because more than one DISTINCT key can be live at once — an
// agent may have several snapshot_now calls in flight (or recently completed) under
// different keys, and each needs its own remembered result. There is no consumer of this
// file OUTSIDE cypher-brain-mcp itself (no operator hand-edits or greps it the way they do
// a save-locator), so there is no positional-TSV backward-compatibility surface to
// preserve, and JSON-per-line is simpler to extend than a growing positional format would
// be.
import { readFile, rename, rm, mkdir, open, link, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { errMsg, readJsonlLog, syncDirectoryChain } from './util.js';
import { warn } from './warn.js';

// One stored line. `fingerprint` is an opaque, caller-computed digest of whatever fields
// define "the same call" for that tool (snapshot_now's is dirs/pg/recipients/out/backend/
// scan_secrets — see mcp.ts's snapshotNowFingerprint) — this module never inspects it,
// only compares it for equality, so a future second idempotent tool can define its own
// notion of "same call" without this file changing.
//
// #818: `disposition` and `retention` are BOTH optional on disk. A record written before
// they existed has neither, and must keep replaying exactly as it did — so a missing
// `disposition` reads as 'success' and a missing `retention` as 'ttl' (the only
// behaviours that existed then). There is deliberately no schema-version field to bump:
// the format has always been "a JSON object per line, unknown keys ignored", so a reader
// that defaults absent keys IS the compatibility mechanism, and adding a version now
// would make an old file — which every deployed cypher-brain has on disk — look like a
// format this reader must refuse.
interface StoredLine {
  key: string;
  tool: string;
  recordedAt: string;
  fingerprint: string;
  result: Record<string, unknown>;
  disposition?: IdempotencyDisposition;
  retention?: IdempotencyRetention;
}

/**
 * Whether the recorded call ENDED in success or in an error (#810/#818). The replayer
 * (mcp.ts) must report a replay the same way the first call was reported — an error
 * outcome replayed through the success-shaped result builder is how a partial failure
 * came back as `isError`-less success on retry.
 */
export type IdempotencyDisposition = 'success' | 'error';

/**
 * Whether the record expires with CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS ('ttl') or is kept
 * forever ('permanent', #818). Permanent is for the one outcome an expiry would turn back
 * into a double-spend: a payment that MAY have happened and that nothing in this process
 * can settle. Letting such a record age out does not resolve the ambiguity, it only
 * postpones the retry that pays twice — so a tombstone for it outlives the TTL, and
 * compaction below keeps it no matter how old it is.
 */
export type IdempotencyRetention = 'ttl' | 'permanent';

export interface IdempotencyLookupResult {
  /** The fingerprint the ORIGINAL call was recorded with — compared against the current call's own. */
  readonly fingerprint: string;
  /** The original call's structured result, replayed byte-for-byte on a cache hit — never re-derived. */
  readonly result: Record<string, unknown>;
  /** 'success' unless the record says otherwise — see IdempotencyDisposition. */
  readonly disposition: IdempotencyDisposition;
  /** 'ttl' unless the record says otherwise — see IdempotencyRetention. */
  readonly retention: IdempotencyRetention;
}

// Thrown instead of silently degrading to "no prior calls" whenever the log cannot be
// trusted to answer that honestly (multi-model review, P1): a lookup that cannot RULE OUT
// a prior call for this exact key must refuse rather than guess, because guessing wrong
// here means paying twice for what the caller believes is one call — the double-spend
// #220 exists to prevent. Both readAllRecords failure modes below throw this: a read
// error that is not "the file does not exist yet" (permission denied, a directory sitting
// where the file should be, a transient I/O error), and a file that DOES read but
// contains at least one line that could not be parsed/validated. The second case matters
// even though the corrupt line is not (as far as we can tell) for OUR key — a truncated
// write or a hand edit could just as easily have mangled the one line that WAS for it,
// and there is no way to tell "definitely someone else's, safe to ignore" apart from
// "possibly ours, now unreadable" once a line fails to parse at all.
export class IdempotencyStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdempotencyStoreError';
  }
}

interface ReadResult {
  records: StoredLine[];
  /** At least one line existed but could not be parsed/validated as a StoredLine. */
  corrupted: boolean;
}

// #612: built on util.ts's shared readJsonlLog() (the same "read -> ENOENT-is-empty ->
// other-errors-throw -> split lines -> skip blanks -> JSON.parse each line -> validate
// shape -> count skipped" skeleton receipt.ts/audit.ts already share, per util.ts's own
// header comment) rather than a third independent hand-rolled copy of it. The one real
// behavioral difference this module needs — failing closed when a corrupted line exists
// and no match was found — is expressible via readJsonlLog's skippedLines count, so
// `corrupted` below is just `skippedLines > 0`. Every line is still read + parsed on
// both lookup and record — this file is not expected to hold more than a handful of
// live entries at once (recordIdempotencyResult below drops every expired one on each
// write), so there is no need for an index or a streaming parser.
async function readAllRecords(path: string): Promise<ReadResult> {
  let items: StoredLine[], skippedLines: number;
  try {
    ({ items, skippedLines } = await readJsonlLog<StoredLine>(path, 'idempotency log', (parsed) => {
      const p = parsed as Partial<StoredLine> | null;
      if (
        p &&
        typeof p === 'object' &&
        typeof p.key === 'string' &&
        typeof p.tool === 'string' &&
        typeof p.recordedAt === 'string' &&
        // Elevated-caution review: a recordedAt that does not even PARSE as a date
        // (a truncated write, a hand edit, a future format this reader does not
        // understand) is a shape problem, not a timing one — checked here, in the
        // structural validator, rather than left for isFresh() below to quietly
        // read as "0/NaN ms old, therefore not fresh, therefore expired". Those two
        // outcomes look identical to isLive() for a `retention: 'ttl'` record — a
        // TTL record with a broken timestamp would silently vanish from every
        // lookup as if it had aged out normally — but they are NOT the same thing:
        // an expired record safely means "no prior call, do the real work"; a
        // record this reader cannot even date is one whose CONTENTS cannot be
        // trusted, including whether it was ever meant to be 'permanent' (a
        // tombstone for a payment whose outcome was never confirmed — see
        // IdempotencyRetention's own doc comment). Failing the shape check here
        // routes it through this file's existing `corrupted` machinery instead,
        // which already fails BOTH lookup and record-write closed rather than
        // silently treating "unreadable" as "safe to ignore".
        Number.isFinite(Date.parse(p.recordedAt)) &&
        typeof p.fingerprint === 'string' &&
        p.result &&
        typeof p.result === 'object' &&
        // #818: ABSENT is valid (an older record — defaulted on read below); PRESENT but
        // outside the closed set is not. A line saying disposition:"successs" is a line
        // this reader cannot honestly interpret, and interpreting it wrongly would turn an
        // error tombstone into a replayed success — so it fails the shape check, which
        // makes readAllRecords report the file as corrupted and every lookup that finds no
        // match fail closed, exactly as a truncated line already does.
        (p.disposition === undefined || p.disposition === 'success' || p.disposition === 'error') &&
        (p.retention === undefined || p.retention === 'ttl' || p.retention === 'permanent')
      ) {
        return p as StoredLine;
      }
      return null; // parses as JSON but not the shape a StoredLine must have
    }));
  } catch (e) {
    // readJsonlLog throws (its message already names the label + path) for anything
    // other than ENOENT (EACCES, EISDIR, a transient I/O error, ...) — must NOT be
    // treated the same as "no prior calls" — see IdempotencyStoreError's own doc
    // comment above. Rethrown as this module's own error class so callers keep
    // catching IdempotencyStoreError, not util.ts's generic Error.
    throw new IdempotencyStoreError(errMsg(e), { cause: e });
  }
  return { records: items, corrupted: skippedLines > 0 };
}

// The `Number.isFinite(t)` guard below is now belt-and-suspenders: readAllRecords'
// own shape validator (above) already rejects a StoredLine whose recordedAt does not
// parse as a date, routing it through `corrupted` instead of ever reaching here — see
// that validator's own comment for why a malformed timestamp must fail closed rather
// than silently read as "expired". Kept here too since this function has no other way
// to enforce it if ever called with data that bypassed that validator.
const isFresh = (recordedAt: string, ttlSeconds: number, now: number): boolean => {
  const t = Date.parse(recordedAt);
  return Number.isFinite(t) && now - t < ttlSeconds * 1000;
};

// #818: the single place the TTL is allowed to decide anything. A 'permanent' record is
// live regardless of age and regardless of what CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS
// says — both on lookup (so the key keeps replaying its tombstone) and on compaction (so
// the rewrite below never drops it). Every other record keeps the exact TTL behaviour it
// had, including one written before these fields existed (retention undefined -> 'ttl').
const isLive = (r: StoredLine, ttlSeconds: number, now: number): boolean =>
  r.retention === 'permanent' || isFresh(r.recordedAt, ttlSeconds, now);

/**
 * Look up the still-fresh recorded result for (tool, key), if any. Returns undefined on a
 * miss — no prior call, an expired one, or a key/tool that never matched — which the
 * caller must treat identically to "do the real work": this cache is only ever a fast
 * path to a result the tool would have produced anyway, never its own source of truth.
 *
 * The returned `fingerprint` is the ORIGINAL call's, for the caller to compare against the
 * current call's own — a mismatch means the same key was reused for a genuinely different
 * request, which the caller (mcp.ts) refuses rather than silently answering with the wrong
 * one's result.
 *
 * Throws IdempotencyStoreError (fail-closed, multi-model review P1) instead of returning
 * undefined when the log could not be read at all, OR when it read but contained at least
 * one line that failed to parse and no exact match for (tool, key) was found among what
 * DID parse — in both cases a "no prior call" answer cannot be trusted, and the caller
 * (mcp.ts) refuses the call rather than risk re-running a paid operation that may already
 * have completed under this exact key.
 */
export async function lookupIdempotencyResult(
  path: string,
  tool: string,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<IdempotencyLookupResult | undefined> {
  const { records, corrupted } = await readAllRecords(path);
  // Newest-first: recordIdempotencyResult always drops any prior entry for the SAME
  // (tool, key) before writing a new one, so in the steady state at most one entry per
  // key exists — this order only matters if an old file (written before a code change, or
  // hand-edited) somehow carries a duplicate, in which case the most recent write is the
  // one worth trusting.
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.tool === tool && r.key === key && isLive(r, ttlSeconds, now)) {
      // #818: absent fields default here, in the ONE place every reader goes through, so
      // a pre-#818 record on disk reads exactly as it always did (a fresh success, TTL-
      // governed) rather than needing every caller to remember the default.
      return {
        fingerprint: r.fingerprint,
        result: r.result,
        disposition: r.disposition ?? 'success',
        retention: r.retention ?? 'ttl',
      };
    }
  }
  if (corrupted) {
    throw new IdempotencyStoreError(
      `the idempotency log ${path} contains at least one line that could not be parsed, and none of what DID ` +
        `parse matched (tool=${JSON.stringify(tool)}, key=${JSON.stringify(key)}) — refusing to treat this key as ` +
        `unused rather than risk re-running a paid operation that was actually already recorded on the corrupted ` +
        `line (fail-closed). Inspect/repair or remove the corrupted line(s) in that file, or use a different key.`,
    );
  }
  return undefined;
}

// A bare read-modify-rename (below) has no cross-process mutual exclusion of its own:
// two processes (or, in one process, two calls racing at the same await point) that both
// read the file before either has renamed its own rewrite will each overwrite the OTHER's
// entry — the last rename wins, silently discarding whichever record lost the race
// (multi-model review, P1: "concurrent writes for a DIFFERENT key can clobber each
// other's records"). This is a best-effort, dependency-free mitigation for exactly that:
// an exclusive-create lockfile sibling of the log, held only for the read-modify-rename
// below, with a staleness timeout so a process that crashed while holding it does not wedge
// the log for everyone else forever.
//
// WHAT THIS DOES NOT CLOSE (documented rather than silently assumed away, per the same
// review): it serializes WRITES to the log file itself, so no record is lost to a lost
// update — but by itself it does NOT make the full "look up, then eventually record"
// sequence atomic across two SEPARATE processes; that is what claimIdempotencyKey below
// is for (#636) — see its own doc comment for the wider-scope lock that closes it.
const LOCK_STALE_MS = 10_000; // longer than this and the holder is presumed crashed, not slow
const LOCK_RETRY_DELAY_MS = 50;
// #617: must stay comfortably LARGER than LOCK_STALE_MS. A waiter that gives up before
// the staleness threshold can ever be reached would never get a chance to detect and
// steal a genuinely stale lock — it would just throw on a merely-slow-but-alive holder
// instead (the exact case the staleness check exists to distinguish from a crash). The
// margin below LOCK_STALE_MS is a few LOCK_RETRY_DELAY_MS poll cycles, so a waiter still
// polling past the staleness threshold gets at least one more chance to observe it.
const LOCK_MAX_WAIT_MS = LOCK_STALE_MS + LOCK_RETRY_DELAY_MS * 20;

// `pidAlive` is a small, deliberate DUPLICATE of push-lock.ts's own local helper of the
// same name, not an import: push-lock.ts imports newLockToken/lockTokenPid/
// releaseLockFileIfOwned FROM this file, so this file taking a dependency back on
// push-lock.ts for one three-line function would create a cycle. Kept byte-identical
// to push-lock.ts's copy on purpose.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

// Elevated-caution review, three findings fixed together here (they share one root
// cause: this lock used to be a BARE mtime-based staleness check with no ownership
// token at all, unlike push-lock.ts's more careful design, which this now mirrors):
//
//  1. No ownership token. The lock body used to be just `String(process.pid)`, and a
//     "steal" was a blind `rm()` of whatever sat at lockPath with no way to confirm
//     what was actually being removed — two waiters racing to steal the SAME
//     abandoned lock could each unlink the OTHER's freshly-created lock, defeating
//     the exclusion this file exists to provide. newLockToken() (pid.timestamp.random
//     — the same format push-lock.ts already writes, and already imported by it FROM
//     here) plus a steal-by-RENAME (push-lock.ts's stealLock(): move the exact lock
//     aside, re-read it, and put it back if the move turns out to have grabbed a
//     different — newer, live — lock) closes that: of two waiters, exactly one
//     rename succeeds, and the loser's own rename fails ENOENT rather than silently
//     deleting the winner's claim.
//  2. A busy-loop on a persistent non-ENOENT stat()/readFile() error. The old code's
//     catch swallowed EVERYTHING from that read into a bare `continue` with no
//     deadline check in that branch at all — for an ENOENT (the lock was released
//     between our failed create and this read) retrying immediately is correct, but
//     for a PERSISTENT error (EACCES on the lock directory, the path replaced by
//     something unreadable, …) the exact same error recurs on every immediate retry
//     too, pinning a core to reproducing it forever. Only ENOENT retries immediately
//     now; any other read failure falls back to the same bounded wait/backoff a held
//     lock gets, so it fails closed via IdempotencyStoreError instead of spinning.
//  3. Release is now ownership-checked (releaseLockFileIfOwned, shared with
//     claimIdempotencyKey/push-lock.ts), not an unconditional `rm()` — the latter
//     would delete a lock this process no longer actually holds (one that was
//     stolen from it after being judged abandoned), out from under whoever holds it
//     now.
interface LockHolder {
  text: string;
  mtimeMs: number;
}

// Sequentially, not in parallel (mirrors push-lock.ts's readHolder): a lock replaced in
// between would otherwise pair one generation's bytes with another generation's mtime.
// null means GONE (ENOENT — released between a failed create and this read, or between
// two calls to this function), a normal/retryable state; any OTHER failure (EACCES on
// the lock directory, an I/O error, ...) throws instead, since a lock that cannot be
// read is neither confirmably held nor confirmably free.
async function readLockHolder(lockPath: string): Promise<LockHolder | null> {
  try {
    const text = await readFile(lockPath, 'utf8');
    const mtimeMs = (await stat(lockPath)).mtimeMs;
    return { text, mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
}

// Abandoned exactly like push-lock.ts's own isAbandoned(): its recorded pid is gone, or
// the token does not parse at all AND it has sat past the staleness window (an
// unparseable-but-fresh lock is only ever the tiny window between another process's
// exclusive-create and its own fsync'd write completing).
//
// Regression review (Finding 1, PR #871 fsync durability hardening): the code here used
// to OR the staleness check into the confirmed-alive-pid branch too (`!pidAlive(pid) ||
// stale`), even though the comment above already documented the intended behavior
// correctly — pure staleness was never supposed to be enough when the recorded pid IS
// confirmed alive. That bug did not matter while this lock only ever guarded a fast
// mkdir+write+rename (nothing legitimate could hold it anywhere near LOCK_STALE_MS). It
// started to matter the moment #871 put real fsync calls INSIDE the critical section this
// lock guards (both this lock's own claim-write above and, more importantly,
// recordIdempotencyResult's actual data write) — a genuinely slow-but-legitimate fsync
// (disk pressure, a network filesystem) can now push a LIVE holder's total lock-hold time
// past LOCK_STALE_MS, and the old code would let a waiter steal that live process's lock
// out from under it mid-write. A live process that never releases its lock at all is a
// different, already-accepted tradeoff this codebase documents elsewhere (see
// push-lock.ts's own module-header comment on the identical choice, backstopped there by
// its own much longer MAX_AGE_MS) — this function does not attempt that; it only stops
// treating a confirmed-alive holder as abandoned by staleness alone. A waiter contending
// with a live holder that is not actually abandoned still cannot wait forever: it fails
// closed via the LOCK_MAX_WAIT_MS timeout in withLogLock below instead.
function isLockAbandoned(holder: LockHolder): boolean {
  const pid = lockTokenPid(holder.text);
  if (pid === null) return Date.now() - holder.mtimeMs > LOCK_STALE_MS;
  return !pidAlive(pid);
}

// Regression review round 4 (Critical, Codex re-review): process-local coordination so a
// caller that WINS a claim/lock does not report success to ITS OWN caller before a
// CONCURRENT caller's ancestor-directory sync (for the SAME `dir`) has actually completed.
// Round 3's fix made whichever caller's own `mkdir()` reports a new `firstCreated`
// discharge that sync EVENTUALLY, regardless of who wins — but "eventually" was not good
// enough: Codex reproduced caller A creating a fresh multi-level directory tree, pausing
// in its own (legitimately slow, no fault) staging fsync, while caller B — for the SAME
// key, finding `dir` already existing — wins the claim and returns success HAVING SYNCED
// ONLY `dir` ITSELF, before A's ancestor sync (for the levels A actually created) has even
// started. A crash in that window can still lose the directory tree containing B's live
// claim. Mirrors the SAME in-process coordination shape mcp.ts's own `idempotencyInFlight`
// Set already uses for concurrent same-key calls (see claimIdempotencyKey's own doc
// comment above) — a technique already established in this codebase's threat model, not a
// new one introduced here.
//
// A caller whose own `firstCreated` is non-undefined REGISTERS its own sync attempt here
// — via a plain, synchronous `Map.set()` immediately after `mkdir()` resolves, before any
// further `await` — so a CONCURRENT caller for the same `dir` that checks this map even
// moments later observes it and awaits the SAME promise instead of independently syncing
// only `dir` and reporting success early. RESIDUAL, stated rather than silently assumed
// away: this narrows, not fully closes, the race — two callers' own `mkdir()` calls can in
// principle both resolve, and both check this map, before either has had a chance to
// register (Node's underlying threadpool can complete BOTH callers' syscalls before either
// caller's own JS continuation runs), so registering "immediately after mkdir, before any
// other await" bounds the window to roughly one microtask rather than the (much longer,
// and outright reproduced) window of "however long this call's own staging fsync takes" —
// closing it fully would need cross-process coordination (a marker file, effectively
// re-introducing everything the last three rounds of this file's own review were spent
// closing) or accepting that a purely path-based, dependency-free mechanism cannot make
// two independent async operations atomic (the same limit this file's other TOCTOU-
// narrowing comments already state for their own residuals).
const pendingAncestorSyncs = new Map<string, Promise<void>>();

// Called SYNCHRONOUSLY (no `await` in between) immediately after `mkdir()` resolves, by
// whichever caller's own `firstCreated` is non-undefined — registers the sync of the
// ancestors THIS call's own mkdir just created, so a CONCURRENT caller checking
// `awaitPendingAncestorSync` for the SAME `dir` at any point before this promise settles
// observes and waits for it too. Returns undefined (nothing registered) when
// `firstCreated` is undefined (this call did not itself create anything new).
//
// Regression review round 5 (Critical, Codex re-review): returns the promise to its own
// caller — who MUST hold onto it and `await` it DIRECTLY, never solely via a later
// `pendingAncestorSyncs` lookup for `dir` — rather than only registering it and expecting
// the registrant itself to re-discover it through the map later. Codex reproduced why
// that mattered: the cleanup below removes a SETTLED promise from the map (success OR
// failure) as soon as it settles, which can complete well before this SAME caller's own
// staging+link work finishes and it comes back to check `dir`'s status — at that point
// the map has NOTHING for `dir` (already cleaned), so a lookup-only check silently reads
// as "nothing to wait for", swallowing this call's OWN sync failure with no concurrent
// caller or scheduler edge case required at all. Holding this returned promise directly
// sidesteps the map (and its cleanup timing) entirely for the one case that must never be
// missed: a caller's own registered work.
function registerAncestorSync(dir: string, firstCreated: string | undefined): Promise<void> | undefined {
  if (!firstCreated) return undefined;
  const resolvedDir = resolve(dir);
  const promise = syncDirectoryChain(dir, firstCreated);
  pendingAncestorSyncs.set(resolvedDir, promise);
  // Cleanup is memory hygiene only for OTHER (concurrent) callers' own map lookups, not a
  // substitute for this call's own direct reference above: a late CONCURRENT arrival
  // awaiting a just-deleted entry's own reference (captured in its own closure before the
  // delete) is unaffected, but an arrival that only checks the map AFTER cleanup has run
  // sees nothing — the SAME class of narrowing-not-closing residual already documented
  // for this map's cross-caller coordination (see the module-level comment above), now
  // stated for this angle of it too: only the direct-reference path this function returns
  // is exempt from that residual.
  promise
    .catch(() => {})
    .finally(() => {
      if (pendingAncestorSyncs.get(resolvedDir) === promise) pendingAncestorSyncs.delete(resolvedDir);
    });
  return promise;
}

// Called by EVERY caller — regardless of whether it itself registered anything, and
// regardless of whether it wins or loses whatever exclusive step (link) it is attempting
// for `dir` — right before that caller finalizes ANY outcome (a reported success, an
// EEXIST refusal, or a genuine failure). This is the other half of the round-4 fix: it is
// what lets a WINNER (B) that never itself created any ancestors still wait for a
// CONCURRENT caller's (A's) registered sync before B tells its own caller "claimed",
// rather than B independently syncing only `dir` and returning immediately. A no-op
// (resolves instantly) when nothing is currently registered for `dir`.
async function awaitPendingAncestorSync(dir: string): Promise<void> {
  const pending = pendingAncestorSyncs.get(resolve(dir));
  if (pending) await pending;
}

async function withLogLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const dir = dirname(resolve(path));
  const firstCreated = await mkdir(dir, { recursive: true });
  // Elevated-caution review, Codex round 2 (Critical, claim durability #2): this is the
  // mkdir that actually creates the directory tree the FIRST time this log is ever
  // touched — recordIdempotencyResult's own `fn()` below does a SECOND mkdir(dir,
  // {recursive:true}) later, but by then this one has already made `dir` exist, so that
  // second call's own `firstCreated` would always read back as undefined and its own
  // syncDirectoryChain call would never reach the ancestors THIS call is the one that
  // actually created. Syncing here, right after creating them, is what keeps a crash on
  // a brand-new CYPHER_BRAIN_HOME from losing the directory ENTRIES the lock file (and
  // the log file fn() writes) depend on. Registered (round 4) rather than a bare
  // `syncDirectoryChain` call, so a CONCURRENT caller for the same `dir` (see
  // `awaitPendingAncestorSync` below, right before this loop reports success) waits for
  // THIS sync too, instead of independently syncing only `dir` itself and reporting
  // success before this one completes. Awaited directly off the returned promise (round
  // 5), not via a map lookup — see registerAncestorSync's own doc comment for why a
  // lookup-only check can miss this call's OWN sync failing.
  const myAncestorSync = registerAncestorSync(dir, firstCreated);
  if (myAncestorSync) await myAncestorSync;
  const token = newLockToken();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    // Regression review round 3 (Codex re-review of round 2's own fix, elevated-caution,
    // PR #871): write-then-link, the SAME pattern push-lock.ts's own publishLock() uses
    // (see its own doc comment for the full rationale) — a private, uniquely-named
    // staging file is written and fsync'd FIRST, and only THEN atomically PUBLISHED to
    // the shared `lockPath` via `link`, which — unlike `open(lockPath, 'wx')` followed by
    // a separate write+sync — publishes a file that is ALREADY COMPLETE. This closes
    // every gap round 2's own fix (a "capture an fstat identity, then clean up by
    // dev+ino" approach) still had, all found by the SAME bounded Codex re-review:
    //   - Round 2's cleanup compared (dev, ino) via a separate stat() THEN rm() — still a
    //     TOCTOU: a replacement lock landing between those two calls got deleted anyway.
    //     Here, any failure before `link()` succeeds needs NO path-based cleanup at all —
    //     `staging` is a name nothing else could ever be racing for, so removing it is
    //     unconditionally safe regardless of what state the write/sync failed in.
    //   - Round 2 also captured identity via `fh.stat()`, itself a NEW failure point: if
    //     THAT call failed, identity stayed null and cleanup was skipped entirely,
    //     leaking an empty lock forever. There is no separate identity-capture step here
    //     to fail.
    // The concrete trigger Codex originally reproduced still applies to whichever step
    // fails now (writeFile, fsync, or link itself, all handled below): the throw
    // propagates straight out of withLogLock (the release `finally` further down is never
    // reached, since it only wraps `fn()` — this loop's own acquisition never got that
    // far), and the process stays alive (this guards a long-running MCP server's
    // idempotency log, not a short-lived CLI invocation) — Finding 1's own live-pid fix
    // above makes an UN-cleaned-up dangling lock unstealable for as long as this process
    // lives, so cleaning up here is what keeps that fix from also making a transient
    // fault permanent.
    //
    // Residual, stated rather than silently assumed away (Codex's own Warning, "PID reuse
    // creates another case"): this closes the CONCRETE trigger above (self-cleanup of a
    // staging file this SAME attempt owns outright), not every path to a leaked lock — if
    // `link()` itself SUCCEEDS but this process then crashes before ever reaching the
    // release `finally` (a genuinely different failure than any of the ones this fix
    // handles), the lock leaks exactly as it always could, and if this process's pid is
    // later reused by an unrelated process after that crash, Finding 1's live-pid check
    // would misjudge that unrelated process as the original (still-alive) holder. Codex's
    // own guidance applies here verbatim: blindly restoring age-based stealing to cover
    // this would revive the exact lost-update bug Finding 1 exists to fix. A bounded
    // last-resort backstop (mirroring push-lock.ts's own MAX_AGE_MS) is a real option for
    // this residual, but is a deliberate, separately-reviewed design change (how long is
    // safe for THIS lock's legitimate hold times, whether it needs its own positive
    // control) rather than a mechanical extension of this fix — left for a follow-up
    // rather than rushed in here.
    const staging = `${lockPath}.staging.${randomBytes(8).toString('hex')}`;
    try {
      // Exclusive create of the STAGING file only — never contended, since its name is
      // unique to this attempt. fsync'd before this process ever tries to publish it, so
      // the content `link` is about to make visible at `lockPath` is already durable.
      const fh = await open(staging, 'wx');
      try {
        await fh.writeFile(token, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (e) {
      // Unconditional and safe: `staging`'s name is unique to this attempt, so nothing
      // else could ever have created, replaced, or be relying on a file at this path.
      await rm(staging, { force: true }).catch(() => {});
      throw e;
    }
    let acquired = false;
    try {
      // The actual mutual-exclusion primitive, now that content durability is already
      // established: `link` succeeds only if no OTHER holder currently owns the lock,
      // and — unlike the old open('wx')-then-write-then-sync sequence — the instant it
      // succeeds, `lockPath` already holds fully-written, already-synced content; a
      // concurrent reader can never observe a freshly-published lock as "unparseable" or
      // racing this call's own write.
      await link(staging, lockPath);
      acquired = true;
    } catch (e) {
      // Regression review round 4 (Warning, Codex re-review): reconciliation now applies
      // to EEXIST too, not only other error codes — on some filesystems (an NFS client's
      // transparent RPC retry, in particular) a client-visible EEXIST can mean "MY OWN
      // earlier, lower-level retry of this exact link() already landed" rather than "a
      // different holder already exists". Read back BEFORE branching on the error code —
      // see claimIdempotencyKey's identical check for the full rationale — so a genuinely
      // different holder's EEXIST still falls through to the steal-checking logic below,
      // unchanged from round 3.
      const maybeOurs = await readFile(lockPath, 'utf8').catch(() => null);
      if (maybeOurs === token) {
        acquired = true;
      } else if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        await rm(staging, { force: true }).catch(() => {});
        throw e;
      }
      // else: genuinely EEXIST, held by someone else — falls through to the steal-
      // checking logic below with acquired still false.
    }
    // Best-effort, and deliberately not wrapped in the same try/catch as the `link()`
    // above (mirrors push-lock.ts's own publishLock(): once `link` has succeeded — or is
    // reconciled as having succeeded — this process HOLDS the lock, so a failure tidying
    // up the now-redundant staging file must not be treated as an acquisition failure).
    await rm(staging, { force: true }).catch(() => {});
    if (acquired) {
      // Regression review round 4 (Critical, Codex re-review): wait for a CONCURRENT
      // caller's ancestor sync too — not only whatever this call itself registered above
      // — before reporting success. Without this, a caller that never itself created any
      // ancestors (this loop's own `registerAncestorSync` above was a no-op for it) could
      // win the lock and return before a DIFFERENT, slower concurrent caller's sync (for
      // the SAME `dir`) has actually completed. See awaitPendingAncestorSync's own doc
      // comment for what this does and does not close.
      await awaitPendingAncestorSync(dir);
      // Regression review round 5 (Critical, Codex re-review): `dir` itself must ALWAYS
      // be synced here, unconditionally — the round-4 rewrite above replaced the
      // unconditional `syncDirectoryChain` call this loop used to make with the map-based
      // ancestor coordination, which is a no-op whenever NEITHER this call NOR any
      // concurrent one had new ancestors to report (the common case: `dir` already
      // existed durably from a previous session). That left the lock's own brand-new
      // directory ENTRY — the one `link()` just added — never synced at all on that path.
      // Cheap and idempotent even when an ancestor sync already covered `dir` (it is
      // always included in `syncDirectoryChain`'s own `toSync`, per that function's
      // contract) — this call is what makes sure it happens at least once regardless.
      // (For THIS lock specifically the lock file's own entry does not itself need to
      // survive a crash — see this function's own module-level context on why an
      // ephemeral coordination lock's absence after a crash is the desired recovery
      // state, not a hazard — but `dir` matters regardless for `path`'s own data file,
      // which recordIdempotencyResult's own separate write+rename dance inside `fn()`
      // below already syncs on its own. This call keeps withLogLock symmetric with
      // claimIdempotencyKey's identical fix rather than relying on that caller-specific
      // fact, since withLogLock has no way to know every future `fn()` will do the same.)
      await syncDirectoryChain(dir, undefined);
      break;
    }
    let holder: LockHolder | null;
    try {
      holder = await readLockHolder(lockPath);
    } catch (readErr) {
      // See finding 2 above: a persistent error recurs on every immediate retry
      // too, so this falls back to the same bounded wait/backoff a held lock gets
      // rather than busy-looping.
      if (Date.now() > deadline) {
        throw new IdempotencyStoreError(
          `cannot read the idempotency log lock at ${lockPath} ` +
            `(${(readErr as NodeJS.ErrnoException)?.code ?? 'unknown error'}) — refusing to write without it ` +
            'rather than risk a lost update.',
          { cause: readErr },
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
      continue;
    }
    if (holder === null) continue; // released between our failed create and this read — retry now, no backoff needed
    if (isLockAbandoned(holder)) {
      // Re-read IMMEDIATELY before the rename and re-judge (elevated-caution
      // review, Codex round 2, Critical: "the lock rewrite still permits
      // concurrent owners" — this file's first pass at this fix judged abandoned
      // from `holder` above and went straight to the rename, with no adjacent
      // re-check; mirroring push-lock.ts's stealLock() exactly, as intended,
      // means ALSO doing this second read right before acting, narrowing the
      // window between "judged abandoned" and "acted on it" to two adjacent
      // syscalls rather than however long this iteration's earlier work took).
      // Without it, a SEPARATE waiter that already completed its own steal-and-
      // reacquire cycle in the time since `holder` was read would have its
      // fresh, LIVE lock renamed away here instead — reopening, for a narrower
      // window, the exact concurrent-owners race this rewrite exists to close.
      // A failed re-read (including ENOENT, meaning someone else already
      // resolved it) is treated as "cannot confirm — do not steal", not as
      // license to proceed; the next loop iteration re-evaluates from scratch,
      // and a PERSISTENT read failure still gets the bounded backoff above on
      // its next pass through the primary read.
      const fresh = await readLockHolder(lockPath).catch(() => null);
      if (!fresh || fresh.text !== holder.text || !isLockAbandoned(fresh)) continue;
      // Steal via rename, not a blind rm (see finding 1 above): of two waiters
      // that both judge the SAME lock abandoned, exactly one moves it aside — the
      // other's rename fails ENOENT instead of unlinking the winner's fresh claim.
      const side = `${lockPath}.stale.${token}`;
      try {
        await rename(lockPath, side);
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // someone else already took/freed it
        throw renameErr;
      }
      // A read failure here is NOT "it matched" (push-lock.ts's own stealLock()
      // documents the same rule): treating it as one would discard whatever was
      // moved aside, which — if it was in fact a NEW holder's lock claimed in the
      // gap between the read above and this rename — leaves that holder running
      // with nothing recording that it holds anything. Unknown goes down the
      // restore path below, same as a known mismatch.
      const moved = await readFile(side, 'utf8').catch(() => null);
      if (moved === null || moved !== holder.text) {
        // Not (provably) the lock just judged abandoned. Put it back rather than
        // discard it: `link` (not a re-write) restores the ORIGINAL bytes even
        // when they could not be read, and fails with EEXIST rather than
        // clobbering if a third party has since created its own lock at that
        // path. If it fails, the side file is deliberately KEPT (not removed) —
        // a holder whose lock is missing is a holder nobody can see, so leaving
        // the evidence beats deleting it silently.
        //
        // Residual, stated rather than silently assumed away (Codex round 2):
        // this restore is itself two separate syscalls (rename-away, then
        // link-back), during which `lockPath` briefly does not exist at all — a
        // THIRD process racing to acquire in that exact instant can create its
        // own lock there before this restore runs, in which case `link` below
        // fails EEXIST and this branch's warn() fires. That is the same class of
        // narrowing-not-closing residual push-lock.ts's own module header
        // documents for this identical rename-then-maybe-restore pattern
        // ("no path-based lock can make [check-then-act] atomic... a guarantee
        // stronger than that needs an OS-level lock... a different change from
        // this one") — closing it fully needs the same OS-level advisory lock
        // that file already rules out of scope for this codebase.
        try {
          await link(side, lockPath);
          await rm(side, { force: true });
        } catch {
          warn(
            `could not restore an idempotency log lock that was moved aside while recovering a stale one — ` +
              `${side} holds its contents; remove that file once no push/paid call is running`,
          );
        }
        continue; // re-evaluate from scratch — this may or may not be resolved now
      }
      await rm(side, { force: true }).catch(() => {});
      continue; // the path is now clear — the top of the loop's open('wx') retries
    }
    if (Date.now() > deadline) {
      throw new IdempotencyStoreError(
        `timed out after ${LOCK_MAX_WAIT_MS}ms waiting for the idempotency log lock at ${lockPath} ` +
          `(held by another process) — refusing to write without it rather than risk a lost update.`,
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
  }
  try {
    return await fn();
  } finally {
    await releaseLockFileIfOwned(lockPath, token);
  }
}

// Thrown when (tool, key) is already claimed by another live holder — see
// claimIdempotencyKey's own doc comment below for what "claimed" means and why the
// caller should treat this exactly like mcp.ts's own in-process ERR_IDEMPOTENCY_IN_FLIGHT
// (refuse the concurrent duplicate outright, never queue or retry silently).
export class IdempotencyClaimHeldError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdempotencyClaimHeldError';
  }
}

/**
 * The claim lock file for (tool, key). Exported (#818) so a caller that deliberately
 * RETAINS a claim — mcp.ts, when a paid or uncertain call's result could not be recorded
 * and releasing the key would let a retry spend again — can name the exact file an
 * operator has to remove to unblock that key. Same path IdempotencyClaimHeldError's own
 * message already prints; derived here rather than duplicated at the call site so the two
 * can never disagree.
 */
export function idempotencyClaimLockPath(path: string, tool: string, key: string): string {
  return claimLockPath(path, tool, key);
}

function claimLockPath(path: string, tool: string, key: string): string {
  // Hashed rather than a literal tool/key-derived filename: an arbitrary caller-chosen
  // key can contain path separators or other filesystem-unsafe characters, the same
  // reason mcp.ts's own in-process lockId encodes [tool, key] as JSON rather than
  // concatenating them with a hand-picked separator.
  const id = createHash('sha256')
    .update(JSON.stringify([tool, key]))
    .digest('hex');
  return `${path}.claim.${id}.lock`;
}

/**
 * Claim (tool, key) across ALL processes sharing this idempotency log's directory, for
 * the caller's entire call (#636) — the cross-process counterpart of mcp.ts's in-process
 * `idempotencyInFlight` Set. That Set is process-local: two cypher-brain-mcp server
 * processes sharing one CYPHER_BRAIN_HOME each have their OWN Set, so one process adding
 * a key to ITS Set does nothing to stop the other from racing the identical
 * lookup-miss-then-spend sequence for the same key. This claim closes that: the caller
 * must acquire it BEFORE calling lookupIdempotencyResult and hold it (via the returned
 * release function, called in a `finally`) until AFTER its own recordIdempotencyResult
 * call — so a second process's own claim attempt fails immediately while the first still
 * holds it, and by the time a claim can succeed again, the previous holder's
 * recordIdempotencyResult has already completed (release happens no earlier than that),
 * so the new holder's own lookup is guaranteed to observe it rather than read a stale miss.
 *
 * Exclusive-create (`wx`) only — deliberately NO staleness-based auto-steal, unlike
 * withLogLock above (multi-model review, #636, Critical, three rounds): an earlier
 * version of this function DID attempt one (a fixed timeout, then a renewal heartbeat to
 * protect a still-running legitimate call, then a compare-and-delete recheck to protect a
 * fresh claim from a delayed steal), and each layer added to close one race opened a
 * narrower but still-real one underneath it — a mutate-by-path can never be made
 * atomic with a preceding read/stat check using only unlink/rename/create, no matter how
 * tightly the two are sequenced; closing that fully needs an OS-level advisory lock (e.g.
 * flock(2)) held on an open file descriptor, which the OS itself releases when the
 * holding process dies with no timeout guessing at all. Node's core `fs` module does not
 * expose flock, and adding one would mean a native dependency — a materially larger,
 * riskier change than this bug fix, and one this file's own header comment already rules
 * out ("no new persistence mechanism ... no new runtime dependency"). So: a claim, once
 * taken, is held until its own caller releases it — no other process may ever remove or
 * replace it. If the process holding it is confirmed gone (crashed, killed, machine
 * restarted) rather than merely slow, an operator removes the stale lock file by hand
 * (named in IdempotencyClaimHeldError's own message) — the same "fail closed, ask for
 * manual repair" pattern IdempotencyStoreError above already uses for a corrupted log.
 * Refusing outright and waiting on a human is strictly safer for a money-safety feature
 * than an automated recovery mechanism that cannot be made fully race-free without a new
 * dependency.
 *
 * Never WAITS for a held claim to free up either (unlike withLogLock, which polls until
 * LOCK_MAX_WAIT_MS) — mirroring mcp.ts's own idempotencyInFlight behavior, a concurrent
 * duplicate is refused outright (IdempotencyClaimHeldError) rather than queued, so a
 * caller retrying blind never silently piles up work waiting in line.
 *
 * Returns a release function the caller MUST call exactly once (typically in a
 * `finally`) once it is done with the key, whether that ended in a cache hit, a
 * successful spend, or an error. The release only removes the lock file if it still
 * carries THIS call's own ownership token — since nothing but an operator can ever
 * replace a live claim now, this only matters for the slow-motion case of a caller whose
 * claim was manually removed and re-claimed by someone else while it was still (thought
 * to be) running; releasing must not delete that new holder's live claim in that case, so
 * it is silently a no-op instead. Safe to call more than once — a repeat call (a caller's
 * own retry after a transient failure, say) re-runs the same read-then-maybe-remove check
 * rather than being suppressed by an "already released" flag, so a transient I/O error on
 * one attempt does not wedge the claim indefinitely.
 *
 * WHAT THIS STILL DOES NOT CLOSE (documented rather than silently assumed away, multi-
 * model review, #636): the read-then-maybe-remove above is itself two separate calls, not
 * one atomic one — an operator's manual removal, a new claimant's `writeFile('wx')`, and
 * this release's own `rm` could in principle interleave inside that gap and delete the
 * new holder's fresh claim. Reaching that requires a human to have ALREADY (incorrectly)
 * decided the original holder was dead and deleted its lock, AND a new claim to land, AND
 * the original holder's own release to fire — all within the same few-microsecond window.
 * That is categorically narrower than the bug this file exists to fix (which fired under
 * ordinary conditions, no operator error required), and closing it fully needs the same
 * OS-level advisory lock this function's own doc comment above already explains is out of
 * scope here. If a stronger guarantee is ever needed, it belongs in a follow-up that
 * replaces this path-based lockfile with one, not a silent assumption here.
 */
export async function claimIdempotencyKey(path: string, tool: string, key: string): Promise<() => Promise<void>> {
  const lockPath = claimLockPath(path, tool, key);
  const dir = dirname(resolve(path));
  const firstCreated = await mkdir(dir, { recursive: true });
  const token = newLockToken();
  // Regression review round 3 (Codex re-review of round 2's own fix, elevated-caution,
  // PR #871): write-then-link, the SAME pattern push-lock.ts's own publishLock() uses
  // (see its own doc comment for the full rationale, and withLogLock's matching call site
  // above for the identical rewrite there) — a private, uniquely-named staging file is
  // written and fsync'd FIRST, and only THEN atomically PUBLISHED to the shared
  // `lockPath` via `link`. This replaces round 2's own fix, which had two gaps Codex's
  // re-review found by fault injection:
  //   - Round 2's cleanup captured an fstat (dev, ino) "identity" the instant the
  //     exclusive create succeeded, then on a later failure compared it via a separate
  //     stat()-then-rm() before deleting `lockPath` — still a TOCTOU: a replacement claim
  //     landing in the gap between that stat() and that rm() got deleted anyway. Here, a
  //     failure before `link()` succeeds needs NO path-based cleanup logic — `staging`'s
  //     name is unique to this call, so nothing else could ever be racing for it.
  //   - Round 2's identity capture was itself a NEW failure point (a bare `fh.stat()`
  //     call): if THAT failed, identity stayed null and cleanup was skipped entirely,
  //     leaking an EMPTY claim forever. There is no separate identity-capture step here.
  //
  // Round 2 also tried moving the ancestor-directory sync (below, after the claim is
  // published) EARLIER — before the claim's own exclusive step — on the theory that
  // decoupling it from the claim's own outcome would close the "ancestor sync silently
  // never retried" gap. Codex's re-review reproduced why that is WRONG rather than just
  // incomplete: the exclusive-create/link IS this function's mutual-exclusion primitive
  // for (tool, key) — running anything durability-related BEFORE it removes exclusion for
  // whatever runs there. Two callers for the SAME key could both pass the now-unguarded
  // early sync and race each other to publish a claim, with the LOSER of that race
  // reporting "authorized to spend" while the WINNER's own ancestor sync might still be
  // in flight or about to fail. That reorder is reverted: the sync stays AFTER `link()`
  // succeeds, so nothing may run before the step that must fail closed for a second
  // caller. The "a failed ancestor sync is not independently retried by a later, separate
  // call" residual is therefore still present, unchanged from before this whole
  // regression-fix round — see the syncDirectoryChain call below for why that is the SAME
  // accepted tradeoff withLogLock's own early sync and recordIdempotencyResult's second
  // mkdir already document, not a new gap this fix introduces. A further, DIFFERENT gap
  // Codex's re-review DID find in this reorder (a race that can hand a concurrent SAME-
  // key caller a "claimed" outcome before this call's own ancestor sync has run, purely
  // from ordinary contention, no fault involved) is fixed below by having whichever
  // caller's OWN `firstCreated` is non-undefined discharge that sync itself, regardless
  // of which caller ends up holding the claim — see the syncDirectoryChain call's own
  // comment near the end of this function.
  //
  // Accepted limitation (Warning, Codex re-review), not fixed here: this function now
  // requires the filesystem holding `path` to support hard links (`link()`, used for the
  // write-then-link publish below). Unlike push-lock.ts's own publishLock() — which
  // falls back to a direct `writeFile(path, body, {flag:'wx'})` on ENOTSUP/EOPNOTSUPP/
  // EPERM/ENOSYS/EXDEV — this file does not implement an equivalent fallback: doing so
  // safely would reintroduce a SEPARATE, separately-reviewed acquisition path with its
  // own cleanup-on-failure logic (the exact complexity the last two regression-review
  // rounds were spent closing for the PRIMARY path), for a narrow, environment-specific
  // edge case (CYPHER_BRAIN_HOME sitting on a filesystem without hard-link support —
  // uncommon for the local-disk deployments this tool targets, though not impossible for
  // a network mount). On such a filesystem, every claimIdempotencyKey/withLogLock
  // acquisition fails with EOPNOTSUPP (or similar) on every attempt, with no dangling
  // state left behind (verified: staging cleanup still runs) rather than a decision
  // paying twice — a real limitation on that class of filesystem, stated rather than
  // silently assumed away, not a silent correctness gap.
  //
  // Regression review round 4 (Critical, Codex re-review): registered HERE, immediately
  // after `mkdir`, before any other `await` — not merely performed later, whenever this
  // call happens to reach the ancestor-sync step below. Round 3's fix made whichever
  // caller's own `firstCreated` is non-undefined discharge that sync EVENTUALLY, but
  // Codex reproduced that "eventually" is not good enough: caller B (finding `dir`
  // already existing, since caller A got there first) could WIN the claim and report
  // success to ITS OWN caller — having synced only `dir` itself — before caller A's
  // ancestor sync (for the levels A actually created) had even STARTED, since nothing
  // made B wait for it. Registering the promise here, and AWAITING whatever is currently
  // registered (see `awaitPendingAncestorSync` below, called again right before this
  // function reports ANY final outcome) closes that: B's own later check observes A's
  // in-flight promise and waits for it, rather than independently syncing only `dir` and
  // returning immediately. See `registerAncestorSync`'s own doc comment for what this
  // does and does not close (a narrowing, not a full close, of the underlying race).
  //
  // Held as a local reference (round 5, Critical, Codex re-review), not re-discovered
  // later via a map lookup: see registerAncestorSync's own doc comment for why a
  // lookup-only check can miss THIS call's own sync failing (the map's cleanup can
  // remove a settled entry before this same call comes back to check on it, with no
  // concurrent caller or scheduler edge case required).
  const myAncestorSync = registerAncestorSync(dir, firstCreated);
  const staging = `${lockPath}.staging.${randomBytes(8).toString('hex')}`;
  try {
    // fsync'd (elevated-caution review) before this call ever tries to publish it: the
    // claim is what stands between a retried paid MCP call and paying twice, so its
    // content must be durable BEFORE it becomes visible at the shared `lockPath`, not
    // merely reached the kernel page cache the instant this call reports success.
    const fh = await open(staging, 'wx');
    try {
      await fh.writeFile(token, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (e) {
    // Unconditional and safe: `staging`'s name is unique to this attempt, so nothing else
    // could ever have created, replaced, or be relying on a file at this path.
    await rm(staging, { force: true }).catch(() => {});
    throw e;
  }
  // `claimed`: this call IS the (tool, key) holder, either because `link()` itself
  // succeeded, or because a NON-EEXIST `link()` failure turned out to be ambiguous (see
  // below) and this call's own token is what is actually sitting at `lockPath`.
  // `genuineFailure`: a NON-EEXIST `link()` failure that reconciliation could NOT
  // attribute to this call — a real fault, propagated once ancestor durability (below)
  // has had its chance to run regardless.
  let claimed = false;
  let genuineFailure: unknown;
  try {
    // The actual mutual-exclusion primitive for (tool, key) — succeeds only if no OTHER
    // holder currently owns the claim, and — unlike the old open('wx')-then-write-then-
    // sync sequence — the instant it succeeds, `lockPath` already holds fully-written,
    // already-synced content.
    await link(staging, lockPath);
    claimed = true;
  } catch (e) {
    // Regression review round 3 (Warning) + round 4 (Warning, Codex re-review): a
    // `link()` error is not proof the operation never landed, and this now applies to
    // EEXIST too, not only other error codes — some filesystems (NFS in particular, one
    // of this whole hardening's own motivating scenarios per this file's header comment)
    // can report a failed RPC for an operation the SERVER actually completed, and an NFS
    // client's own transparent RPC retry can specifically surface that as EEXIST ("my own
    // earlier, lower-level retry of this exact link() already landed"), not only as some
    // other code. Codex reproduced both shapes: "perform the link, then report EIO" left
    // a REAL claim at `lockPath` while this call believed it had failed; "perform the
    // link, then report EEXIST" did too, this time falling into what used to be treated
    // as unconditionally "someone else's live claim". Abandoning either here would leak a
    // claim nobody else knows to release, indistinguishable from the exact leaked-claim
    // bug this whole regression-fix round exists to close, just triggered by an ambiguous
    // RPC instead of a genuine durability-check failure. Reconciling by reading `lockPath`
    // back and comparing to `token` BEFORE branching on the error code narrows this (does
    // not fully close it — the read-back is itself a separate syscall from the failed
    // `link`, so a THIRD party replacing `lockPath` in between could in principle still
    // confuse this check; narrower than, and independent of, releaseLockFileIfOwned's own
    // pre-existing, already-documented read-then-remove residual, which this reuses the
    // same shape of check for on the release path, not the acquire path).
    const maybeOurs = await readFile(lockPath, 'utf8').catch(() => null);
    if (maybeOurs === token) claimed = true;
    else if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') genuineFailure = e;
    // A genuine EEXIST (not reconciled as ours) falls through with claimed=false,
    // genuineFailure=undefined — handled below as someone else's live claim.
  }
  // Best-effort, and deliberately not inside the same try/catch as `link()` above
  // (mirrors push-lock.ts's own publishLock(): once `link` has succeeded — or is
  // reconciled as having succeeded — this call holds the claim, so a failure tidying up
  // the now-redundant staging file must not be treated as an acquisition failure).
  await rm(staging, { force: true }).catch(() => {});

  // Regression review round 3 (Critical) + round 4 (Critical) + round 5 (Critical, all
  // Codex re-review): every caller — regardless of whether IT wins, loses, or genuinely
  // fails its own exclusion attempt above — waits here for (a) whichever caller's `mkdir`
  // actually discovered new ancestors to finish syncing them, and (b), on the WINNING
  // path only, for `dir` itself to be synced for the brand-new directory ENTRY `link()`
  // just added. Round 3's fix made the ancestor-creator discharge (a) EVENTUALLY, on its
  // own; round 4 made the WINNER (who may not be the ancestor-creator at all) also wait
  // for it before reporting success. Round 5 fixes two remaining gaps Codex found in that:
  //   - `myAncestorSync` (this call's OWN registered promise, if any) is awaited
  //     DIRECTLY, not solely via `awaitPendingAncestorSync`'s map lookup — see
  //     `registerAncestorSync`'s own doc comment for why a lookup-only check can miss
  //     THIS call's own sync failing, deterministically, no concurrent caller needed.
  //   - `dir` itself is now synced UNCONDITIONALLY on the winning path (below), not only
  //     as a side effect of an ancestor sync that may never have run at all (the common
  //     case: `dir` already existed durably, so NEITHER `myAncestorSync` NOR any
  //     concurrent caller's registration exists to sync anything, and the claim's own
  //     brand-new link entry would otherwise never be synced by anyone).
  try {
    if (myAncestorSync) await myAncestorSync;
    await awaitPendingAncestorSync(dir);
    if (claimed) await syncDirectoryChain(dir, undefined);
  } catch (syncErr) {
    // WINNING path: propagate, unchanged from before this fix — mcp.ts's own caller
    // treats a durability-check failure as grounds to RETAIN rather than release the
    // claim (see this function's own doc comment above), so this must still surface.
    if (claimed) throw syncErr;
    // Losing/failed path: this call holds no claim to retain regardless of this outcome,
    // so best-effort only — warn for operator visibility rather than masking the more
    // actionable claim-outcome error already about to be reported below. Wording avoids
    // asserting "a concurrent caller claimed it" (Suggestion, Codex re-review): a
    // genuinely failed link() with no reconciled owner means no valid claim may exist at
    // all, so the warning states only what is actually known — this attempt itself did
    // not retain the ancestor structure's durability.
    warn(
      `failed to sync a newly-created ancestor directory for ${dir} while this attempt to claim ` +
        `idempotency_key ${JSON.stringify(key)} for tool ${JSON.stringify(tool)} did not itself succeed (${errMsg(syncErr)}) ` +
        '— a crash before this directory structure is next retried could still lose it',
    );
  }

  if (genuineFailure) throw genuineFailure;
  if (!claimed) {
    // Best-effort age hint for the operator only — never used to decide anything (see
    // this function's own doc comment for why auto-recovery is deliberately not
    // attempted). A failure here just omits the hint from the message below.
    let ageHint = '';
    try {
      const st = await stat(lockPath);
      const ageMinutes = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 60_000));
      ageHint = ` (claimed ${ageMinutes} minute(s) ago)`;
    } catch {
      // best-effort only
    }
    throw new IdempotencyClaimHeldError(
      `idempotency_key ${JSON.stringify(key)} for tool ${JSON.stringify(tool)} is already claimed at ` +
        `${lockPath}${ageHint} — refusing to run the same call concurrently rather than risk paying twice. If ` +
        'the process that made this claim is confirmed gone (crashed, killed, or the machine restarted since), ' +
        'remove that file manually to unblock a retry with this exact key.',
    );
  }
  return () => releaseLockFileIfOwned(lockPath, token);
}

/**
 * A lock file's owner token: pid, acquisition time, and 128 bits of randomness (#636).
 * Pid+timestamp alone is not a maximally strong ownership token, but the random suffix
 * makes an accidental collision with any other lock instance — same pid or not, this
 * process or a different one — astronomically unlikely.
 *
 * Shared (#806/#807) rather than re-derived: push's own advisory lock (src/lib/
 * push-lock.ts) writes the SAME token format, because it also has to READ the pid back
 * out of a lock file another process wrote (see lockTokenPid below). Producing and
 * parsing that format from one place is what keeps the two from drifting apart.
 */
export function newLockToken(): string {
  return `${process.pid}.${Date.now()}.${randomBytes(16).toString('hex')}`;
}

/**
 * The pid a `newLockToken()` string was minted by, or null when `text` is not one (an
 * empty or truncated lock file, a hand-written one, a future format). Never throws —
 * "unparseable" is a state callers must handle, not an error.
 */
export function lockTokenPid(text: string): number | null {
  const first = text.split('\n', 1)[0] ?? '';
  const head = first.split('.', 1)[0] ?? '';
  if (!/^[0-9]+$/.test(head)) return null;
  const pid = Number(head);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Remove `lockPath` — but ONLY if it still holds exactly the bytes this owner wrote.
 * Shared by claimIdempotencyKey above and src/lib/push-lock.ts (#806/#807), which is
 * why the ownership check is here rather than inlined at one of them.
 *
 * The check matters for the slow-motion case of a holder whose lock was removed (by an
 * operator, or by push-lock.ts's own staleness recovery) and re-taken by someone else
 * while it was still — as far as it knew — running: releasing must not delete that new
 * holder's live lock. Never throws, and deliberately has NO "already released"
 * short-circuit: a repeat call re-runs the check rather than being suppressed by a flag,
 * so a transient I/O error on one attempt does not wedge the lock indefinitely.
 */
export async function releaseLockFileIfOwned(lockPath: string, ownerText: string): Promise<void> {
  try {
    const owner = await readFile(lockPath, 'utf8');
    if (owner === ownerText) await rm(lockPath, { force: true });
  } catch {
    // ENOENT (already gone — a prior release already ran, or an operator removed it) or
    // any other read failure: best-effort cleanup only, never throw out of a release path.
  }
}

/**
 * Record a result for (tool, key), for a future lookupIdempotencyResult to replay.
 *
 * `options.disposition` says how that replay must be REPORTED — 'error' for a call that
 * ended in a failure the caller was told about (a partial success, an uncertain spend),
 * so the replay can be returned as an error rather than as a plain success (#810).
 * `options.retention` says how long it lives: 'permanent' opts the record out of the TTL
 * entirely (#818). Both default to the pre-#818 behaviour ('success' / 'ttl').
 *
 * Rewrites the whole file rather than merely appending, DROPPING every entry that
 * is either expired (and not permanent) or for the SAME (tool, key) being written now — a superseded write,
 * which only happens after a TTL expiry or the PushPartialSuccessError partial-success
 * path in mcp.ts, never after a bare cache hit (that returns before this is ever called)
 * — so the file stays bounded to roughly one line per still-live key instead of growing
 * forever, while every OTHER key's still-fresh entry survives untouched.
 *
 * Atomic write (temp sibling + rename), the SAME pattern push()'s --save-locator write
 * uses (src/lib/pushpull.ts): a crash mid-write must leave either the old file or the new
 * one intact, never a truncated one that a later lookup would silently read as "no prior
 * calls" for every key at once. The read-modify-rename runs under withLogLock (above) —
 * see its own doc comment for exactly what that does and does not guarantee.
 */
export async function recordIdempotencyResult(
  path: string,
  tool: string,
  key: string,
  fingerprint: string,
  result: Record<string, unknown>,
  ttlSeconds: number,
  now: number = Date.now(),
  options: { disposition?: IdempotencyDisposition; retention?: IdempotencyRetention } = {},
): Promise<void> {
  const disposition = options.disposition ?? 'success';
  const retention = options.retention ?? 'ttl';
  await withLogLock(path, async () => {
    const { records: existing, corrupted } = await readAllRecords(path);
    // Fail closed on a corrupted log (multi-model review, Critical): this function
    // REWRITES the whole file from the records it could parse, so a line it could not
    // parse is dropped by the very next write. If that line was a permanent tombstone,
    // the rewrite produces a clean log with nothing to refuse the retry, and the paid
    // operation runs again. lookupIdempotencyResult already refuses to answer "no prior
    // call" from a corrupted log for exactly this reason; a write has strictly more to
    // lose, because it also destroys the evidence.
    if (corrupted) {
      throw new IdempotencyStoreError(
        `the idempotency log ${path} contains at least one line that could not be parsed — refusing to rewrite it ` +
          `(recording a result for tool=${JSON.stringify(tool)}, key=${JSON.stringify(key)} would drop that line, ` +
          'and if it held a permanent record for a paid operation whose outcome was never settled, dropping it is ' +
          'what lets a retry pay twice). Inspect/repair or remove the corrupted line(s) in that file.',
      );
    }
    // #818: OTHER keys' records now survive compaction whenever they are permanent, not
    // merely fresh — an expiring log must not be the thing that unblocks a key whose
    // payment was never settled.
    //
    // The SAME (tool, key) is still superseded, exactly as before (that is what the
    // partial-success path needs) — EXCEPT when what is being superseded is a live
    // PERMANENT record, which is never overwritten by anything (multi-model review:
    // raised as a Suggestion, then tightened from "not by a ttl one" to "not by anything"
    // in round 2 — a permanent write carries the DEFAULT disposition 'success', so
    // allowing permanent-over-permanent would let an ordinary success replace an uncertain
    // -spend tombstone and turn the replay back into a clean success).
    //
    // Reaching this needs a caller bug: a later call under such a key finds the tombstone
    // on lookup — which isLive() returns regardless of age — and replays it before doing
    // any work, so no second record for it is ever written today. Enforced here anyway
    // rather than argued: "the tombstone is never overwritten" is the invariant the whole
    // double-spend guard rests on, and leaving it to every present and future caller to
    // preserve is how it eventually stops holding. Fail closed — the caller (mcp.ts)
    // treats a record-write failure as grounds to RETAIN the claim, so a bug here wedges
    // the key rather than freeing it.
    const supersededPermanent = existing.find(
      (r) => r.tool === tool && r.key === key && r.retention === 'permanent' && isLive(r, ttlSeconds, now),
    );
    if (supersededPermanent) {
      throw new IdempotencyStoreError(
        `refusing to overwrite the PERMANENT idempotency record for (tool=${JSON.stringify(tool)}, ` +
          `key=${JSON.stringify(key)}) in ${path}: that record exists because a paid operation under this key had ` +
          'an outcome nothing could confirm, and replacing it — with a shorter-lived record, or with one that ' +
          'reports success — is exactly how a retry ends up paying twice. Verify the outcome on-chain and use a ' +
          'NEW key.',
      );
    }
    const kept = existing.filter((r) => !(r.tool === tool && r.key === key) && isLive(r, ttlSeconds, now));
    const fresh: StoredLine = {
      key,
      tool,
      recordedAt: new Date(now).toISOString(),
      fingerprint,
      result,
      disposition,
      retention,
    };
    const lines = [...kept, fresh].map((r) => JSON.stringify(r));
    const dir = dirname(resolve(path));
    const firstCreated = await mkdir(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      // fsync'd before the rename (elevated-caution review), the same "write, sync,
      // THEN rename" ordering keys.ts's writeKeyFile/pending-spend.ts's appendLine
      // use — the rename must never make a payload VISIBLE at `path` before it has
      // actually reached disk, and the directory entry the rename creates/updates is
      // synced too (util.ts's syncDirectoryChain) so the rewrite itself survives a
      // crash the instant after this call returns.
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(`${lines.join('\n')}\n`, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await syncDirectoryChain(dir, firstCreated);
  });
}
