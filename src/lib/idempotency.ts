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
import { writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { errMsg, readJsonlLog } from './util.js';

// One stored line. `fingerprint` is an opaque, caller-computed digest of whatever fields
// define "the same call" for that tool (snapshot_now's is dirs/pg/recipients/out/backend/
// scan_secrets — see mcp.ts's snapshotNowFingerprint) — this module never inspects it,
// only compares it for equality, so a future second idempotent tool can define its own
// notion of "same call" without this file changing.
interface StoredLine {
  key: string;
  tool: string;
  recordedAt: string;
  fingerprint: string;
  result: Record<string, unknown>;
}

export interface IdempotencyLookupResult {
  /** The fingerprint the ORIGINAL call was recorded with — compared against the current call's own. */
  readonly fingerprint: string;
  /** The original call's structured result, replayed byte-for-byte on a cache hit — never re-derived. */
  readonly result: Record<string, unknown>;
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

function validateStoredLine(parsed: unknown): StoredLine | null {
  if (
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as StoredLine).key === 'string' &&
    typeof (parsed as StoredLine).tool === 'string' &&
    typeof (parsed as StoredLine).recordedAt === 'string' &&
    typeof (parsed as StoredLine).fingerprint === 'string' &&
    (parsed as StoredLine).result &&
    typeof (parsed as StoredLine).result === 'object'
  ) {
    return parsed as StoredLine;
  }
  return null;
}

// Every line is read + parsed on both lookup and record — this file is not expected to
// hold more than a handful of live entries at once (recordIdempotencyResult below drops
// every expired one on each write), so there is no need for an index or a streaming
// parser.
async function readAllRecords(path: string): Promise<ReadResult> {
  try {
    const { items, skippedLines } = await readJsonlLog<StoredLine>(path, 'idempotency log', validateStoredLine);
    return { records: items, corrupted: skippedLines > 0 };
  } catch (e) {
    throw new IdempotencyStoreError(`could not read idempotency log ${path}: ${errMsg(e)}`, { cause: e });
  }
}

const isFresh = (recordedAt: string, ttlSeconds: number, now: number): boolean => {
  const t = Date.parse(recordedAt);
  return Number.isFinite(t) && now - t < ttlSeconds * 1000;
};

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
    if (r.tool === tool && r.key === key && isFresh(r.recordedAt, ttlSeconds, now)) {
      return { fingerprint: r.fingerprint, result: r.result };
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
// update — but it does NOT make the full "look up, then eventually record" sequence
// atomic across two SEPARATE processes. Two different OS processes racing on the exact
// SAME idempotency_key can each read a cache MISS (mcp.ts's lookupIdempotencyResult runs
// outside this lock, before either process starts its own paid work) and both go on to
// spend — mcp.ts's own idempotencyInFlight Set only guards that window WITHIN one
// process. Closing the cross-process version of that race would mean holding one lock for
// the ENTIRE paid call (including the actual network upload), which is a materially larger
// change than the data-loss bug this closes; if that stronger guarantee is ever needed,
// it belongs in a follow-up that widens the lock's scope, not a silent assumption here.
const LOCK_STALE_MS = 10_000; // longer than this and the holder is presumed crashed, not slow
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_WAIT_MS = 5_000;

async function withLogLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(resolve(path)), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      // Exclusive create: succeeds only if no OTHER holder currently owns the lock — this
      // (not the read-modify-rename itself) is the actual mutual-exclusion primitive.
      await writeFile(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      // Someone else holds it — unless it looks abandoned (a process that crashed between
      // acquiring and releasing it), in which case steal it rather than wait forever for a
      // lock nobody will ever release.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // the lock disappeared between our failed create and this stat — retry now
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
    await rm(lockPath, { force: true });
  }
}

/**
 * Record a successful result for (tool, key), for a future lookupIdempotencyResult to
 * replay. Rewrites the whole file rather than merely appending, DROPPING every entry that
 * is either expired or for the SAME (tool, key) being written now — a superseded write,
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
): Promise<void> {
  await withLogLock(path, async () => {
    const { records: existing } = await readAllRecords(path);
    const kept = existing.filter((r) => !(r.tool === tool && r.key === key) && isFresh(r.recordedAt, ttlSeconds, now));
    const fresh: StoredLine = { key, tool, recordedAt: new Date(now).toISOString(), fingerprint, result };
    const lines = [...kept, fresh].map((r) => JSON.stringify(r));
    await mkdir(dirname(resolve(path)), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${lines.join('\n')}\n`, { flag: 'w' });
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  });
}
