// restore + verify — the decrypt half and its falsifiable proof.
import { rm, stat, readFile, writeFile, readdir, rename, lstat } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Decrypter } from 'age-encryption';
import {
  AGE_MAGIC,
  CIPHER_YES,
  IDENTITY,
  PIPE_TIMEOUT_MS,
  SIGN_RECIPIENT,
  NON_CONTENT_ADDRESSED_BACKENDS,
  MANIFEST_SCHEMA_VERSION,
  pgTool,
} from './config.js';
import { run } from './proc.js';
import { loadIdentities, newDecrypter, decryptToChild, wrongKeyRejects } from './crypt.js';
import { checkArtifactSignature } from './minisign.js';
import { exists, requireFile, sha256, readHead, fmtBytes, redactPgConn, errMsg, rmrf } from './util.js';
import {
  installStageSignalGuard,
  setActiveRestoreOutDir,
  setActiveRestoreScratchDir,
  setActiveVerifyScratchDir,
} from './signal-guard.js';
import { didYouMean, nearestName } from './suggest.js';
import { moodForVerdict, printMascot, printJson } from './ui.js';
import { pull, signatureGap } from './pushpull.js';
import { recordAudit } from './audit.js';
import type { CliOptions } from './types.js';

// #228: this file's StrykerJS mutation run (`npm run mutation-test`) is deliberately
// scoped, with the ignore-comment markers below, to ONLY isSafeComponentName(),
// shortSourceLabel() (formerly encodeSourcePath(), renamed by #423), and sourceDigest()
// (added by #423) — the manifest-field guards PR #198's review finding was about, and
// the ones scripts/selftest-properties.mjs property-tests. Everything else
// in this file (the tar/pg_restore process orchestration, signal-guard wiring, the
// verify() report) has no fast in-process test oracle for Stryker to run per mutant —
// mutating it would only produce "survived" noise, not a security signal. See
// stryker.conf.json's own header comment for the full scope statement.
// Stryker disable all

// GNU tar's --keep-old-files, unlike bsdtar's identically-named flag, treats an
// existing-file collision as a FATAL error (exit 2, "Cannot open: File exists")
// rather than silently skipping it — so on Linux the very protection this flag is
// meant to give would instead trip the SAME code path that handles a truncated/
// corrupt artifact, misreporting "a file was protected" as "the restore failed"
// (#112 fix regressed ubuntu-latest CI, both Node 22 and 24 — confirmed locally
// against a real GNU tar 1.35 via `brew install gnu-tar`). GNU tar's
// --skip-old-files is the flag that actually matches bsdtar's --keep-old-files
// semantics (skip existing files silently, exit 0) — but bsdtar does not
// understand --skip-old-files at all ("Option --skip-old-files is not
// supported"), so neither flag alone behaves the same on both. Detect the tar
// flavor once via `tar --version` (GNU tar's output starts with "tar (GNU tar)
// …"; bsdtar's does not mention GNU at all) and pick whichever flag gives the
// SAME behavior (skip silently, exit 0) on it.
async function tarNoClobberFlag(): Promise<string> {
  try {
    const { out } = await run('tar', ['--version']);
    return out.includes('GNU tar') ? '--skip-old-files' : '--keep-old-files';
  } catch {
    return '--keep-old-files'; // conservative default if `tar --version` itself fails to run
  }
}

// ---- pre-extraction entry inspection (#218) ----
//
// bsdtar and GNU tar each ALREADY refuse some dangerous entries at extraction time —
// confirmed empirically against both (bsdtar 3.5.3/libarchive 3.7.4 on macOS, GNU tar
// 1.35 via `brew install gnu-tar`, the same tool tarNoClobberFlag() above already needed
// to test against a real GNU tar locally): both refuse a member name containing a `..`
// path component, and both refuse to extract a LATER entry THROUGH an existing symlink
// (the classic tar path-traversal-through-symlink attack OWASP's page and this issue cite
// — libarchive's ARCHIVE_EXTRACT_SECURE_SYMLINKS equivalent). But neither refuses a
// FIFO/device/socket entry outright — a non-root run only fails on a device node because
// mknod() itself needs privilege, so a privileged restore would still create one — and
// both merely STRIP a leading absolute-path slash with a stderr warning restore has never
// read, rather than refusing the entry. And by the time either tar exits non-zero on some
// LATER bad entry, every entry BEFORE it in archive order has already been written to
// disk — two different tar implementations giving two different PARTIAL guarantees is
// exactly what this issue means by "tar自体の安全性をtar実装任せにしている".
//
// So restore lists every entry TWICE before extracting a single byte: once bare
// (`tar -tf`, exact member names, one per line — identical text on both tar flavors,
// verified empirically above) and once verbose (`tar -tv`, whose FIRST character is the
// same ls(1)-style type indicator on both flavors, and whose "name -> target" /
// "name link to target" suffix convention for symlink/hardlink entries is likewise
// identical on both — also verified empirically). The two listings are zipped together
// BY POSITION (same archive, read twice by the same tar binary, in the same
// deterministic entry order) rather than parsed out of the verbose line's owner/group/
// size/date columns, whose width and format differ between GNU tar and bsdtar (e.g.
// bsdtar: "Jan  1  1970", GNU tar: "1970-01-01"). Only after every entry passes
// validateRestoreEntries() does extraction — into an ISOLATED scratch directory, never
// straight into --out-dir, see restoreImpl below — even start.
//
// One known asymmetry (empirically confirmed, not just claimed): GNU tar's `-tv` line
// for a hardlink whose target escapes the tree already has the leading `../` stripped
// by GNU tar ITSELF before restore.ts ever reads the line (with its own
// "Removing leading '../../' from hard link targets" stderr warning) — so
// validateRestoreEntries() sees an already-sanitized, in-tree-looking target and never
// throws its own message for this one case on GNU tar. bsdtar's `-tv` shows the raw,
// unsanitized target, so validateRestoreEntries() DOES catch it there. This is not a
// security gap: GNU tar's own extraction then refuses the same entry a second time
// (the sanitized relative target does not exist in the archive), so the hardlink is
// never created on either tar flavor — just via a different, tar-owned error message
// on GNU tar rather than this file's own. scripts/selftest-restore-security.sh's
// hardlink-escape case accepts either message for exactly this reason.

type RestoreEntryType = 'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo' | 'device' | 'socket' | 'other';

// The first character of a `tar -tv` line is the same ls(1)-style type indicator on both
// bsdtar and GNU tar (verified empirically — see the comment above): '-' regular file,
// 'd' directory, 'l' symlink, 'h' hardlink, 'p' FIFO, 'c'/'b' character/block device,
// 's' socket. Anything else maps to 'other' rather than throwing here — validation
// (not parsing) is what decides whether an entry is safe, so an unrecognized/exotic type
// character falls through to be handled like any other non-allowlisted type.
const RESTORE_ENTRY_TYPE_BY_CHAR: Record<string, RestoreEntryType> = {
  '-': 'file',
  d: 'dir',
  l: 'symlink',
  h: 'hardlink',
  p: 'fifo',
  c: 'device',
  b: 'device',
  s: 'socket',
};

interface RestoreEntry {
  name: string;
  type: RestoreEntryType;
  linkTarget?: string; // symlink/hardlink only — the text after " -> " / " link to "
}

function hasDotDotSegment(p: string): boolean {
  return p.split('/').includes('..');
}

// Zip the bare (`-tf`) name list and the verbose (`-tv`) line list into one RestoreEntry
// per member — see the big comment above. A length mismatch would mean the two listings
// somehow disagree on how many entries this archive has, which should never happen
// (same archive, same tar binary, read twice) — refuse rather than guess which one to
// trust when it does.
function zipRestoreEntries(bareNames: string[], verboseLines: string[]): RestoreEntry[] {
  if (bareNames.length !== verboseLines.length) {
    throw new Error(
      `archive inspection: bare listing has ${bareNames.length} entries but verbose listing has ${verboseLines.length} — refusing to trust either`,
    );
  }
  return bareNames.map((name, i) => {
    const line = verboseLines[i];
    const type = RESTORE_ENTRY_TYPE_BY_CHAR[line.charAt(0)] ?? 'other';
    let linkTarget: string | undefined;
    if (type === 'symlink') {
      const marker = line.lastIndexOf(' -> ');
      if (marker !== -1) linkTarget = line.slice(marker + 4);
    } else if (type === 'hardlink') {
      const marker = line.lastIndexOf(' link to ');
      if (marker !== -1) linkTarget = line.slice(marker + 9);
    }
    return { name, type, linkTarget };
  });
}

