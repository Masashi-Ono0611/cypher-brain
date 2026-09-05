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
function isLockAbandoned(holder: LockHolder): boolean {
  const pid = lockTokenPid(holder.text);
  const stale = Date.now() - holder.mtimeMs > LOCK_STALE_MS;
  return pid === null ? stale : !pidAlive(pid) || stale;
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
  // the log file fn() writes) depend on.
  await syncDirectoryChain(dir, firstCreated);
  const token = newLockToken();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      // Exclusive create: succeeds only if no OTHER holder currently owns the lock —
      // this (not the read-modify-rename itself) is the actual mutual-exclusion
      // primitive. fsync'd before this process ever treats itself as the holder, so
      // the claim itself is durable (and so a concurrent reader can never observe an
      // exclusively-created-but-still-empty lock file as "unparseable").
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(token, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
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
  try {
    // fsync'd (elevated-caution review) before this call ever returns a release
    // function to its caller: the claim is what stands between a retried paid MCP
    // call and paying twice, so the claim itself must be durable, not merely
    // reached the kernel page cache, the instant this call reports success.
    const fh = await open(lockPath, 'wx');
    try {
      await fh.writeFile(token, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Elevated-caution review, Codex round 2 (Critical: "claim durability remains
    // incomplete") — syncing the fd's CONTENT is not enough: the DIRECTORY ENTRY this
    // exclusive create just added is a separate durability fact, and an fsync'd file
    // whose creation is still only in the page cache can come back missing entirely
    // after a crash. For a claim specifically, "missing entirely" means a retry after
    // the crash sees no claim at all and is free to spend again — exactly the
    // double-spend window this function exists to close. Also covers the (rare)
    // case where `dir` itself did not exist yet: `firstCreated` carries every
    // ancestor this call's own mkdir just created, so those directory entries are
    // synced too, not only the immediate one.
    await syncDirectoryChain(dir, firstCreated);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
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
