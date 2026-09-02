// The single open file descriptor a restore/verify run does ALL of its reading through
// (#785). Every phase used to re-open `--in` by pathname — the `--sha256` pin, the
// minisign verification, the size cap, the tar-entry inspection, and finally the
// extraction itself — so nothing bound the bytes that were hashed and signature-checked
// to the bytes that were actually decrypted into `--out-dir`. A writer who could replace
// that path for a few seconds (a group-writable directory, a synced/network mount, a
// world-writable /tmp, or the gap between an unattended `pull` and the `restore` that
// reads its output back) passed verification with a genuine, correctly-signed artifact
// and had a DIFFERENT one extracted. age is public-key encryption, so the substitute
// needs no secret at all: the recipient public key is published by design.
//
// Opening once and reading positionally from that descriptor closes the rename half of
// it outright — a descriptor keeps pointing at the inode it was opened on, so swapping
// the path is invisible to every phase after the open. The in-place-overwrite half
// (truncate + write through the SAME inode) is still visible here by design; that is
// what restore.ts's baseline-vs-extraction digest comparison is for (CB-E026).
//
// Deliberately NOT fs.createReadStream()/FileHandle.createReadStream(): both tie the
// stream's lifetime to the descriptor. Measured on Node 24 — destroying a
// FileHandle-backed stream before EOF closes the OWNING FileHandle (a later
// createReadStream on it throws ERR_OUT_OF_RANGE "fd … Received -1"), and several
// callers here destroy their source on a failure path (crypt.ts's onFailCleanup,
// crypt.ts's wrongKeyRejects) or run two streams concurrently (restore's two inspection
// passes). One aborted phase would then pull the descriptor out from under every phase
// after it. A Readable driven by positional FileHandle.read() has no such coupling:
// destroy() touches nothing but the stream, and concurrent streams cannot disturb each
// other because every read carries its own absolute offset.
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fmtBytes } from './util.js';

// Big enough that the extra read pass this design adds is bound by disk throughput
// rather than by syscall count, small enough that the several streams a restore has in
// flight (two concurrent inspection passes, then the extraction) stay bounded. Measured
// on one machine restoring a 1.2 GiB artifact: 235-269 MB peak RSS and 19.6-21.4s across
// three runs (a fourth read 31s, which looks like thermal noise rather than a fourth
// behaviour — it is left in the range rather than dropped), against 211 MB / 15.0s for
// the pre-#785 code, which read the file one time fewer and hashed none of the passes.
// A 1 MiB chunk measured slightly worse on both axes. What the measurement is actually
// for is the shape, not the seconds: memory stays flat in the artifact's size, so
// nothing here is buffering the ciphertext.
const READ_CHUNK_BYTES = 256 * 1024;

const { O_RDONLY, O_NONBLOCK } = constants;

// How much of the front of the file every read — whole or partial — is pinned on. 64 is
// what verify's age-header sniff asks for, and a stream's first chunk is 256 KiB, so both
// kinds of reader always have at least this much unless the file itself is shorter (in
// which case they both see all of it and still agree).
const HEAD_BIND_BYTES = 64;

/**
 * A stream over the pinned bytes that knows what it delivered. `digest` is the sha256
 * of everything the stream produced, and is set the moment it reaches EOF — so a
 * consumer that has finished reading (crypt.ts's decryptToChild, once its pipeline
 * settles) can report the digest of exactly what it decrypted without hashing the same
 * bytes a second time. Measured: recomputing it in the consumer instead roughly doubled
 * restore's wall clock on a 1.2 GiB artifact, since the inspection and extraction
 * passes would each hash twice.
 */
export interface PinnedReadable extends Readable {
  readonly digest?: string;
}

