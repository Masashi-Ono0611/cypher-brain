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
import { writeFile, readFile, rename, rm, mkdir, stat, utimes } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
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
        typeof p.fingerprint === 'string' &&
        p.result &&
        typeof p.result === 'object'
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

// #636: this claim is held for the caller's ENTIRE call — lookup through record, not
// merely one log write the way withLogLock's lock above is — so it cannot reuse
// withLogLock's LOCK_STALE_MS (10s): that value is sized for a single read-modify-rename,
// and a real paid snapshot_now call (encrypt + upload) can legitimately run far longer.
// This codebase's own largest existing operation timeout is PIPE_TIMEOUT_MS
// (src/lib/config.ts, default 60 minutes) — the bound already placed on the tar/encrypt
// subprocess pipes snapshot() and push() spawn — so a claim held past twice that is a
// reasonable line between "an honest call that is just slow" and "the process that made
// it is gone".
const CLAIM_STALE_MS = 2 * 60 * 60 * 1000; // 2h
// Multi-model review (#636, Critical): a fixed staleness deadline with NO renewal means a
// single legitimately slow call — one call, slower than every other timeout in this
// codebase, but still honest — can be stolen mid-flight, which is exactly the double-claim
// this whole mechanism exists to prevent. claimIdempotencyKey below periodically re-touches
// its own lock file's mtime for as long as it is held (see the renewal timer in that
// function), so a live holder's claim keeps looking fresh regardless of how long the real
// call takes; a steal can then only ever happen to a claim NOBODY is renewing anymore —
// i.e. a genuinely crashed holder. The interval is a fraction of CLAIM_STALE_MS so a few
// missed/delayed ticks (a busy event loop during CPU-bound encrypt work, say) still leave
// several more chances to renew before the claim would ever be judged stale.
const CLAIM_RENEW_INTERVAL_MS = CLAIM_STALE_MS / 6; // 20m
// A steal race between two WOULD-BE claimants stealing the SAME stale claim at once is
// resolved by retrying the exclusive-create rather than assuming the steal succeeded —
// bounded so a pathological run of repeated collisions fails closed instead of spinning
// forever (each attempt only fires after observing a STALE lock, so in practice this
// almost never exceeds one iteration).
const CLAIM_STEAL_MAX_ATTEMPTS = 5;

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
 * Same exclusive-create + staleness-steal primitive as withLogLock above, but never
 * WAITS for a held claim to free up (unlike withLogLock, which polls until
 * LOCK_MAX_WAIT_MS) — mirroring mcp.ts's own idempotencyInFlight behavior, a concurrent
 * duplicate is refused outright (IdempotencyClaimHeldError) rather than queued, so a
 * caller retrying blind never silently piles up work waiting in line. Unlike
 * withLogLock, this claim also self-renews (see CLAIM_RENEW_INTERVAL_MS's own comment)
 * for as long as it is held, so staleness only ever fires on a claim nobody is renewing
 * — i.e. an actually crashed holder, not merely a slow one.
 *
 * Both the steal path (below) and the release function it returns use a
 * read-immediately-before-mutate check against this call's own ownership `token` rather
 * than a bare `rm`/overwrite — a blind mutate-by-path has no way to tell "the file I just
 * inspected" from "a DIFFERENT file a THIRD party already put at this same path a moment
 * ago", which would otherwise let a delayed steal or a delayed release destroy a brand
 * new, live claim (multi-model review, #636, Critical). This narrows those windows to a
 * single microtask between the read and the mutate rather than eliminating them
 * outright — closing them completely would need an OS-level advisory lock instead of a
 * path-based lockfile, a materially larger change this codebase's existing lock
 * primitives (withLogLock above) do not attempt either.
 *
 * Returns a release function the caller MUST call exactly once (typically in a
 * `finally`) once it is done with the key, whether that ended in a cache hit, a
 * successful spend, or an error. The release only removes the lock file if it still
 * carries THIS call's own ownership token — if the claim was stolen out from under an
 * unlucky caller that ran past CLAIM_STALE_MS despite renewal (e.g. the renewal itself
 * failed repeatedly), releasing must not delete the NEW holder's live claim (that would
 * let a third concurrent caller in while the second is still working, exactly the bug
 * this claim exists to prevent); it is silently a no-op in that case instead. Safe to
 * call more than once — a repeat call (a caller's own retry after a transient failure,
 * say) re-runs the same read-then-maybe-remove check rather than being suppressed by a
 * "already released" flag, so a transient I/O error on one attempt does not wedge the
 * claim for the rest of CLAIM_STALE_MS the way silently swallowing it once would.
 */
export async function claimIdempotencyKey(path: string, tool: string, key: string): Promise<() => Promise<void>> {
  const lockPath = claimLockPath(path, tool, key);
  await mkdir(dirname(resolve(path)), { recursive: true });
  // Pid alone is not a safe ownership token: a stolen-then-reclaimed lock could in
  // principle be re-created by a DIFFERENT later call from the same pid (this same
  // process, a later retry) after this one already lost the race — the random suffix
  // disambiguates this specific claim instance from any other, same pid or not.
  const token = `${process.pid}.${randomBytes(4).toString('hex')}`;
  let attempts = 0;
  for (;;) {
    try {
      await writeFile(lockPath, token, { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      let stale: boolean;
      let staleContent: string | null;
      try {
        const st = await stat(lockPath);
        stale = Date.now() - st.mtimeMs > CLAIM_STALE_MS;
        staleContent = stale ? await readFile(lockPath, 'utf8').catch(() => null) : null;
      } catch (statErr) {
        // Only ENOENT (the claim disappeared between our failed create and this stat —
        // a concurrent release) is safe to silently retry. Any OTHER error (EACCES,
        // EIO, a directory sitting where the lockfile should be, ...) means this
        // process cannot reliably tell held-and-fresh apart from abandoned-and-stale —
        // fail loud rather than spin on it forever (multi-model review, #636, Warning).
        if ((statErr as NodeJS.ErrnoException)?.code !== 'ENOENT') throw statErr;
        continue; // uncounted — this is a benign, expected race, not a steal attempt
      }
      if (!stale) {
        throw new IdempotencyClaimHeldError(
          `idempotency_key ${JSON.stringify(key)} for tool ${JSON.stringify(tool)} is already claimed at ` +
            `${lockPath} by another process (or this same process, if it did not check its own in-process ` +
            'in-flight set first) — refusing to run the same call concurrently rather than risk paying twice.',
        );
      }
      if (++attempts > CLAIM_STEAL_MAX_ATTEMPTS) {
        throw new IdempotencyClaimHeldError(
          `could not claim idempotency_key ${JSON.stringify(key)} for tool ${JSON.stringify(tool)} after ` +
            `${CLAIM_STEAL_MAX_ATTEMPTS} attempts to steal a presumed-crashed holder's claim at ${lockPath} — ` +
            'refusing rather than risk two processes both believing they now own it.',
        );
      }
      // Presumed-crashed holder (older than CLAIM_STALE_MS, and nobody is renewing it —
      // see CLAIM_RENEW_INTERVAL_MS's own comment) — steal it. Compare-and-delete against
      // the content just read as stale, not a bare rm: if some OTHER stealer already won
      // this exact race and replaced the file in the moment since our own read, `readFile`
      // here observes THEIR new content, sees it does not match what we judged stale, and
      // leaves it alone — our own `writeFile('wx')` retry below then correctly fails
      // EEXIST against their fresh (non-stale) claim instead of deleting it out from under
      // them (multi-model review, #636, Critical).
      try {
        const recheck = await readFile(lockPath, 'utf8');
        if (recheck === staleContent) await rm(lockPath, { force: true });
      } catch {
        // gone already (a concurrent release, or another stealer's own steal-then-recreate
        // landing between our recheck and here) — fine, the loop below retries the create
      }
    }
  }
  const renewalTimer = setInterval(() => {
    // Fire-and-forget, best-effort: only touch mtime while we still own it — this must
    // never resurrect a claim that was already stolen or released, only keep a LIVE one
    // from looking abandoned. Any failure (the file is gone, a transient I/O error) is
    // silently skipped; the next tick tries again, and losing a few ticks is exactly what
    // CLAIM_RENEW_INTERVAL_MS's margin below CLAIM_STALE_MS is sized to tolerate.
    void (async () => {
      try {
        const owner = await readFile(lockPath, 'utf8');
        if (owner === token) await utimes(lockPath, new Date(), new Date());
      } catch {
        // see comment above — best-effort only
      }
    })();
  }, CLAIM_RENEW_INTERVAL_MS);
  renewalTimer.unref?.(); // never keep the process alive on its own — the real work does that
  return async () => {
    clearInterval(renewalTimer);
    try {
      const owner = await readFile(lockPath, 'utf8');
      if (owner === token) await rm(lockPath, { force: true });
      // else: this claim was stolen by a later holder (this call outran CLAIM_STALE_MS
      // despite renewal) — leave THEIR live claim alone, see this function's own doc
      // comment above.
    } catch {
      // ENOENT (already gone — stolen-then-released by someone else, or a prior release
      // already ran) or any other read failure: best-effort cleanup only, never throw
      // out of a release path. Deliberately no "already released" short-circuit — see
      // this function's own doc comment for why a repeat call must re-run this check
      // rather than being suppressed.
    }
  };
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
