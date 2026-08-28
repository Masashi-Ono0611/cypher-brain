// file backend: a local content-addressed store. Needs no daemon and no network,
// so CI can exercise push/pull end-to-end. locator = <FILE_DIR>/<sha256><ext>
import { mkdir, copyFile, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { join, dirname, resolve, basename, extname } from 'node:path';
import { FILE_DIR } from '../config.js';
import { exists, sha256 } from '../util.js';
import type { StorageBackend, PutOpts } from '../types.js';

// locators produced by put() always have this shape (basename of `<sha256><ext>`).
// ".age" is the ciphertext extension every --in push() itself accepts; ".minisig" is
// the ONLY other extension push() ever hands this backend — the detached authenticity
// sidecar (#214), uploaded alongside the ciphertext it signs (see push() in
// pushpull.ts). A tight allowlist, not an open regex: same "narrow validated shape"
// defense-in-depth this file already applied to age ciphertext (an untrusted locator,
// e.g. from a tampered --save-locator file, must never resolve outside FILE_DIR OR to
// an unexpected extension).
const LOCATOR_SHAPE_RE = /^[0-9a-f]{64}\.(age|minisig)$/;

export function fileBackend(): StorageBackend {
  return {
    async put(file: string, _opts: PutOpts = {}): Promise<string> {
      await mkdir(FILE_DIR, { recursive: true });
      // Preserve the pushed file's own extension instead of assuming every object is
      // ciphertext (#214: a *.minisig sidecar pushed through this SAME backend must not
      // be misnamed "<sha>.age") — content-addressed either way, so this is purely a
      // display/routing convenience, never a correctness dependency. Falls back to
      // ".age" for an extensionless input (unchanged behavior for every pre-#214 caller,
      // which only ever pushed *.age files).
      const ext = extname(file) || '.age';
      const locator = join(FILE_DIR, `${await sha256(file)}${ext}`);
      await copyFile(file, locator);
      return locator;
    },
    async get(locator: string, out: string): Promise<void> {
      // The locator may come from an untrusted channel (e.g. a tampered
      // --save-locator file, see cli.ts), so it must not be used as a raw
      // filesystem path without validation first — this closes an arbitrary
      // local file read / path-traversal foot-gun. Mirrors the tx-id regex
      // check arweave.ts's get() already does for its own locator format.
      // put() only ever writes direct children of FILE_DIR shaped
      // <sha256>.age, so require both here.
      const resolved = resolve(locator);
      if (dirname(resolved) !== resolve(FILE_DIR)) {
        throw new Error(`file backend: locator is outside FILE_DIR: ${locator}`);
      }
      if (!LOCATOR_SHAPE_RE.test(basename(resolved))) {
        throw new Error(`file backend: locator does not match the expected <sha256>.age shape: ${locator}`);
      }
      if (!(await exists(resolved))) throw new Error(`file backend: no object at ${resolved}`);
      // This backend's whole "content-addressed" claim (the doc comment at the top of
      // this file, and verify --level remote/drill's NON_CONTENT_ADDRESSED_BACKENDS
      // warning in src/lib/config.ts, which deliberately does NOT list `file`) is only
      // as real as this check. Nothing else stops something OTHER than put() — a bug, a
      // restore of an old FILE_DIR backup over a live one, a FILE_DIR shared with
      // another process — from landing DIFFERENT bytes under the SAME <sha256>.ext name;
      // without verifying the object against its own filename here, a caller who passed
      // no --sha256 (trusting this backend's locator to already BE the hash) would have
      // the substituted bytes served back as if nothing had changed, and verify --level
      // remote/drill would report VERDICT: PASS over it (#209 review).
      //
      // The hash is computed WHILE copying (one read pass, piped through a hashing
      // transform to a same-directory temp file), not by a separate sha256(resolved)
      // read followed by a later copyFile(resolved, out) — two independent filesystem
      // reads of the SAME path would leave a check/use (TOCTOU) window: a process with
      // write access to FILE_DIR could swap the object AFTER it's hashed but BEFORE it's
      // copied, and this backend would then serve the replacement bytes as if they'd
      // passed the hash check that actually ran against the OLD bytes (#642). Streaming
      // means the digest compared below is guaranteed to be the digest of the exact
      // bytes that landed in `tmp` — there is no second read of `resolved` for anything
      // to race. `tmp` lives in `out`'s own directory (not /tmp) so the final rename is
      // same-filesystem (atomic, no partial-write window at `out`), and a failed/
      // mismatched attempt is cleaned up rather than left behind.
      const claimedHash = basename(resolved, extname(resolved));
      const resolvedOut = resolve(out);
      await mkdir(dirname(resolvedOut), { recursive: true });
      // Same naming convention pushpull.ts's own pull() already uses for ITS scratch
      // sibling of --out (`${o.out}.${pid}.${randHex}.part`) — a same-directory temp
      // so the rename below is same-filesystem (atomic), and PID + random suffix so two
      // concurrent get() calls into the same `out` (e.g. two pulls racing) never collide.
      const tmp = `${resolvedOut}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
      const hash = createHash('sha256');
      try {
        await pipeline(
          createReadStream(resolved),
          async function* hashTap(source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              hash.update(chunk);
              yield chunk;
            }
          },
          createWriteStream(tmp),
        );
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      const gotHash = hash.digest('hex');
      if (gotHash !== claimedHash) {
        await rm(tmp, { force: true });
        throw new Error(
          `file backend: object at ${resolved} does not match its own locator hash (expected ${claimedHash}, got ` +
            `${gotHash}) — this store's content-addressing invariant is violated; refusing to serve it`,
        );
      }
      try {
        await rename(tmp, resolvedOut);
      } catch (e) {
        // The digest already matched — this is a PROMOTION failure (a permissions
        // problem, --out's directory disappearing, a platform refusing to replace an
        // existing --out, ...), not a verification failure — but `tmp` must not be left
        // behind either way (Codex review, #642 follow-up).
        await rm(tmp, { force: true });
        throw e;
      }
    },
  };
}