export interface OpenedRestoreArtifact {
  /** The path it was opened from — for message text ONLY; never re-opened by it. */
  readonly path: string;
  /** Size as of the open, from fstat on this descriptor (never a second stat by path). */
  readonly size: number;
  /** A fresh, independent stream over the pinned bytes, from offset 0 to EOF. */
  createReadStream(): PinnedReadable;
  /** Streamed sha256 of the pinned bytes, as lowercase hex. */
  sha256(): Promise<string>;
  /** The first `n` bytes of the pinned artifact, decoded as UTF-8 (header sniffing). */
  readHead(n: number): Promise<string>;
  /**
   * The sha256 of every stream this owner handed out that ran to EOF, in completion
   * order (#785, Codex review). This is what lets a caller bind ALL of its phases and
   * not merely the last one: the signature check and the entry inspection each read
   * through here, so a writer who shows genuine bytes to those two and attacker bytes
   * to the baseline+extraction pair leaves two different values in this list even
   * though the extraction digest matches the baseline. Two distinct values means the
   * inode was rewritten mid-run.
   *
   * Streams that were destroyed before EOF are deliberately absent — a partial read
   * cannot be compared against a whole-file digest. Those are covered by
   * observedHeads() instead.
   */
  completedDigests(): readonly string[];
  /**
   * The sha256 of the first HEAD_BIND_BYTES bytes as seen by EVERY read, whole or
   * partial — each readHead() call and the first chunk of each stream (#785, Codex
   * review round 3). completedDigests() alone leaves two readers unbound: verify's
   * header sniff, which is a positional read of 64 bytes and hashes nothing, and its
   * negative control, which aborts at the age header so its stream never completes. On
   * a public-key-only box with an unsigned artifact and no --sha256 those are the ONLY
   * reads verify makes, so without this a writer could show one header to the
   * `age_header` check and different bytes to everything else and still get a verdict.
   */
  observedHeads(): readonly string[];
  /**
   * Refuse this artifact if it is bigger than `maxBytes` — immediately when the fstat
   * size already exceeds it, and from here on for the bytes every stream actually
   * delivers. The fstat check alone is not enough: a writer can enlarge the inode after
   * it, and every stream here reads to the inode's CURRENT end (Codex review).
   *
   * A method rather than an open option because the two callers want different things
   * from the SAME descriptor — `verify` reports on an artifact of any size, while the
   * `restore` it may go on to drill must not extract past #218's cap. Tightening only;
   * calling it twice keeps the smaller limit.
   */
  limitBytes(maxBytes: number): void;
  close(): Promise<void>;
}

// Open `path` once for reading and hand back the owner every phase reads through. The
// caller owns the returned object's lifetime and MUST close() it in a `finally`.
export async function openRestoreArtifact(path: string): Promise<OpenedRestoreArtifact> {
  // O_NONBLOCK, not a plain 'r' (Codex review): opening a FIFO read-only BLOCKS on POSIX
  // until a writer shows up, so `--in` naming a FIFO would hang here forever — before the
  // regular-file check below, and out of reach of every timeout in the pipeline. The flag
  // is ignored for regular files, which is all this ever goes on to read; requireFile()'s
  // access() upstream does not distinguish a FIFO from a file, and could not close the
  // window between its check and this open anyway.
  const handle = await open(path, O_RDONLY | O_NONBLOCK);
  let size: number;
  try {
    const st = await handle.stat();
    // fstat on the descriptor we are about to read, not stat() on the path — a
    // directory (or a device) reached this far would otherwise only surface later as a
    // raw EISDIR out of the middle of a decrypt pipeline.
    if (!st.isFile()) throw new Error(`${path} is not a regular file — refusing to read it as an artifact`);
    size = st.size;
  } catch (e) {
    await handle.close().catch(() => {});
    throw e;
  }
  return makeOpenedArtifact(path, size, handle);
}

// Same wording restore.ts threw before this moved here, so the operator-facing text of
// an over-cap refusal is unchanged; `atLeast` only marks the streaming form, where the
// count is where reading stopped rather than the whole file's size.
function overCapError(path: string, observed: number, maxBytes: number, atLeast: boolean): Error {
  return new Error(
    `${path} is ${atLeast ? 'at least ' : ''}${fmtBytes(observed)}, over the ${fmtBytes(maxBytes)} restore cap — refusing to extract`,
  );
}