// Reject the WHOLE archive outright if ANY entry looks unsafe — see the big comment
// above. Throws on the first problem found (restoreImpl never sees a partially-vetted
// archive: this either runs to completion or throws, always BEFORE extraction starts).
function validateRestoreEntries(entries: RestoreEntry[]): void {
  const names = new Set(entries.map((e) => e.name));
  for (const e of entries) {
    const label = sanitizeForDisplay(e.name);
    if (e.name.length === 0) throw new Error('archive contains an entry with an empty name — refusing to extract');
    if (e.name.startsWith('/')) {
      throw new Error(`archive entry "${label}" has an absolute path — refusing to extract (path traversal)`);
    }
    if (hasDotDotSegment(e.name)) {
      throw new Error(`archive entry "${label}" contains a ".." path segment — refusing to extract (path traversal)`);
    }
    // No legitimate cypher-brain snapshot ever contains a FIFO/device/socket — snapshot()
    // only ever archives files, directories and symlinks (see snapshot.ts's ScanEntry
    // kind). Refuse outright rather than let tar attempt (and, run as root, succeed at)
    // creating one.
    if (e.type === 'fifo' || e.type === 'device' || e.type === 'socket') {
      throw new Error(
        `archive entry "${label}" is a ${e.type} entry — refusing to extract (no legitimate use in a cypher-brain snapshot)`,
      );
    }
    // This IS the allowlist: a type character RESTORE_ENTRY_TYPE_BY_CHAR does not
    // recognize (a GNU tar extension, a sparse/contiguous-file record, a pax header
    // leaking through) maps to 'other' and must be refused here — the big comment above
    // RESTORE_ENTRY_TYPE_BY_CHAR says exactly this ("validation, not parsing, decides
    // whether an entry is safe"), so an exotic type falling through UNREJECTED would
    // contradict it and let tar attempt to create whatever that type is.
    if (e.type === 'other') {
      throw new Error(
        `archive entry "${label}" is an unrecognized entry type — refusing to extract (not on the allowlist of file/dir/symlink/hardlink)`,
      );
    }
    // A hardlink's target names ANOTHER member of this SAME archive — a target that
    // escapes the tree (absolute, or a `..` component) has no legitimate purpose here.
    if (e.type === 'hardlink' && e.linkTarget !== undefined) {
      if (e.linkTarget.startsWith('/') || hasDotDotSegment(e.linkTarget)) {
        throw new Error(
          `archive entry "${label}" is a hardlink to "${sanitizeForDisplay(e.linkTarget)}" — refusing to extract (hardlink target escapes the archive tree)`,
        );
      }
    }
    // Symlink TARGETS are not rejected here on their own — snapshot() deliberately
    // archives a dangling/absolute-target symlink source as-is (see snapshot.ts), so a
    // real restore legitimately contains those. What IS rejected: another entry in this
    // SAME archive nested under a symlink's name — the classic tar
    // path-traversal-through-symlink attack this issue and OWASP's page both describe.
    // Both tar flavors this project supports already refuse this at extraction time
    // (verified empirically — see the comment above), but restore checks it here too
    // rather than depend on that alone, which is the entire point of this phase.
    if (e.type === 'symlink') {
      const prefix = `${e.name}/`;
      for (const other of names) {
        if (other !== e.name && other.startsWith(prefix)) {
          throw new Error(
            `archive entry "${sanitizeForDisplay(other)}" is nested under symlink "${label}" — refusing to extract (path-traversal-through-symlink)`,
          );
        }
      }
    }
  }
}

const splitEntryLines = (s: string): string[] => s.split('\n').filter((l) => l.length > 0);

// The outer restore archive is never gzip-compressed (only expandComponents()'s inner
// --dir/--profile *.tar.gz components are, below) — so a decompression-bomb amplification
// is not possible on this path, and the CIPHERTEXT size is already a tight bound on how
// much restore is about to write (age's per-chunk framing overhead is a small constant,
// not a multiplier). Generous on purpose: this exists to catch a runaway/corrupted
// artifact filling a disk unattended, not to second-guess a legitimately large
// second-brain snapshot (attachments/PDFs/embeddings routinely reach several GB) — not
// exposed as a CYPHER_BRAIN_* tunable, since #218 asks for a cap, not a configurable one.
const MAX_RESTORE_INPUT_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB

// List an age-encrypted restore archive's tar entries WITHOUT writing a single byte to
// disk (`tar -t` / `tar -tv` read only the archive's headers) and validate them. The two
// listing passes run CONCURRENTLY (two independent decrypt streams over the same input
// file) rather than one after another — nothing here is a "cheaper approximation" of what
// actually gets extracted; it reads exactly what extraction will read, twice, for its
// metadata instead of once for its bytes.
async function inspectRestoreArchive(decrypter: Decrypter, inPath: string): Promise<void> {
  const [bareOut, verboseOut] = await Promise.all([
    decryptToChild(decrypter, inPath, 'tar', ['-tf', '-'], { consStdout: 'pipe', timeoutMs: PIPE_TIMEOUT_MS }),
    decryptToChild(decrypter, inPath, 'tar', ['-tvf', '-'], { consStdout: 'pipe', timeoutMs: PIPE_TIMEOUT_MS }),
  ]);
  // decryptToChild() always resolves with a string (never undefined) when consStdout is
  // 'pipe' — the `| undefined` in its return type only covers the OTHER callers
  // ('inherit'/'ignore'). The `?? ''` below is a type-level formality, not a runtime path.
  validateRestoreEntries(zipRestoreEntries(splitEntryLines(bareOut ?? ''), splitEntryLines(verboseOut ?? '')));
}

// Plain-file counterpart of inspectRestoreArchive() above, for expandComponents()'s inner
// --dir/--profile component tarballs (below) — same threat model (both come from the same
// attacker-controlled archive/manifest), same validation; this one lists an
// ALREADY-DECRYPTED gzip file already sitting on disk rather than piping tar's stdin
// through age.decrypt() first, so it runs two plain `tar` invocations instead.
async function inspectPlainArchive(archivePath: string): Promise<void> {
  const [bareRes, verboseRes] = await Promise.all([
    run('tar', ['-tzf', archivePath], { timeoutMs: PIPE_TIMEOUT_MS }),
    run('tar', ['-tzvf', archivePath], { timeoutMs: PIPE_TIMEOUT_MS }),
  ]);
  validateRestoreEntries(zipRestoreEntries(splitEntryLines(bareRes.out), splitEntryLines(verboseRes.out)));
}

// One row of the mapping restore's auto-expand step prints/writes: the ORIGINAL absolute
// source path a component was captured from (manifest.components[].source), alongside
// where its extracted content ended up under --out-dir/expanded/. Both `name` and
// `source` are stored here ALREADY sanitized (see sanitizeForDisplay) — this is the
// exact shape that reaches stdout and README.txt.
interface ExpandedRow {
  dir: string; // the expanded directory's path, relative to --out-dir (for display)
  name: string; // the component's *.tar.gz filename inside --out-dir (sanitized)
  source: string; // the original absolute source path (sanitized)
}

// The subset of snapshot.ts's ManifestComponent this file actually reads off
// already-written JSON — kept local (not imported from snapshot.ts) since restore only
// cares about a couple of fields, not the writer's exact shape, and JSON.parse's output
// is `any` regardless.
interface RestoreManifestComponent {
  name?: unknown;
  kind?: unknown;
  source?: unknown;
}

// Cap on the short, human-legible label built by shortSourceLabel() below — keeps
// `<index>-<label>` comfortably under common 255-byte filename limits, and keeps
// `ls expanded/` scannable even with many components (the point of #423).
//
// Exported (#228, kept through #423's rename) so scripts/selftest-properties.mjs can
// state its length-bound property in terms of the same constant, instead of a second,
// driftable copy of 64.
export const SHORT_LABEL_MAX = 64;

// Build the short, human-legible label used for an expanded component's directory name:
// just the final path segment (basename) of the component's original absolute source
// path, then sanitized to a filesystem-safe fragment (drop anything that is not an ASCII
// alnum/dot/dash/underscore) and capped at SHORT_LABEL_MAX.
//
// Deliberately does NOT use node:path's basename() (which only splits on the CURRENT
// platform's separator) — this project runs on POSIX, but manifest.components[].source
// is attacker-controlled data (see the block above) that could easily contain a
// backslash-separated path (a forged/foreign manifest, or a snapshot taken elsewhere and
// restored here); on POSIX, path.basename() would treat the whole thing as one segment
// (no split) and hand it straight to the sanitize step below, degrading right back to
// the old fully-encoded label this function exists to avoid. Splitting on the LAST
// occurrence of either separator, regardless of host platform, keeps that a non-issue —
// the same separator-agnostic treatment the old encodeSourcePath() (see #423 below) gave
// every separator in the full path, kept here for just the one trailing segment.
//
// #423: this used to be encodeSourcePath(), which flattened the ENTIRE absolute path
// (every separator replaced, truncated-and-hashed past 160 chars) into the directory
// name itself. expandComponents() below still prefixes the directory name with the
// component's own 1-based sequence number, which is an EXACT, mathematical guarantee
// (not a probabilistic one — see sourceDigest() below for the difference) that no two
// components from the SAME manifest ever land in the same directory (manifest component
// order is stable per snapshot) — including the #181 case this scheme exists for in the
// first place (two --dir sources sharing a basename land at DIFFERENT indices, e.g.
// `001-memory-<hash>` vs `002-memory-<hash>`). But the index alone is only unique WITHIN
// one restore's manifest — restoring a SECOND, different snapshot into the SAME
// --out-dir (an explicitly supported, documented workflow: re-running restore does not
// clobber a prior expansion) could put an unrelated source at that same index, and if it
// happened to share a basename too, the two would collide into one directory (a real
// correctness bug, not just a readability one — see sourceDigest() below, which is what
// makes that PRACTICALLY, though not mathematically, negligible). Encoding the full path
// into the name (encodeSourcePath()'s approach) avoided that collision as a side effect,
// but at the cost of unreadable, 100+-character directory names for any realistic (deep)
// source path. shortSourceLabel() below keeps only the readable part; sourceDigest()
// (also appended to the directory name, see expandComponents()) keeps the collision risk
// small. The full original absolute path is still recorded, unambiguously, in
// expanded/README.txt's mapping table (written unconditionally by expandComponents()
// below) — that table, not the directory name, is the authoritative source→directory
// mapping.
//
// Deliberately NOT unique by itself (two different sources can share a basename) — it is
// only ever used together with sourceDigest() below, never alone, in the directory name
// expandComponents() builds.
//
// Exported (#228, kept through #423's rename) so scripts/selftest-properties.mjs can
// property-test, for ANY input string (manifest.components[].source is
// attacker-controlled — see the block above), that the output never contains a path
// separator — the invariant expandComponents() below relies on to build a single,
// un-escapable directory-name segment out of it.
// Stryker restore all
export function shortSourceLabel(abs: string): string {
  // Trim trailing separator(s) first so e.g. "/a/b/memory/" still yields "memory", not
  // "" (the same reason node:path's own basename() trims a trailing separator before
  // taking the last segment).
  const trimmed = abs.replace(/[/\\]+$/, '');
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const lastSegment = lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
  const safe = lastSegment.replace(/[^A-Za-z0-9._-]+/g, '_');
  return safe.length <= SHORT_LABEL_MAX ? safe : safe.slice(0, SHORT_LABEL_MAX);
}