function makeOpenedArtifact(path: string, size: number, handle: FileHandle): OpenedRestoreArtifact {
  const completed: string[] = [];
  const heads: string[] = [];
  let maxBytes: number | undefined;
  // `bytes` is whatever that reader got hold of first; only its first HEAD_BIND_BYTES
  // are pinned, so a 64-byte header sniff and a 256 KiB first chunk are comparable.
  const recordHead = (bytes: Buffer) => {
    heads.push(createHash('sha256').update(bytes.subarray(0, HEAD_BIND_BYTES)).digest('hex'));
  };
  const createReadStream = (): PinnedReadable => {
    let pos = 0;
    // Accumulated across chunks rather than taken from the first one (Codex review round
    // 4): a read on a regular file may legally come back short, so a stream whose first
    // chunk held 32 bytes would hash a 32-byte prefix while readHead(64) hashes 64 and
    // the two would "disagree" about an unchanged file — a false CB-E026. Recorded once,
    // as soon as HEAD_BIND_BYTES are in hand OR at EOF, whichever comes first; recording
    // at EOF matters even when the prefix is EMPTY, since a writer who truncates the
    // inode to nothing between two readers would otherwise leave nothing to compare.
    let headBuf = Buffer.alloc(0);
    let headRecorded = false;
    const takeHead = (chunk: Buffer | null) => {
      if (headRecorded) return;
      if (chunk) headBuf = Buffer.concat([headBuf, chunk.subarray(0, HEAD_BIND_BYTES - headBuf.length)]);
      if (headBuf.length >= HEAD_BIND_BYTES || chunk === null) {
        headRecorded = true;
        recordHead(headBuf);
      }
    };
    // Every stream hashes what it delivers, so the binding covers whatever phase is
    // consuming it without that phase having to know about any of this — and hashing it
    // HERE, once, is what lets the consumer read the result off `digest` instead of
    // making a second pass of its own.
    const running = createHash('sha256');
    let digest: string | undefined;
    const stream: PinnedReadable = new Readable({
      highWaterMark: READ_CHUNK_BYTES,
      read() {
        const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        handle.read(buf, 0, READ_CHUNK_BYTES, pos).then(
          ({ bytesRead }) => {
            if (bytesRead === 0) {
              takeHead(null); // EOF before HEAD_BIND_BYTES — pin whatever prefix existed
              digest = running.digest('hex');
              completed.push(digest);
              this.push(null);
              return;
            }
            pos += bytesRead;
            if (maxBytes !== undefined && pos > maxBytes) {
              this.destroy(overCapError(path, pos, maxBytes, true));
              return;
            }
            const chunk = buf.subarray(0, bytesRead);
            // The front of the file as THIS reader saw it, recorded even though the
            // stream may never reach EOF — that is what binds the partial readers
            // (verify's negative control) that completedDigests() cannot cover.
            takeHead(chunk);
            running.update(chunk);
            this.push(chunk);
          },
          // Including "the descriptor is already closed" — a stream that outlives its
          // owner fails loudly here instead of silently reporting a short read as EOF.
          (err: unknown) => this.destroy(err instanceof Error ? err : new Error(String(err))),
        );
      },
    });
    Object.defineProperty(stream, 'digest', { get: () => digest, enumerable: true });
    return stream;
  };
  // Reads the file, but computes no hash of its own: the stream already keeps a running
  // sha256 (that is what feeds the cross-phase binding), so this drains it and takes the
  // result. A caller wanting a DIFFERENT algorithm — minisign's BLAKE2b-512, in
  // checkArtifactSignature — hashes the stream itself instead.
  const sha256 = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const s = createReadStream();
      s.resume();
      s.on('end', () => {
        // Set by the stream itself at EOF; the `??` is a type-level formality.
        resolve(s.digest ?? '');
      });
      s.on('error', reject);
    });
  return {
    path,
    size,
    createReadStream,
    completedDigests: () => completed,
    observedHeads: () => heads,
    limitBytes: (n: number) => {
      maxBytes = maxBytes === undefined ? n : Math.min(maxBytes, n);
      if (size > maxBytes) throw overCapError(path, size, maxBytes, false);
    },
    sha256,
    // Loops rather than trusting one read() to fill the buffer (Codex review): a read
    // on a regular file may legally come back short before EOF, and a short first read
    // here would make an age header look truncated — a FAIL on a perfectly good file.
    readHead: async (n: number) => {
      const buf = Buffer.allocUnsafe(n);
      let filled = 0;
      while (filled < n) {
        const { bytesRead } = await handle.read(buf, filled, n - filled, filled);
        if (bytesRead === 0) break; // EOF: the file is shorter than n
        filled += bytesRead;
      }
      const head = buf.subarray(0, filled);
      // Only a request for at least the pinned prefix can be compared with the streams'
      // (a shorter one would hash a shorter span and always look like a change). Every
      // caller today asks for 64; the guard keeps a future shorter one from failing
      // closed on nothing.
      if (n >= HEAD_BIND_BYTES) recordHead(head);
      return head.toString('utf8');
    },
    close: () => handle.close(),
  };
}