// Stable digest of a component's FULL absolute source path — appended, alongside
// shortSourceLabel()'s basename, to the directory name expandComponents() builds below
// (`<NNN>-<label>-<digest>`). This is what keeps two DIFFERENT source paths from
// colliding into the same expanded/ directory, even across two SEPARATE restore
// invocations into the same --out-dir whose manifests happen to place a same-basename
// source at the same numeric index (see shortSourceLabel()'s doc comment above — the
// index alone only disambiguates WITHIN one manifest, not across two different ones;
// #423 review finding).
//
// Deliberately the FULL, UN-TRUNCATED hex digest (64 chars), not a shortened one —
// history worth keeping, because the same review thread arrived here by successive
// correction: an initial 8-hex-char (32-bit) truncation was flagged as an attacker
// (manifest.components[].source is attacker-controlled — see the block above) needing
// only a ~2^32 2nd-preimage search on commodity hardware to force a collision; widening
// to 16 hex chars (64 bits) was then flagged again, because an attacker able to choose
// BOTH colliding source strings (e.g. crafting two separate malicious manifests) faces
// only the ~2^32 BIRTHDAY bound, not the full 64-bit 2nd-preimage cost. Every truncation
// length just moves the argument, never closes it, and costs a tunable this file would
// have to keep re-justifying. The untruncated digest is unambiguously the standard-
// strength primitive (SHA-256's actual, widely-accepted collision resistance, the same
// guarantee git's own hash-based addressing relies on) — directory names stay
// comfortably under common 255-byte filename limits either way (label + "-" + 64 hex
// chars is still well short of that), and the READABLE part of the name (the label) is
// unaffected by the digest's length, so this costs nothing readability-wise. This is
// also SIMPLER than any truncated version (no slice(), no length constant to defend).
//
// Two restores of the exact SAME source path always produce the SAME digest, so
// re-running restore into an out-dir that already holds that source's expansion still
// merges into it via mergeNoClobber() below exactly as before, not a fresh,
// differently-named directory each time.
//
// Hashed as 'utf16le', NOT the default 'utf8' — a review finding on #423 (verified):
// manifest.components[].source is attacker-controlled (see the block above) and
// JSON.parse happily produces a JS string containing a LONE surrogate (a bare `\uD800`
// with no matching low surrogate is valid JSON, just not valid UTF-16 text). Node's
// default utf8 conversion — what .update(str) does with no second argument — replaces
// EVERY lone surrogate with the SAME U+FFFD bytes regardless of its actual code unit
// value, so two DIFFERENT forged source strings that differ only in which invalid
// surrogate they contain would hash identically (confirmed: two such strings differing
// only in a single lone-surrogate code point produced the SAME sha256 digest under
// 'utf8' — a deterministic, attacker-craftable collision that no digest LENGTH, even the
// full one used here, would have helped with). 'utf16le' encodes each UTF-16 code unit
// as its own 2 bytes with no substitution, so it is injective over the actual JS string
// (a lossless round trip of exactly what `===` string equality already compares) —
// closing that specific deterministic path entirely, leaving only a genuine SHA-256
// collision, which the full, untruncated digest above makes standard-strength
// infeasible rather than merely improbable.
//
// Exported (#423) so scripts/selftest-properties.mjs can property-test it the same way
// as shortSourceLabel() above, instead of leaving it untested/unmutated code inside this
// file's otherwise fully-scoped Stryker region (see stryker.conf.json).
export function sourceDigest(abs: string): string {
  return createHash('sha256').update(abs, 'utf16le').digest('hex');
}
// Stryker disable all

// ---- manifest.json is attacker-controlled data — the guards below are why ----
// age is public-key encryption: ANYONE holding a recipient's PUBLIC key can construct
// ciphertext encrypted to it and hand it over claiming to be "your backup" (this
// project's own key-recovery setup can even involve deliberately sharing a recipient
// public key with an offline-backup holder — see MANAGEMENT.md's "Key recovery"). A
// forged manifest.json inside such ciphertext is therefore something restore must
// defend against, not just malformed input to fail loudly on — a component's `name`/
// `source` fields must never be trusted as a safe filesystem path or a terminal-safe
// string before expandComponents() below does exactly that.

// A component's manifest `name` must be a bare filename directly under --out-dir: no
// directory separator, no dot-segment. Without this check, a forged name like
// "../../../etc/cron.d/evil.tar.gz" passed to join(outDir, name) would resolve OUTSIDE
// --out-dir entirely (path traversal via a crafted manifest).
//
// Exported (#228) so scripts/selftest-properties.mjs can property-test the actual
// security invariant PR #198 was about — for ANY string, if this returns true then
// join(outDir, name) must stay inside outDir — instead of only the handful of
// traversal strings a human thinks to hand-write.
// Stryker restore all
export function isSafeComponentName(name: string): boolean {
  if (name.length === 0 || name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}
// Stryker disable all

// Strip ASCII control characters (0x00-0x1F, 0x7F) from a manifest-derived string
// before it is ever printed to stdout/stderr or written into README.txt. A forged
// source/name value could otherwise smuggle a carriage return or ANSI escape sequence
// into terminal output or a log file — log-line forgery / terminal-escape injection —
// not merely an unreadable-but-harmless display glitch.
function sanitizeForDisplay(s: string): string {
  return s.replace(/[\x00-\x1F\x7F]/g, '?');
}

// Refuse to proceed through a pre-existing SYMLINK at `p`. mkdirSync({recursive:true})
// and a plain writeFile() both FOLLOW an existing symlink rather than refusing it — so
// a symlink planted at an otherwise-predictable expand path (e.g. by the SAME outer tar
// extract that a crafted manifest/archive already ran against --out-dir, before
// expandComponents() ever runs) could silently redirect a later tar-extract or
// README.txt write to anywhere on disk the restoring user can write, entirely outside
// --out-dir. lstat() (never stat()) is what actually SEES the symlink instead of
// resolving through it, the same discipline snapshot.ts's own symlink handling already
// follows. A path that does not exist yet is safe (nothing to follow); anything else
// that exists and is not a symlink is left for the caller's own mkdir/writeFile.
async function refuseIfSymlink(p: string, what: string): Promise<void> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) {
      throw new Error(
        `${what} at ${p} is a symlink — refusing to follow it (a crafted manifest could use this to write outside --out-dir)`,
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; // nothing there yet — safe
    throw e;
  }
}

// Merge every entry of `src` into `dest` WITHOUT ever overwriting something already
// there — the same no-clobber posture the outer restore extract keeps. Recurses only
// into subdirectories that already exist on BOTH sides; everything else (a new file, a
// new subdirectory, a symlink, or any other entry kind tar can produce, e.g. a FIFO) is
// moved into place with a single rename() rather than a byte-copy — rename works
// identically for every entry type and needs no per-kind special-casing (unlike a copy,
// which would need one path per file kind and cannot recreate some special files at
// all). Used only when re-expanding INTO an out-dir that already holds a prior
// expansion of this exact component (see expandComponents below); a first-time
// expansion instead renames the whole freshly-extracted tree into place in one atomic
// step and never calls this at all.
async function mergeNoClobber(src: string, dest: string): Promise<void> {
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    // lstat, not exists()/stat(): exists() follows symlinks, so a pre-existing `d` that
    // is a symlink to a real directory OUTSIDE dest would pass entry.isDirectory() &&
    // exists(d) and send mergeNoClobber recursing through the symlink into whatever it
    // points at — writing archive content outside dest entirely. A symlink at `d` is
    // therefore always treated as "already there, do not touch" (the no-clobber
    // fallthrough below), never as a directory to merge into.
    let dStat: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      dStat = await lstat(d);
    } catch {
      dStat = undefined;
    }
    if (entry.isDirectory() && dStat?.isDirectory()) {
      await mergeNoClobber(s, d);
    } else if (!dStat) {
      await rename(s, d);
    }
    // else: `d` already exists (a file, a symlink, or any other non-plain-directory
    // entry) — leave it (no-clobber); the finally block in expandComponents() drops
    // whatever's left under `src` (the scratch dir) once this returns.
  }
}

// #225 forward-compat guard: a manifest.json declaring a `schema` this build does not
// recognize describes a shape restore has never been taught to read. Arweave's storage
// is meant to outlive any one build of this tool — a decades-old binary silently
// reinterpreting a changed/renamed field as the one it expects is worse than refusing
// outright, so this throws (failing the whole restore) rather than letting
// expandComponents()/pg_restore below proceed on a guess. Only a manifest with NO
// `schema` field at all (every pre-#225 snapshot — `undefined`, not `null`) is treated
// as legacy and let through; anything present that isn't a plain integer in
// [1, MANIFEST_SCHEMA_VERSION] is refused — a non-numeric schema (a future format could
// just as easily change the field's TYPE, not just its number) fails closed here rather
// than silently falling through as if it were unversioned. A manifest that fails to
// parse as JSON at all is NOT this guard's concern — that is the existing best-effort
// manifest handling's job (see expandComponents' own parse guard just below).
function assertSupportedManifestSchema(manifestText: string, manifestPath: string): void {
  let schema: unknown;
  try {
    schema = (JSON.parse(manifestText) as { schema?: unknown } | null)?.schema;
  } catch {
    return; // unparsable — not this guard's concern, see above
  }
  if (schema === undefined) return; // no schema field at all — pre-#225 snapshot
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1 || schema > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `${manifestPath} declares schema ${JSON.stringify(schema)}, which this cypher-brain build (understands integer schemas 1 through ${MANIFEST_SCHEMA_VERSION}) does not recognize — ` +
        'upgrade cypher-brain before restoring this snapshot (an older build risks misreading a changed manifest shape)',
    );
  }
}

// Auto-expand every --dir/--profile component's staged tarball under
// <out-dir>/expanded/<NNN>-<short source label>-<digest>/, keyed to the component's
// ORIGINAL absolute source path (manifest.components[].source) rather than its on-disk
// name — see #181: multiple --dir sources sharing a basename (e.g. many
// `~/.claude/projects/*/memory/` dirs under --profile claude-code) all restore to
// opaque, indistinguishable names like memory.tar.gz / memory-1.tar.gz /
// memory-2.tar.gz, and manually cross-referencing the manifest to untar each one
// correctly does not scale past a handful of components. (#423: the directory NAME
// itself only carries a short, readable label — see shortSourceLabel's doc comment
// below — plus a short digest of the full path to keep collisions practically
// negligible — see sourceDigest's doc comment below — expanded/README.txt's mapping
// table is what actually resolves each directory back to its full original source
// path.)
//
// A component with a `source` field is exactly a --dir/--profile component: pg_dump's
// component (kind 'pg_dump:custom') never has one, so filtering on `source` alone already
// excludes it — restore's --pg flow (pg_restore into a live connection) and this
// filesystem-only expansion never touch the same component, and neither needs the other
// to run first.
//
// Best-effort throughout: this is a convenience layer on top of an ALREADY-successful
// restore (the outer tar extraction above has already landed every component's raw
// *.tar.gz in --out-dir) — a problem here (a malformed manifest, one corrupt archive) is
// reported on stderr and skipped rather than failing the whole restore; the raw tarballs
// restore already extracted remain there as the fallback either way.
async function expandComponents(outDir: string): Promise<void> {
  const manifestPath = join(outDir, 'manifest.json');
  if (!(await exists(manifestPath))) return; // nothing to key expansion off of
  let components: RestoreManifestComponent[];
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const raw = (parsed as { components?: unknown })?.components;
    components = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error(
      `warning: could not parse ${manifestPath} — skipping component auto-expand (${sanitizeForDisplay(errMsg(e))})`,
    );
    return;
  }
  const candidates = components.filter(
    (c): c is { name: string; source: string } =>
      typeof c.source === 'string' && typeof c.name === 'string' && c.name.endsWith('.tar.gz'),
  );
  if (candidates.length === 0) return;

  const expandedRoot = join(outDir, 'expanded');
  try {
    await refuseIfSymlink(expandedRoot, 'expand root');
  } catch (e) {
    console.error(`warning: ${errMsg(e)} — skipping component auto-expand entirely`);
    return;
  }
  mkdirSync(expandedRoot, { recursive: true });
  const rows: ExpandedRow[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    // A forged manifest `name` (e.g. "../../../etc/cron.d/evil.tar.gz") must never be
    // trusted as a path component — see the threat-model note above shortSourceLabel.
    // Reject anything that is not a bare filename and move on to the next component;
    // this is the ONLY thing that ever builds `archivePath` from `c.name`.
    if (!isSafeComponentName(c.name)) {
      console.error(
        `warning: skipping component with an unsafe manifest name "${sanitizeForDisplay(c.name)}" ` +
          '(contains a path separator or is a dot-segment) — refusing to treat manifest.json\'s "name" as a path',
      );
      continue;
    }
    const archivePath = join(outDir, c.name);
    // Absent when the outer extract's own no-clobber skip left it out (a pre-existing
    // --out-dir already held a same-named file) — nothing to expand in that case.
    if (!(await exists(archivePath))) continue;

    // The "<NNN>-" prefix EXACTLY guarantees uniqueness WITHIN this manifest; the
    // trailing sourceDigest() makes a collision ACROSS manifests practically negligible
    // (not mathematically impossible — see sourceDigest's doc comment above for exactly
    // what margin that is and why), so two different sources are not expected to collide
    // into the same directory even across separate restore runs into the same --out-dir
    // (see shortSourceLabel's and sourceDigest's doc comments above). The "<NNN>-" prefix
    // also means the full name can never itself equal "." or ".." even on a source whose
    // basename would (e.g. source === ".."), with no extra case to handle here.
    const dirName = `${String(i + 1).padStart(3, '0')}-${shortSourceLabel(c.source)}-${sourceDigest(c.source)}`;
    const targetDir = join(expandedRoot, dirName);
    try {
      await refuseIfSymlink(targetDir, 'expanded component directory');
    } catch (e) {
      console.error(`warning: ${errMsg(e)} — skipping ${sanitizeForDisplay(c.name)}`);
      continue;
    }
    // A prior run's expansion of this exact component, if any — re-running restore
    // into the same --out-dir merges into it (mergeNoClobber below) rather than
    // clobbering it; a first-time expansion instead renames the whole freshly-
    // extracted tree into place atomically (see the scratchDir handling below).
    const targetExisted = await exists(targetDir);
    // Extract into a fresh, uniquely-named SCRATCH directory first — never straight
    // into targetDir. A tar that dies mid-stream then leaves nothing behind under
    // targetDir's real name (the finally block below always removes the scratch dir),
    // instead of a half-written tree that a later no-clobber re-run could never
    // repair (no-clobber only ever SKIPS an existing name; it has no way to tell a
    // complete extraction from a truncated one).
    const scratchDir = `${targetDir}.expand-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      // #218: same pre-extraction entry inspection as the outer restore extract above
      // (this component tarball comes from the SAME attacker-controlled archive/
      // manifest) — a bad entry here is skipped like any other per-component problem
      // (see this function's "Best-effort throughout" doc comment), not a hard restore
      // failure.
      await inspectPlainArchive(archivePath);
      await refuseIfSymlink(scratchDir, 'expand scratch directory'); // defense in depth: this name should never pre-exist
      mkdirSync(scratchDir, { recursive: true });
      await run('tar', ['-xzf', archivePath, '--no-same-owner', '--no-same-permissions', '-C', scratchDir], {
        timeoutMs: PIPE_TIMEOUT_MS,
      });
      if (targetExisted) await mergeNoClobber(scratchDir, targetDir);
      else await rename(scratchDir, targetDir);
    } catch (e) {
      console.error(
        `warning: could not expand ${sanitizeForDisplay(c.name)} into ${targetDir} (${sanitizeForDisplay(errMsg(e))}) — the raw ${sanitizeForDisplay(c.name)} is still in ${outDir}`,
      );
      continue;
    } finally {
      await rm(scratchDir, { recursive: true, force: true }); // no-op once rename() has already moved it away
    }
    rows.push({
      dir: relative(outDir, targetDir),
      name: sanitizeForDisplay(c.name),
      source: sanitizeForDisplay(c.source),
    });
  }
  if (rows.length === 0) return;

  const readmePath = join(expandedRoot, 'README.txt');
  try {
    await refuseIfSymlink(readmePath, 'expanded/README.txt');
    // A prior run already wrote this mapping (re-running restore into the same
    // --out-dir reprocesses the same manifest, so the rows would be identical) —
    // leave it untouched rather than clobbering or duplicating it via append, the
    // same no-clobber posture the expanded component directories themselves keep.
    if (!(await exists(readmePath))) {
      const readmeLines = [
        '# cypher-brain restore: expanded components',
        '',
        'Each row maps a directory under expanded/ back to the ABSOLUTE path it was',
        'captured from. Nothing was written back to that original path — restore never',
        'writes over a live location automatically; review the contents and copy them back',
        'yourself if that is what you want.',
        '',
        '<expanded dir>\t<-\t<original source path>\t(<component file>)',
        ...rows.map((r) => `${r.dir}\t<-\t${r.source}\t(${r.name})`),
      ];
      await writeFile(readmePath, `${readmeLines.join('\n')}\n`);
    }
  } catch (e) {
    console.error(`warning: ${errMsg(e)} — the expanded directories above are still there, just without a README.txt`);
  }

  console.log(`expanded ${rows.length} component(s) into ${expandedRoot} (see expanded/README.txt):`);
  for (const r of rows) console.log(`  ${r.dir}  <-  ${r.source}`);
}

// restore() is shared by cli.ts AND mcp.ts's restore_now tool (mcp.ts calls it
// directly, captured through captureCall() — the mascot decoration below is on
// stderr, which mcp.ts's console-capture treats as ordinary progress output, so
// this is harmless there; an earlier version of this comment claimed cli.ts was
// the only caller, which stopped being true once restore_now was added and went
// uncorrected — fixed here while touching this function for #226). happy on a
// clean return, sad on any thrown failure (issue #194).
//
// #226: also records an audit-trail entry (src/lib/audit.ts) after restoreImpl()
// settles, success or failure — advisory only (recordAudit() never throws), and the
// caught error is rethrown UNCHANGED afterward so nothing about restoreImpl()'s own
// outcome is altered by this wrapper.
export async function restore(o: CliOptions): Promise<void> {
  const startedAt = Date.now();
  try {
    await restoreImpl(o);
  } catch (e) {
    printMascot('sad');
    await recordAudit({ command: 'restore', o, backend: null, locator: null, exitCode: 1, startedAt });
    throw e;
  }
  // Deliberately OUTSIDE the try: printMascot('happy') itself throwing (e.g. some
  // unforeseen console.error failure) must never be misreported as restoreImpl
  // failing — if it were still inside the try, that throw would land in the catch
  // above and print 'sad' + rethrow over a restore that actually already
  // succeeded (multi-model review finding on PR #200).
  printMascot('happy');
  await recordAudit({ command: 'restore', o, backend: null, locator: null, exitCode: 0, startedAt });
}

async function restoreImpl(o: CliOptions): Promise<void> {
  if (!o.in) throw new Error('--in <file.age> required');
  // #277: `--out` is what names the destination on snapshot/pull/wallet create, so
  // typing it here is the natural mistake — and parseArgs accepts it (it is a valid
  // flag SOMEWHERE) and then nothing reads it, leaving a bare "--out-dir required"
  // that reads as if no destination had been given at all. Name what was ignored.
  // #300: the "did you mean" wording itself comes from src/lib/suggest.ts, the one
  // place that phrases it — the MCP server refuses unknown tool arguments with the
  // same idiom, and two hand-written copies would drift. Only the PHRASING is shared:
  // which flag was meant is known outright here, so this message never depends on a
  // fuzzy match firing.
  if (!o.out_dir) {
    throw new Error(
      o.out
        ? `--out-dir <dir> required (restore extracts into a directory; you passed --out, which restore does not read — ${didYouMean('--out-dir')})`
        : '--out-dir <dir> required',
    );
  }
  // pg_restore --clean --if-exists below DROPS and replaces objects in the target
  // database — an irreversible operation. Same consent gate as push's paid-backend
  // guard (pushpull.ts): require --yes or CYPHER_BRAIN_YES=1 up front, before any
  // decrypt/extract work happens, mirroring the "fail before out_dir is even created"
  // discipline the identity check below already follows.
  if (o.pg && !(o.yes || CIPHER_YES)) {
    throw new Error(
      `--pg ${redactPgConn(o.pg)}: pg_restore --clean --if-exists will DROP and replace objects in that database — ` +
        `re-run restore with --yes or set CYPHER_BRAIN_YES=1 to confirm`,
    );
  }
  // #267: deliberately AFTER the consent gate above, not before it — a missing --in
  // must not demote the irreversible-pg_restore warning to second place (multi-model
  // review finding). Still before ANY decrypt work, which is the point: a missing
  // --in used to reach the age call and surface as "age decrypt failed: ENOENT …
  // [CB-E002]", a code MANAGEMENT.md documents as "wrong identity, or a corrupt/
  // truncated artifact" — a key audit in answer to a typo.
  await requireFile(o.in);
  // Authenticity check FIRST (#214), before any decryption or even the age identity
  // check below: age proves confidentiality + tamper detection, but NOT authenticity
  // (a recipient's public key is not secret — anyone holding it can forge ciphertext
  // that decrypts cleanly). A tampered/forged *.minisig always refuses outright. An
  // ABSENT signature (unsigned/legacy artifact) or an absent signing public key on this
  // box are non-fatal (warn and continue) BY DEFAULT — so this never breaks a pre-#214
  // backup or an existing setup that hasn't run `keygen --sign` — UNLESS --require-
  // signature opts into strict mode, in which case an attacker who simply deletes the
  // .minisig sidecar (rather than forging one) no longer silently succeeds either.
  // #530: verify --level drill sets skip_signature_check on the internal restoreImpl()
  // call it makes below — its own runFileChecks() already ran this EXACT check against
  // this EXACT fetched artifact, and already printed the PASS/FAIL/SKIP line for it.
  // Without this, drill's output showed the same signature-check result twice (once at
  // verify's own top level, once again — independently — from here), reading as if two
  // checks ran rather than one. verifyImpl() only ever reaches this call once its own
  // check already came back non-FAIL (a FAIL verdict short-circuits before restoreImpl()
  // is ever called, per the comment above drill's restoreOpts below), so there is nothing
  // left here to decide OR report — every other caller of restoreImpl() (the CLI's
  // `restore` command) never sets this, and runs the check exactly as before.
  if (!o.skip_signature_check) {
    const signRecipient = o.sign_recipient || SIGN_RECIPIENT;
    // An EXPLICITLY-named --sign-recipient that doesn't exist is a configuration typo,
    // not "authenticity isn't set up yet" — silently falling back to no_pubkey/SKIP here
    // would make a mistyped path look identical to a deliberately unconfigured one. Only
    // the DEFAULT path missing means "not opted in yet" (see snapshot.ts's --sign-identity
    // for the same distinction on the signing side).
    if (o.sign_recipient && !(await exists(o.sign_recipient))) {
      throw new Error(`--sign-recipient ${o.sign_recipient} does not exist`);
    }
    const sigCheck = await checkArtifactSignature(o.in, signRecipient);
    if (sigCheck.status === 'invalid') {
      throw new Error(`refusing to restore ${o.in}: ${sigCheck.reason}`);
    }
    if (sigCheck.status === 'verified') {
      console.log(`[PASS] minisign authenticity signature verified (${o.in}.minisig)`);
    } else if (o.require_signature) {
      throw new Error(`refusing to restore ${o.in}: --require-signature was given but ${sigCheck.reason}`);
    } else {
      console.error(`warning: ${sigCheck.reason}`);
    }
  }
  const identity = o.identity || IDENTITY;
  if (!(await exists(identity))) throw new Error(`no identity at ${identity} — cannot decrypt without the private key`);
  // Load the identity FIRST (this prompts for the passphrase if the file is wrapped)
  // so a wrong passphrase / unreadable identity fails before out_dir is even created.
  const decrypter = newDecrypter(await loadIdentities(identity));
  // The tar child spawned below lands in the same ACTIVE_CHILDREN set snapshot's tar
  // does (see proc.ts), but until now nothing ever installed a signal guard for
  // restore() — a SIGINT/SIGTERM/SIGHUP mid-extract hit Node's default handler, the
  // tar child was never killed, and out_dir was left with a silently partial tree
  // with no cleanup and no warning (#95). installStageSignalGuard() is idempotent, so
  // calling it here is safe whether or not a snapshot() in the same process already did.
  installStageSignalGuard();
  // #218 size cap: see MAX_RESTORE_INPUT_BYTES above for why the ciphertext's own size
  // is already a tight (not merely approximate) bound on this pipeline's extraction
  // footprint — before any inspection or decrypt work happens.
  const inSize = (await stat(o.in)).size;
  if (inSize > MAX_RESTORE_INPUT_BYTES) {
    throw new Error(
      `${o.in} is ${fmtBytes(inSize)}, over the ${fmtBytes(MAX_RESTORE_INPUT_BYTES)} restore cap — refusing to extract`,
    );
  }
  // #218 phase 1 — inspect every tar entry before a single byte is written to disk. See
  // the big comment above inspectRestoreArchive()/validateRestoreEntries().
  await inspectRestoreArchive(decrypter, o.in);

  const outDirPreExisted = await exists(o.out_dir);
  // The old mkdirSync(o.out_dir, {recursive:true}) this replaced would itself throw
  // (ENOTDIR/EEXIST) if --out-dir already existed as a non-directory — keep that same
  // fail-fast behavior explicitly now that nothing mkdir's --out-dir up front anymore
  // (phase 3 below either rename()s onto it directly or merges into it, neither of
  // which gives as clear an error against a plain file).
  if (outDirPreExisted && !(await stat(o.out_dir)).isDirectory()) {
    throw new Error(`--out-dir ${o.out_dir} exists and is not a directory`);
  }
  // #218 phase 2 — extract into an ISOLATED scratch directory, never straight into
  // --out-dir. Same reasoning expandComponents() below already applies per component: a
  // tar that dies mid-stream then leaves nothing behind under out-dir's real name
  // (nothing has been promoted into it yet), instead of a half-written tree that a later
  // run could only ever partially repair (no-clobber can SKIP an existing name, it has no
  // way to tell a complete extraction from a truncated one). Named the same way
  // expandComponents()'s own per-component scratch dir is (a sibling path, not a nested
  // one — mkdtemp under os.tmpdir() would risk landing on a different filesystem than
  // --out-dir, turning the atomic rename() below into a cross-device copy).
  const scratchDir = `${o.out_dir}.restore-${process.pid}-${randomBytes(4).toString('hex')}`;
  await refuseIfSymlink(scratchDir, 'restore scratch directory'); // defense in depth: this name should never pre-exist
  mkdirSync(scratchDir, { recursive: true });
  // Register the scratch dir BEFORE the tar child starts (mkdirSync + this call, no
  // await in between — same no-event-loop-yield discipline the removed outDirPreExisted
  // comment used to describe): a signal landing mid-extract now erases the scratch dir
  // outright (see setActiveRestoreScratchDir in signal-guard.ts) rather than leaving a
  // partial tree with no cleanup and no warning.
  setActiveRestoreScratchDir(scratchDir);
  // decrypt(in) | tar -xf - -C scratchDir
  // --no-same-owner/--no-same-permissions: a substituted/forged archive must not be
  // able to set hostile ownership or modes on extraction (defense-in-depth — the
  // bytes can be attacker-chosen if storage is compromised; see verify --sha256). The
  // no-clobber flag (see tarNoClobberFlag above) still matters here even though
  // scratchDir starts empty: it is what keeps this call's OWN behavior identical
  // (skip a colliding name, exit 0) on both tar flavors, rather than a flavor-specific
  // fatal-vs-skip split showing up as a mysterious extraction failure.
  const noClobberFlag = await tarNoClobberFlag();
  try {
    await decryptToChild(
      decrypter,
      o.in,
      'tar',
      ['-xf', '-', '--no-same-owner', '--no-same-permissions', noClobberFlag, '-C', scratchDir],
      { timeoutMs: PIPE_TIMEOUT_MS },
    );
  } catch (e) {
    await rm(scratchDir, { recursive: true, force: true });
    setActiveRestoreScratchDir(null);
    throw e;
  }
  setActiveRestoreScratchDir(null);

  // #218 phase 3 — promote atomically, only now that extraction of an ALREADY-VETTED
  // archive fully succeeded: a fresh --out-dir gets the whole scratch tree renamed into
  // place in one step (rename() onto a non-existent destination path both creates it and
  // is atomic); an --out-dir that already held content merges into it without ever
  // clobbering an existing name — the SAME no-clobber/atomic-rename policy
  // expandComponents()'s mergeNoClobber()/rename() split already keeps for each inner
  // component below, converged here for the outer extract too.
  setActiveRestoreOutDir(o.out_dir, outDirPreExisted);
  try {
    if (!outDirPreExisted) await rename(scratchDir, o.out_dir);
    else await mergeNoClobber(scratchDir, o.out_dir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true }); // no-op once rename() has already moved it away
    // the promotion is settled (cleanly, or the above already threw) — a later signal
    // (e.g. during pg_restore below) must not touch out_dir anymore.
    setActiveRestoreOutDir(null);
  }
  console.log(`restored components into ${o.out_dir}`);
  const manifestPath = join(o.out_dir, 'manifest.json');
  if (await exists(manifestPath)) {
    const manifestText = await readFile(manifestPath, 'utf8');
    // #436: the raw manifest.json (tool/schema/host/created_at, every component's
    // original absolute SOURCE path, digests) used to print here UNCONDITIONALLY,
    // ahead of the actually-useful "expanded N component(s) into …" summary and (for
    // verify --level drill, which replays this function's captured stdout) the
    // VERDICT below it — a wall of JSON a human had to scroll past, and an incidental
    // stdout leak of two fields worth gating: `host` (the hostname of whatever machine
    // ran `snapshot` — see snapshot.ts's `hostname()` call — not necessarily this one)
    // and each component's original absolute source path ON that machine. --verbose
    // opts back into seeing it; assertSupportedManifestSchema still runs either way —
    // that guard's job (refuse a manifest schema this build can't safely read) has
    // nothing to do with whether its text gets printed.
    if (o.verbose) console.log(manifestText);
    assertSupportedManifestSchema(manifestText, manifestPath);
  }
  // Auto-expand --dir/--profile components (#181) — independent of --pg below: it only
  // ever touches components that carry a `source`, which pg_dump's never does, so the two
  // flows never race or duplicate work, and neither has to run before the other. --no-
  // expand-components is the opt-out for anyone who wants exactly the pre-#181 behavior
  // (raw *.tar.gz files only, manual untar).
  if (!o.no_expand_components) await expandComponents(o.out_dir);
  if (o.pg) {
    const dump = join(o.out_dir, 'db.dump');
    if (!(await exists(dump))) throw new Error(`--pg given but no db.dump in snapshot`);
    await run(pgTool('pg_restore'), ['--no-owner', '--no-privileges', '--clean', '--if-exists', '-d', o.pg, dump], {
      timeoutMs: PIPE_TIMEOUT_MS,
    });
    console.log(`pg_restore -> ${redactPgConn(o.pg)} done`);
  }
}

// The result runFileChecks() computes over one already-on-disk *.age file — the same
// shape verify --level quick always reported, factored out so --level remote/drill (#209
// below) can run the identical checks against a file they just pulled into a scratch
// location, instead of a second, divergent implementation of "is this ciphertext good".
interface FileCheckResult {
  file: string;
  sizeBytes: number;
  checks: {
    age_header: boolean;
    sha256_match: boolean | null;
    signature: 'pass' | 'fail' | 'skip';
    wrong_key_rejected: boolean | 'skip';
    positive_control: 'pass' | 'fail' | 'skip';
  };
  verdict: 'PASS' | 'FAIL' | 'PARTIAL';
}

// The human-readable "VERDICT: …" line's wording, factored out of runFileChecks below so
// finishVerify can print the SAME sentence for a verdict runFileChecks itself was told
// NOT to print yet (--level drill's FAIL/PARTIAL early-return, below — its overall
// verdict still depends on a restore step that never runs in that case, so the line
// belongs to finishVerify there, not to runFileChecks) — one wording, not two copies
// that could drift apart on the PARTIAL sentence (#209 review).
function printFileCheckVerdict(verdict: 'PASS' | 'FAIL' | 'PARTIAL'): void {
  if (verdict === 'FAIL') console.log('\nVERDICT: FAIL');
  else if (verdict === 'PARTIAL') {
    console.log(
      '\nVERDICT: PARTIAL — header + wrong-key checks passed, but decryptability was NOT proven on this box (no private identity here). Run verify where the identity lives to prove it is restorable by you.',
    );
  } else {
    console.log('\nVERDICT: PASS');
  }
}

// runFileChecks is the falsifiable half. Three checks:
//   1. it is real age ciphertext (header),
//   2. a WRONG key is rejected (negative control), and
//   3. when the private identity is on THIS machine, that identity decrypts the
//      whole artifact into a well-formed bundle (positive control) — this is what
//      makes PASS mean "restorable by you", and it catches truncation/corruption
//      that a wrong-key test alone would miss.
// On a public-key-only box the positive control is skipped (no identity present),
// so verify there attests only the header + that a stranger's key cannot read it —
// and reports VERDICT: PARTIAL (exit 2), never PASS, so it is not read as proof the
// snapshot is restorable by you.
//
// Prints its own narrative (gated by !o.json, exactly like verify always has) and sets
// process.exitCode to match ITS verdict — a caller that goes on to do more after this
// (verify --level drill's full-restore step, below) simply sets process.exitCode again
// once it knows the combined outcome; whichever runs last wins, so nothing needs undoing.
// `printVerdictLine` only suppresses the "VERDICT: …" line itself (still gated by !o.json
// either way) — --level drill passes false here because ITS verdict depends on a step
// that hasn't run yet when this returns, and printing an interim one would be read as
// final.
async function runFileChecks(o: CliOptions, printVerdictLine: boolean): Promise<FileCheckResult> {
  if (!o.in) throw new Error('--in <file.age> required');
  await requireFile(o.in); // #267: before stat(), so a typo is not a raw ENOENT
  const sz = (await stat(o.in)).size;
  const head = await readHead(o.in, 64);
  const isAge = head.startsWith(AGE_MAGIC);
  if (!o.json) {
    console.log(`file: ${o.in} (${fmtBytes(sz)})`);
    console.log(`[${isAge ? 'PASS' : 'FAIL'}] age ciphertext header present`);
  }

  // optional integrity pin: --sha256 binds the artifact to a hash known out-of-band
  // (e.g. from a trusted off-box index.tsv), catching a rolled-back/substituted
  // ciphertext that age would still decrypt. A mismatch is a hard FAIL. `hashOk` stays
  // `null` (not checked, not a pass/fail) when --sha256 was not given at all.
  let hashOk: boolean | null = null;
  let gotHash: string | undefined;
  if (o.sha256) {
    gotHash = await sha256(o.in);
    hashOk = gotHash.toLowerCase() === String(o.sha256).toLowerCase();
    if (!o.json) {
      console.log(
        `[${hashOk ? 'PASS' : 'FAIL'}] sha256 matches the expected hash${hashOk ? '' : ` (expected ${o.sha256}, got ${gotHash})`}`,
      );
    }
  }

  // authenticity (#214): does a *.minisig sidecar next to --in verify against the
  // configured signing public key? `null` (not 'pass'/'fail') when there is nothing
  // to check — no sidecar (unsigned/legacy artifact) or no signing public key on this
  // box — mirrors hashOk's own null-means-skipped contract above; a tampered/forged
  // signature is the only case this fails, and (per #214) it also SKIPS the positive
  // control below rather than decrypting an artifact already known to be untrustworthy.
  const signRecipient = o.sign_recipient || SIGN_RECIPIENT;
  // An EXPLICITLY-named --sign-recipient that doesn't exist is a configuration typo,
  // not "authenticity isn't set up yet" (see restoreImpl's identical guard above).
  if (o.sign_recipient && !(await exists(o.sign_recipient))) {
    throw new Error(`--sign-recipient ${o.sign_recipient} does not exist`);
  }
  const sigCheck = await checkArtifactSignature(o.in, signRecipient);
  let sigOk: boolean | null = sigCheck.status === 'verified' ? true : sigCheck.status === 'invalid' ? false : null;
  // --require-signature (#214): an absent signature or absent signing public key is a
  // SKIP by default (backward compatible with unsigned/pre-#214 artifacts) — this
  // upgrades that to a hard FAIL, so an attacker who deletes the .minisig sidecar
  // instead of forging one no longer silently passes either, for callers who opt in.
  if (sigOk === null && o.require_signature) sigOk = false;
  if (!o.json) {
    if (sigOk === null) console.log(`[SKIP] minisign authenticity signature — ${sigCheck.reason}`);
    else
      console.log(
        `[${sigOk ? 'PASS' : 'FAIL'}] minisign authenticity signature verified${sigOk ? '' : ` (${sigCheck.reason})`}`,
      );
  }

  // negative control: a throwaway key must NOT decrypt (header-only check — fast on any
  // size). Skipped when the signature above is already known INVALID — every decrypt
  // attempt against an artifact known to be tampered/forged is one this module claims
  // never happens once authenticity fails (#214), and this is itself a decrypt attempt
  // (with a throwaway key, but still one), so it must not run either.
  let wrongKeyRejected = true;
  let wrongKeyCheckSkipped = false;
  if (sigOk === false) {
    wrongKeyCheckSkipped = true;
    if (!o.json) console.log('[SKIP] a wrong key is rejected — skipped (the authenticity signature above failed)');
  } else {
    wrongKeyRejected = await wrongKeyRejects(o.in);
    if (!o.json) console.log(`[${wrongKeyRejected ? 'PASS' : 'FAIL'}] a wrong key is rejected`);
  }

  // positive control: your identity decrypts the whole thing into a well-formed
  // bundle. Streamed (decrypt | tar -t) so it never buffers a multi-GB plaintext.
  // Skipped outright (never attempted) when the signature above was checked and found
  // INVALID — decrypting an artifact already known to be tampered/forged proves
  // nothing and (per #214) restore's own equivalent check refuses outright rather
  // than decrypt, so verify's report should not imply this one just "went ahead".
  const identity = o.identity || IDENTITY;
  let positiveOk = true;
  let positiveSkipped = false;
  if (sigOk === false) {
    positiveSkipped = true;
    if (!o.json) console.log('[SKIP] positive control — skipped (the authenticity signature above failed)');
  } else if (o.identity && !(await exists(o.identity))) {
    // #531: an EXPLICITLY-given --identity that doesn't exist is a configuration typo,
    // not "no private identity is set up on this box" — the same distinction
    // --sign-recipient already draws above (and restoreImpl's own identical guard draws
    // for `restore --identity`). Only the DEFAULT path being absent means "not set up
    // yet, legitimately a public-key-only box" (the SKIP/PARTIAL branch below); a
    // nonexistent path the caller named on purpose is a hard error instead, so a typo
    // is never read as an expected verdict.
    throw new Error(`no identity at ${o.identity} — cannot decrypt without the private key`);
  } else if (await exists(identity)) {
    try {
      const decrypter = newDecrypter(await loadIdentities(identity)); // prompts if passphrase-wrapped
      await decryptToChild(decrypter, o.in, 'tar', ['-tf', '-'], { consStdout: 'ignore', timeoutMs: PIPE_TIMEOUT_MS });
      if (!o.json) console.log('[PASS] your identity decrypts the artifact into a well-formed bundle');
    } catch {
      positiveOk = false;
      if (!o.json)
        console.log('[FAIL] your identity could not decrypt the artifact (corrupt/truncated, or not encrypted to you)');
    }
  } else {
    positiveSkipped = true;
    if (!o.json) console.log('[SKIP] positive control — no private identity on this machine (public-key-only box)');
  }

  // Three verdicts, not two. The header + wrong-key checks alone do NOT prove the
  // artifact is restorable BY YOU, so on a public-key-only box (positive control
  // skipped) we must NOT print PASS / exit 0 — a cron/log reading "PASS" would be
  // false-green and could mask a month of snapshots encrypted to a wrong/lost key.
  let verdict: 'PASS' | 'FAIL' | 'PARTIAL';
  if (!isAge || !wrongKeyRejected || !positiveOk || hashOk === false || sigOk === false) {
    verdict = 'FAIL';
    if (!o.json && printVerdictLine) printFileCheckVerdict('FAIL');
    process.exitCode = 1;
  } else if (positiveSkipped) {
    verdict = 'PARTIAL';
    if (!o.json && printVerdictLine) printFileCheckVerdict('PARTIAL');
    process.exitCode = 2; // distinct from PASS(0) and FAIL(1) so automation can tell them apart
  } else {
    verdict = 'PASS';
    if (!o.json && printVerdictLine) printFileCheckVerdict('PASS');
  }

  return {
    file: o.in,
    sizeBytes: sz,
    checks: {
      age_header: isAge,
      sha256_match: hashOk, // null when --sha256 was not passed (check skipped, not failed)
      signature: sigOk === null ? 'skip' : sigOk ? 'pass' : 'fail', // #214: 'skip' when unsigned or no signing pubkey on this box
      wrong_key_rejected: wrongKeyCheckSkipped ? 'skip' : wrongKeyRejected, // #214: 'skip' when the authenticity signature above already failed
      positive_control: positiveSkipped ? 'skip' : positiveOk ? 'pass' : 'fail',
    },
    verdict,
  };
}

// Shared tail for --level quick and --level remote (drill's final report is its own,
// below, since its verdict also depends on the restore step that runs after
// runFileChecks) — --json: the SAME checks/verdict runFileChecks computed, as one
// machine-readable line on stdout instead of the human-readable report — never a
// re-implementation, so this can never disagree with either the human-readable report
// above or the MCP verify_restore tool (#211). `extra` (added by #209's --level remote)
// is spread in between checks and verdict so a --level quick caller's JSON shape is
// completely unaffected (extra is never passed there).
//
// `printVerdictLine` (default false): quick and remote already had runFileChecks itself
// print the "VERDICT: …" line (they pass printVerdictLine=true THERE, so finishVerify
// must not print a second one here — the default covers that). --level drill's own
// FAIL/PARTIAL early return (below) is the one caller that passes true here: it told
// runFileChecks NOT to print one (drill's overall verdict still depended on the restore
// step at that point), but once drill decides to SKIP that step, r.verdict IS the final
// answer and the promised "VERDICT: FAIL/PARTIAL" line was going unprinted entirely —
// silently downgrading a documented contract to only an exit code (#209 review).
// Returns the exit code it just read from process.exitCode (#226): verifyImpl()'s own
// wrapper (verify(), below) needs this value WITHOUT re-reading the process-global
// afterward — see verify()'s own doc comment for why a second read is not race-safe.
function finishVerify(
  o: CliOptions,
  r: FileCheckResult,
  extra?: Record<string, unknown>,
  printVerdictLine = false,
): number {
  const exitCode = Number(process.exitCode ?? 0); // process.exitCode's declared type is string|number|undefined
  if (!o.json && printVerdictLine) printFileCheckVerdict(r.verdict);
  if (o.json) {
    printJson({
      file: r.file,
      size_bytes: r.sizeBytes,
      checks: r.checks,
      ...(extra ?? {}),
      verdict: r.verdict,
      exit_code: exitCode,
    });
  }
  // Human-facing decoration only (mascot faced for the verdict) — see printMascot in
  // ui.ts for why this is EPIPE-safe against a caller piping/grepping verify's output
  // for the VERDICT line. Never printed on --json (ui.ts: "nothing here should be
  // called on a --json / piped path") — it writes to stderr only, so it would never
  // corrupt the JSON on stdout, but a --json caller asked for machine-readable output
  // only, not ASCII-art decoration alongside it.
  if (!o.json) printMascot(moodForVerdict(r.verdict));
  return exitCode;
}

// verify --level quick|remote|drill (issue #209): three progressively deeper checks that
// the ciphertext is actually durable, not just three ways to read the SAME local file.
//   quick  (default, unchanged since before #209): everything runFileChecks does above,
//          against --in as given — a structural check, no network access, restic
//          `check`'s speed class. Rejects --locator/--backend/--from-locator-file: those
//          name something to FETCH, and quick never fetches anything.
//   remote: pulls the artifact by --locator/--backend (or --from-locator-file) into a
//           scratch temp file, then runs the SAME runFileChecks against THAT — restic
//           `check --read-data-subset`'s idea, proving the object is still actually
//           retrievable from storage and unchanged, not merely that a local copy still
//           parses.
//   drill:  does everything remote does, and — only once those checks reach PASS — ALSO
//           decrypts and extracts the pulled artifact into a scratch out-dir (the same
//           restoreImpl() the `restore` command runs), the full pull -> decrypt -> extract
//           rehearsal MANAGEMENT.md's restore runbook / identity backup drill describe.
//           Never runs pg_restore even if --pg is given (see the refusal below) — a
//           verification drill must not write to a live database. The scratch directory
//           (pulled ciphertext + extracted plaintext) is always removed afterward, success
//           or failure — this proves restorability, it does not perform a real restore.
// #226: the public entry point. verify() reports its outcome via process.exitCode
// (0 PASS / 1 FAIL / 2 PARTIAL — set at various points inside verifyImpl(), never via
// a throw for a normal FAIL/PARTIAL verdict; a THROWN error here means something
// genuinely unexpected happened, not an ordinary verify failure). verifyImpl() ALSO
// returns that same code directly (Codex review): reading process.exitCode back out
// after `await verifyImpl(o)` resolves is NOT race-safe — the microtask handoff at an
// `await` boundary can let another in-process async task (e.g. a concurrent MCP
// verify_restore call) overwrite the process-global before this line resumes, even
// with no OTHER await in between. Using verifyImpl()'s own return value sidesteps
// that race entirely; process.exitCode itself is left set exactly as before, for every
// other existing caller/contract that reads it.
export async function verify(o: CliOptions): Promise<void> {
  const startedAt = Date.now();
  try {
    const exitCode = await verifyImpl(o);
    await recordAudit({
      command: 'verify',
      o,
      backend: o.backend ?? null,
      locator: o.locator ?? null,
      exitCode,
      startedAt,
    });
  } catch (e) {
    await recordAudit({
      command: 'verify',
      o,
      backend: o.backend ?? null,
      locator: o.locator ?? null,
      exitCode: 1,
      startedAt,
    });
    throw e;
  }
}

async function verifyImpl(o: CliOptions): Promise<number> {
  const level = o.level ?? 'quick';
  if (level !== 'quick' && level !== 'remote' && level !== 'drill') {
    // #435: --level is an enum-valued flag, same "did you mean" class #425 already
    // covers for top-level commands/flags — nearestName() is the same matcher.
    const suggestion = nearestName(level, ['quick', 'remote', 'drill']);
    throw new Error(
      `--level must be quick, remote or drill (got "${o.level}")${suggestion ? ` (${didYouMean(`--level ${suggestion}`)})` : ''}`,
    );
  }

  if (level === 'quick') {
    // #528: --sig-locator names something to FETCH (the *.minisig sidecar), exactly like
    // --locator/--backend/--from-locator-file name something to fetch — quick never
    // fetches anything, so it belongs in this same refusal rather than being silently
    // accepted and dropped (which is exactly what used to happen: no error, no warning,
    // just a flag that did nothing).
    if (o.locator || o.backend || o.from_locator_file || o.sig_locator) {
      throw new Error(
        '--level quick checks the LOCAL --in file only — it never fetches from storage, so --locator/' +
          '--backend/--from-locator-file/--sig-locator have nothing to do here (--level remote or --level ' +
          'drill fetch by those instead of taking --in)',
      );
    }
    // #536: remote/drill both print a "level: …" first line and carry a "level" field in
    // --json (below); quick used to have neither, so a caller inspecting only the JSON
    // (or grepping a captured log for "level:") could not tell "quick ran" apart from
    // "nothing ran" — same field, same meaning, for parity across all three depths.
    if (!o.json) console.log(`level: ${level}`);
    const r = await runFileChecks(o, true);
    return finishVerify(o, r, { level });
  }

  // remote and drill both start the same way: actually fetch the artifact. That fetch IS
  // the point of both — --level quick can only ever look at bytes already on this
  // machine, so it can never prove the storage side of "will this still be here".
  if (o.in) {
    throw new Error(
      `--level ${level} fetches the artifact from storage itself — pass --locator/--backend or ` +
        '--from-locator-file (like pull does), not --in, which only names a file already on this machine ' +
        '(that is what --level quick checks)',
    );
  }
  if (!o.from_locator_file && !(o.locator && o.backend)) {
    throw new Error(
      `--level ${level} requires --locator <id> --backend <name>, or --from-locator-file <path> — the ` +
        'artifact to actually fetch and check',
    );
  }
  if (level === 'drill' && o.pg) {
    throw new Error(
      '--level drill never runs pg_restore, even when --pg is given — a verification drill must not write ' +
        'to a live database. Use `restore --pg <conn>` separately if you actually want to recover into one.',
    );
  }

  // installStageSignalGuard() (idempotent) BEFORE the scratch dir exists — remote/drill
  // reach here without restoreImpl() ever having called it (that only happens for drill,
  // and only once its own checks already reached PASS), so without this call up front a
  // signal during the fetch/checks below would hit no handler at all.
  installStageSignalGuard();
  let scratchRoot: string | null = null;
  try {
    // mkdtempSync (not async mkdtemp), and setActiveVerifyScratchDir called immediately
    // after with no await between them — same one-tick discipline snapshot.ts's own
    // ACTIVE_STAGE registration uses (see signal-guard.ts): a signal landing during an
    // await could otherwise fire the handler while this scratch dir is still untracked,
    // leaking it (multi-model review finding on PR #332 — the ORIGINAL bug this whole
    // function needed to close, not just drill's later decrypt+extract step).
    scratchRoot = mkdtempSync(join(tmpdir(), 'cypher-brain-verify-'));
    setActiveVerifyScratchDir(scratchRoot);
    const target = join(scratchRoot, 'pulled.age');
    // A fresh CliOptions object, not a spread of `o`: pull() only needs to know WHERE to
    // fetch from and WHERE to land it, and building it explicitly means no other field a
    // future CliOptions grows can leak into a pull call that was never meant to see it.
    const pullOpts: CliOptions = {
      locator: o.locator,
      backend: o.backend,
      from_locator_file: o.from_locator_file,
      sha256: o.sha256,
      // #528: was missing entirely — pull() only ever fetches the *.minisig sidecar when
      // sig_locator is set (either explicitly here, or filled in below from
      // --from-locator-file's 6th field), so a bare --locator/--backend + --sig-locator
      // call (the exact pattern `pull --sig-locator` documents, and the one a user would
      // reach for by analogy) silently never fetched the sidecar at all — a false-negative
      // FAIL under --require-signature on a genuinely valid signature.
      sig_locator: o.sig_locator,
      out: target,
      dirs: [],
      tables: [],
      recipients: [],
    };
    // pull()'s own narrative (retries, the "sha256 OK: …" confirmation, "pulled x -> y",
    // and — the reason this is captured rather than left to print directly — a warning
    // naming WHY an authenticity signature sidecar could not be fetched) goes to
    // console.error. Captured here, not silenced: every line is replayed to the real
    // stderr immediately below (success or failure), so this changes nothing an operator
    // actually sees — it only ALSO makes pull()'s log available to signatureGap() so a
    // deleted/unfetchable .minisig sidecar can be told apart from an artifact that was
    // simply never signed (src/mcp.ts's verify_restore/restore_now already do exactly
    // this over MCP, #312; --json here had no equivalent at all, #209 review).
    const pullLog: string[] = [];
    const prevConsoleError = console.error;
    console.error = (...a: unknown[]) => {
      pullLog.push(a.map(String).join(' '));
    };
    try {
      try {
        await pull(pullOpts);
      } finally {
        console.error = prevConsoleError;
        for (const line of pullLog) console.error(line);
      }
    } catch (e) {
      // Remote retrievability is exactly what --level remote/drill exists to test — a
      // fetch failure here (not-yet-propagated, deleted, wrong locator, sha256 mismatch, a
      // dead gateway) IS the verdict, not a crash: report FAIL the same way an on-disk
      // check would, rather than letting pull()'s exception propagate raw past this point.
      const msg = errMsg(e);
      if (!o.json) {
        console.log(`level: ${level}`);
        console.log(
          `[FAIL] could not fetch the artifact from ${pullOpts.backend ?? '(unresolved backend)'}` +
            `${pullOpts.locator ? `:${pullOpts.locator}` : ''} (${msg})`,
        );
        console.log('\nVERDICT: FAIL');
      }
      process.exitCode = 1;
      if (o.json) {
        printJson({
          level,
          pulled: {
            backend: pullOpts.backend ?? null,
            locator: pullOpts.locator ?? null,
            // Present even on a failed fetch (previously absent here, unlike every OTHER
            // `pulled` shape below) — the same field, the same meaning, regardless of
            // outcome, rather than a caller having to know it only sometimes exists
            // (#209 review).
            sha256_pin: pullOpts.sha256 ?? null,
            fetched: false,
            error: msg,
          },
          verdict: 'FAIL',
          exit_code: 1,
        });
      }
      if (!o.json) printMascot('sad');
      return 1;
    }
    // sig_locator is pull()'s own bookkeeping, filled in on `pullOpts` (the SAME object
    // reference passed to pull() above) when --from-locator-file recorded one — read
    // AFTER the call, exactly like signatureGap()'s other two callers in src/mcp.ts do.
    const sigGap = signatureGap(pullLog, pullOpts.sig_locator);
    const pulledInfo = {
      backend: pullOpts.backend,
      locator: pullOpts.locator,
      sha256_pin: pullOpts.sha256 ?? null,
      fetched: true,
      ...(sigGap ? { signature: sigGap } : {}),
    };
    if (!o.json) {
      console.log(`level: ${level}`);
      console.log(`[PASS] fetched from ${pullOpts.backend}:${pullOpts.locator} (remote retrievability confirmed)`);
      if (!pullOpts.sha256 && pullOpts.backend && NON_CONTENT_ADDRESSED_BACKENDS.has(pullOpts.backend)) {
        console.log(
          `warning: no sha256 pin was applied — ${pullOpts.backend} locators are not content hashes ` +
            '(post-assigned ids for arweave/turbo, an operator-chosen remote path for rclone), so a ' +
            'substituted/rolled-back object served at the same locator would not be detected here (pass ' +
            '--sha256, or use --from-locator-file, to fail closed)',
        );
      }
    }

    // Same checks as --level quick, run against the just-pulled file. --level remote's
    // own verdict line prints normally here (drill's does not — its overall verdict still
    // depends on the restore step below, so printing one now would read as final).
    const r = await runFileChecks({ ...o, in: target, sha256: pullOpts.sha256 }, level === 'remote');

    if (level === 'remote') {
      return finishVerify(o, r, { level, pulled: pulledInfo });
    }

    // drill only goes on to a real decrypt+extract once the checks above actually reached
    // PASS. FAIL means the artifact itself is bad (wrong key rejected it, a tampered
    // signature, a hash mismatch, corrupt bytes, …) — restoreImpl() below would just
    // rethrow the identical problem restore's own checks already report, proving nothing
    // new. PARTIAL means there is no private identity on this box at all, so restoreImpl()
    // cannot even start (it requires one) — nothing left to drill either.
    if (r.verdict !== 'PASS') {
      if (!o.json) {
        console.log(
          r.verdict === 'PARTIAL'
            ? '[SKIP] full restore drill — no private identity on this box to decrypt with'
            : '[SKIP] full restore drill — the checks above already failed',
        );
      }
      return finishVerify(o, r, { level, pulled: pulledInfo, full_restore: 'skip' }, true);
    }

    // restoreImpl(), NOT restore(): restore() prints its own mood mascot on success/failure
    // (issue #194), and a drill's own final mascot below would double up with it. Its
    // stdout narrative ("restored components into …", the component auto-expand summary,
    // and — only with --verbose, #436 — the manifest.json dump) is captured rather than
    // left to print directly, so a --json drill still emits exactly one JSON line on
    // stdout — the same contract #211 already holds --level quick/remote to.
    const restoreOutDir = join(scratchRoot, 'restored');
    // A fresh CliOptions object, NOT a spread of `o`: restoreImpl() reads o.pg and would
    // run pg_restore --clean --if-exists (an irreversible DROP) if it were passed through
    // here — refused above already, but this also means no OTHER field a future CliOptions
    // grows can reach restoreImpl() from a verify call unnoticed either.
    const restoreOpts: CliOptions = {
      in: target,
      out_dir: restoreOutDir,
      identity: o.identity,
      sign_recipient: o.sign_recipient,
      require_signature: o.require_signature,
      verbose: o.verbose, // #436: let --level drill --verbose show the raw manifest.json restoreImpl() reads, same as a plain "restore --verbose" would
      // #530: the checks above (runFileChecks, called via `r` earlier in this function)
      // already ran and printed this EXACT signature check against this EXACT fetched
      // artifact — only reached at all when that came back PASS or SKIP (see the early
      // return above for FAIL/PARTIAL). Re-running it here would print the same result a
      // second time.
      skip_signature_check: true,
      dirs: [],
      tables: [],
      recipients: [],
    };
    const restoreStdout: string[] = [];
    const prevLog = console.log;
    console.log = (...a: unknown[]) => {
      restoreStdout.push(a.map(String).join(' '));
    };
    let restoreOk = true;
    let restoreErr: string | undefined;
    try {
      await restoreImpl(restoreOpts);
    } catch (e) {
      restoreOk = false;
      restoreErr = errMsg(e);
    } finally {
      console.log = prevLog;
    }
    if (!o.json) {
      if (restoreOk) for (const line of restoreStdout) console.log(`  ${line}`);
      console.log(
        restoreOk
          ? '[PASS] full restore (decrypt + extract, incl. component auto-expand) into a scratch directory succeeded'
          : `[FAIL] full restore into a scratch directory failed (${restoreErr})`,
      );
    }
    const finalVerdict: 'PASS' | 'FAIL' = restoreOk ? 'PASS' : 'FAIL';
    if (!o.json) console.log(`\nVERDICT: ${finalVerdict}`);
    const finalExitCode = finalVerdict === 'PASS' ? 0 : 1;
    process.exitCode = finalExitCode;
    if (o.json) {
      printJson({
        level,
        pulled: pulledInfo,
        checks: r.checks,
        full_restore: restoreOk,
        ...(restoreErr ? { full_restore_error: restoreErr } : {}),
        verdict: finalVerdict,
        exit_code: finalExitCode,
      });
    }
    if (!o.json) printMascot(finalVerdict === 'PASS' ? 'happy' : 'sad');
    // `finally` below still runs before this actually returns (JS/TS semantics: a
    // `return` inside `try` executes the paired `finally` first, then yields this
    // value) — the scratch-dir cleanup is not skipped by returning here.
    return finalExitCode;
  } finally {
    // Best-effort, same posture as mcp.ts's own scratch-tmpdir cleanup (handleVerifyRestore/
    // handleRestoreNow) — always removed, whether the fetch, the checks, or the restore
    // step failed. Nothing here is meant to survive past this call: --level remote never
    // writes plaintext at all, and --level drill's whole point is proving restorability
    // without performing an actual restore. rmrf (util.ts), not a plain rm(): a --dir
    // source captured with a restrictive mode (or a component tarball that recorded one)
    // can leave a read-only directory under here even though the extract itself passes
    // --no-same-permissions, and force:true alone does not retry past the EACCES that
    // causes (#209 review). Only cleared from the signal guard AFTER removal actually
    // finishes — a signal arriving mid-rmrf must still find scratchRoot tracked.
    if (scratchRoot) {
      await rmrf(scratchRoot);
      setActiveVerifyScratchDir(null);
    }
  }
}
