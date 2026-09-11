// bagit-export — package an already-restored (`restore --out-dir`) directory as a
// standards-conformant BagIt 1.0 bag (RFC 8493: https://www.rfc-editor.org/rfc/rfc8493).
//
// Scope (issue #217, narrowed via a design consultation — see the PR this shipped in):
// this is BagIt ONLY. RO-Crate (a JSON-LD semantic description of *what* the payload is)
// is a separate, deliberately deferred piece of #217 — see README's "Long-term
// interoperability" section and docs/prior-art.md. This module:
//   - never touches encryption, key material, a storage backend, or the network — it
//     operates entirely on plaintext ALREADY on local disk (the output of
//     `cypher-brain restore --out-dir <dir>`);
//   - never parses manifest.json's CONTENTS — only checks that the file is PRESENT, as a
//     cheap sanity check that `fromDir` is plausibly a restore output and not an arbitrary
//     directory. This tool is payload-format-agnostic;
//   - adds no new runtime dependency and no new persistent state file.
//
// Why written in-house rather than pulling in a dependency (see CONTRIBUTING.md's
// "Prefer an existing implementation" — the general default there IS to add a
// dependency): a design consultation found no trustworthy option. `bagit-fs` (npm) is
// ~9 years stale with 7 transitive deps. `ro-crate` (npm) is actively maintained, but
// licensed GPL-3.0-or-later — incompatible with this MIT-licensed project's dependency
// tree (CONTRIBUTING.md is explicit that the tree should stay MIT-compatible). Per
// CONTRIBUTING.md's own stated exception ("a dependency that is unmaintained or wildly
// oversized for what we need, or a license mismatch"), a narrow, spec-correct writer
// using only Node builtins (node:fs, node:crypto) is that exception, not a shortcut
// around it.
import { mkdirSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from './util.js';
import { printJson } from './ui.js';
import { UsageError } from './errors.js';
import { installStageSignalGuard, addActiveBagitScratchDir, removeActiveBagitScratchDir } from './signal-guard.js';
import type { CliOptions } from './types.js';

export interface BagitExportOptions {
  fromDir: string; // an already-restored directory (restore --out-dir output)
  outDir: string; // where the new BagIt bag is written; must not already exist unless force
  force?: boolean;
}

export interface BagitExportResult {
  outDir: string;
  fileCount: number;
  octetCount: number;
  files: string[]; // relative paths under data/, for reporting
}

// RFC 8493 section 4.1's own example manifest lines ("checksum filepath") and its
// grammar (`payload-manifest-line = checksum 1*WSP filepath ending`, section 7.2 — "1*WSP"
// is "one or more whitespace characters", NOT specifically two) both permit any run of
// one-or-more spaces/tabs between the two fields. Two literal spaces is the conventional
// separator most BagIt tooling in the wild actually writes (and satisfies "1*WSP" either
// way) — used here for that reason, not because the RFC mandates it specifically.
const MANIFEST_LINE_SEP = '  ';

// A component's manifest `name`/the top-level entries under a restore --out-dir are not
// attacker-controlled the way restore.ts's OWN threat model treats them (this only ever
// runs against a directory the invoking operator already fully controls locally, offline,
// after restore has already finished) — but never following a symlink here is still the
// right default: mirrors restore.ts's own refuseIfSymlink() posture ("lstat, never stat,
// to actually SEE the symlink" — see that function's doc comment), just without the
// "crafted manifest" framing, which does not apply here.
function symlinkRefusal(path: string): Error {
  return new Error(
    `${path} is a symlink — bagit-export refuses to follow or include any symlink found under --from-restored-dir`,
  );
}

// Validate `fromDir`'s top level and return exactly what needs copying: the plain
// filenames directly under it (manifest.json, *.tar.gz, db.dump, a *.minisig sidecar,
// anything else that's a plain file), while refusing anything this tool does not know
// how to handle. Read restore.ts's own `--out-dir` layout doc comments (expandComponents,
// restoreImpl) before changing what shapes this accepts — the shapes checked here mirror
// exactly what restore() can leave behind.
async function planTopLevel(fromDir: string): Promise<{ files: string[] }> {
  const rootStat = await lstat(fromDir).catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') throw new Error(`--from-restored-dir ${fromDir} does not exist`);
    throw e;
  });
  if (rootStat.isSymbolicLink()) throw symlinkRefusal(fromDir);
  if (!rootStat.isDirectory()) throw new Error(`--from-restored-dir ${fromDir} is not a directory`);

  const entries = await readdir(fromDir, { withFileTypes: true });
  const files: string[] = [];
  let sawManifest = false;
  let expandedSkipped = false;
  for (const entry of entries) {
    const abs = join(fromDir, entry.name);
    // Dirent's own type flags (from the directory entry itself, not a stat() through it)
    // are exactly the "see, don't follow" discipline restore.ts's own moveNoClobber()/
    // mergeNoClobber() already rely on for the same readdir(withFileTypes) shape.
    if (entry.isSymbolicLink()) throw symlinkRefusal(abs);
    if (entry.isDirectory()) {
      // Explicitly SKIP restore's own `expanded/` subdirectory — restore's derived,
      // already-decompressed view of the *.tar.gz components already present as their
      // own files. Re-including it would duplicate the payload and inflate the bag with
      // no interoperability benefit (the components themselves are the source of truth;
      // expanded/ is just restore's own convenience view of them).
      if (entry.name === 'expanded') {
        expandedSkipped = true;
        continue;
      }
      throw new Error(
        `${abs} is an unexpected directory under --from-restored-dir — bagit-export only expects plain files ` +
          `there (and restore's own "expanded/" subdirectory, which it always skips)`,
      );
    }
    if (!entry.isFile()) {
      throw new Error(
        `${abs} is neither a regular file, a symlink, nor the "expanded" directory — bagit-export does not know ` +
          'how to handle this entry type, refusing rather than silently skipping it',
      );
    }
    // BagIt's manifest/tagmanifest files are LINE-oriented (one "<hash>  <path>" record
    // per line, see MANIFEST_LINE_SEP below) — a filename containing a literal CR or LF
    // would inject a bogus extra "line" into manifest-sha256.txt, corrupting it for any
    // BagIt-aware reader (multi-model review finding). RFC 8493's own historical
    // convention is to percent-encode CR/LF/percent in manifest path fields rather than
    // refuse them outright, but implementing that encode/decode round-trip is out of
    // proportion for a shape restore() itself never produces — refusing is simpler and
    // strictly safer than silently writing a manifest a reader could misparse.
    if (/[\r\n]/.test(entry.name)) {
      throw new Error(
        `${abs} has a CR or LF character in its filename — bagit-export refuses this rather than risk corrupting ` +
          "the line-oriented manifest-sha256.txt/tagmanifest-sha256.txt files' record boundaries",
      );
    }
    if (entry.name === 'manifest.json') sawManifest = true;
    files.push(entry.name);
  }
  if (!sawManifest) {
    throw new Error(
      `${fromDir} does not directly contain a manifest.json — refusing (this does not look like a ` +
        '"restore --out-dir" output). bagit-export only checks that manifest.json is PRESENT; it never parses ' +
        'its contents, so any payload format restore produced is accepted once that sanity check passes.',
    );
  }
  if (expandedSkipped) {
    // stderr, not stdout (multi-model review finding): bagitExportCommand()'s --json
    // path prints ONLY the JSON result object to stdout — an informational message on
    // stdout ahead of it would corrupt that for any caller parsing stdout as JSON.
    console.error(
      `bagit-export: skipping "${join(fromDir, 'expanded')}" — this is restore's own derived/expanded view of ` +
        'components already present as their own *.tar.gz archives; re-including it would duplicate the payload ' +
        'and inflate the bag for no interoperability benefit',
    );
  }
  return { files };
}

// #943: a case-insensitive-but-preserving destination filesystem (the macOS APFS
// default) or a Unicode-normalization-insensitive one can silently collapse two
// DISTINCTLY-named source files onto the same path once copied into data/ below — the
// second copyFile() call (which overwrites by default) then silently drops the first
// file's content, and since manifest-sha256.txt is built by RE-LISTING data/ AFTER all
// copies finish (see listFilesRecursive() below), the bag reports success with a
// passing checksum for whichever file landed — no error, no warning, no way to detect
// after the fact that a file went missing.
//
// This check is a pure string comparison on the SOURCE filenames, deliberately NOT a
// runtime probe of --out-dir's actual case-sensitivity: a probe is fragile and
// platform-dependent (and would still miss the normalization-collapse variant on a
// filesystem that is case-sensitive but normalization-insensitive), whereas comparing
// every name's lowercased-AND-NFC-normalized form catches both failure modes at once
// and is correct regardless of what filesystem --out-dir eventually turns out to be.
// Two names collide here if that comparison key matches — grouped (not just paired) so
// three-or-more-way collisions are also caught and every real conflicting filename is
// named, not just the first two found.
//
// Order matters (multi-model review finding): lowercasing BEFORE normalizing, not
// after. A decomposed uppercase letter+combining-mark sequence (e.g. "J" U+004A +
// combining caron U+030C) only becomes canonically equal to its precomposed lowercase
// form (e.g. "ǰ" U+01F0) once case-folded first — normalize('NFC') on the uppercase
// sequence alone does not compose it (there is no precomposed uppercase "J WITH CARON"
// for NFC to fold onto), so normalizing before lowercasing left this pair undetected;
// toLowerCase() first collapses both to the same decomposed "j" + combining caron,
// which normalize('NFC') then correctly composes to one identical key.
//
// Known, deliberately accepted residual: this is a SIMPLE case-fold (toLowerCase()),
// not the full Unicode default case-folding algorithm (which needs a CaseFolding.txt
// mapping table this codebase does not carry — this file's own header comment states
// bagit-export adds no new runtime dependency). Context-sensitive special-casing
// pairs, e.g. Greek "Σ"/"σ"/final-form "ς", are NOT caught: "Σ".toLowerCase() is
// always "σ", never "ς", so "ς.tar.gz" and "Σ.tar.gz" are not detected as colliding
// here even though some case-insensitive filesystems' own folding may treat them as
// equal. Given this tool's domain (restore output filenames — manifest.json,
// *.tar.gz component archives, db.dump), this residual is treated the same as
// pathsOverlap()'s own stated symlink residual above: accepted, not silently
// unconsidered.
//
// Exported (only) so the selftest can exercise this deterministic string comparison
// directly with synthetic name arrays — this repo's own CI matrix runs both
// macos-latest (APFS folds ASCII case AND Unicode normalization for real on-disk
// filenames, so two colliding SOURCE names can never both exist as real dirents to
// begin with) and ubuntu-latest (ext4 is case-sensitive, so they could) — testing this
// function directly, rather than depending on constructing real colliding files on
// disk, is the one way to cover this deterministically on every runner.
export function findNormalizedNameCollisions(fileNames: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const name of fileNames) {
    const key = name.toLowerCase().normalize('NFC');
    const group = groups.get(key);
    if (group) group.push(name);
    else groups.set(key, [name]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

// List every regular file under `dir`, recursively, as paths relative to `dir` — used
// for manifest-sha256.txt. Today `dir` (the bag's own data/) is only ever ONE level deep,
// since planTopLevel() above never recurses into a source subdirectory (it only ever
// copies plain top-level files, and explicitly skips `expanded/`) — but the manifest
// writer itself stays a real recursive walk rather than hardcoding that flatness in, so
// it stays correct if data/ ever legitimately grows a subdirectory later. Paths are
// normalized to forward slashes (RFC 8493's own manifest examples use `/`), regardless
// of `path.sep` on the host platform.
async function listFilesRecursive(dataDir: string, dir: string = dataDir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(dataDir, abs)));
    } else {
      out.push(relative(dataDir, abs).split(sep).join('/'));
    }
  }
  return out;
}

// The version reported in bag-info.txt's Bag-Software-Agent field, read from
// package.json at runtime rather than hardcoded (a hardcoded copy would be a second
// place to bump on every release, and would drift the moment it wasn't).
//
// Unlike cli.ts's own cliVersion() (which resolves `../package.json` relative to
// `import.meta.url`), this file lives one directory deeper (src/lib/, not src/) — so the
// SAME relative-offset trick would need a DIFFERENT literal depending on whether this
// code is running unbundled from source (src/lib/bagit.ts, two levels below the repo
// root) or as part of the single-file bundled dist/cli.mjs (where every originally
// separate module shares ONE `import.meta.url`, at dist/'s depth: one level below the
// repo root — see cli.ts's own comment on cliVersion() for why that one literal works
// for it in both cases). Rather than hardcode an offset that is only correct in ONE of
// those two run modes, try both candidate depths and accept whichever resolves to an
// actual `cypher-brain` package.json (the name check guards against silently reading an
// unrelated package.json if either candidate happens to exist for some other reason).
function resolveOwnVersion(): string {
  const candidates = ['../../package.json', '../package.json'];
  const errors: string[] = [];
  for (const rel of candidates) {
    const url = new URL(rel, import.meta.url);
    try {
      const pkg = JSON.parse(readFileSync(url, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'cypher-brain' && pkg.version) return pkg.version;
      errors.push(`${url}: not cypher-brain's own package.json (name=${JSON.stringify(pkg.name)})`);
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `bagit-export: could not resolve cypher-brain's own package.json to read its version (${errors.join('; ')})`,
  );
}

// true if `child` is `parent` itself, or nested anywhere under it, once both are made
// absolute (path.resolve — string normalization against cwd, no filesystem access, no
// symlink resolution). This is a straightforward misuse guard, not a hardened
// canonicalization boundary: it will not catch a symlink placed somewhere in either
// path's ancestry that makes two textually-different paths alias the same inode. That
// residual is accepted here the same way the rest of this module treats
// --from-restored-dir/--out-dir as operator-local, non-adversarial inputs (this tool's
// own top-level symlink refusal in planTopLevel() already covers the entries WITHIN
// fromDir; this check is specifically about the two ROOT paths' own relationship).
function pathsOverlap(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// The core writer. See this module's own header comment for scope, and RFC 8493 for the
// exact normative shapes below — every format decision here was checked against the
// RFC's own text, not written from memory of what a "bag" generally looks like.
export async function exportBagit(opts: BagitExportOptions): Promise<BagitExportResult> {
  const { fromDir, outDir, force } = opts;

  // Multi-model review finding: without this check, `--force` with --out-dir equal to
  // (or an ancestor/descendant of) --from-restored-dir would have this function's own
  // later `rm(outDir, {recursive:true})` delete the restore output this tool promises
  // to only ever READ — directly contradicting its own "non-destructive" contract
  // (see this module's header comment). Checked before anything else runs, using only
  // the two paths given — no filesystem access needed to catch the common case.
  if (pathsOverlap(fromDir, outDir) || pathsOverlap(outDir, fromDir)) {
    throw new Error(
      `--out-dir ${outDir} overlaps --from-restored-dir ${fromDir} (one contains the other, or they are the ` +
        'same path) — bagit-export refuses this because --force would otherwise delete the restore output it ' +
        'promises to only ever read. Pick an --out-dir that is not inside, and does not contain, ' +
        '--from-restored-dir.',
    );
  }

  // --force semantics: refuse an existing destination outright unless --force, matching
  // this codebase's existing no-clobber convention (e.g. sss-combine's own `--out already
  // exists` refusal in keys.ts). lstat (not stat/exists()) so a symlink already sitting at
  // outDir counts as "already exists" too, rather than silently following it.
  // Deliberately checked BEFORE planTopLevel() below (#923): this is a cheap, purely local
  // check on --out-dir alone — it does not need to look at --from-restored-dir at all — so
  // a doomed invocation (existing --out-dir without --force) fails immediately, before
  // planTopLevel() ever walks fromDir and potentially prints its "skipping ... expanded"
  // notice, which would otherwise imply progress on a run that is about to abort anyway.
  const outExists = await lstat(outDir)
    .then(() => true)
    .catch((e: NodeJS.ErrnoException) => {
      if (e?.code === 'ENOENT') return false;
      throw e;
    });
  if (outExists && !force) {
    throw new Error(
      `--out-dir ${outDir} already exists (refusing to overwrite). Pass --force, or pick a different path.`,
    );
  }

  const { files: fileNames } = await planTopLevel(fromDir);

  // #943: refuse BEFORE anything is written if any two of these source filenames would
  // collapse onto the same destination path on a case-insensitive or
  // Unicode-normalization-insensitive filesystem — see findNormalizedNameCollisions()'s
  // own doc comment above for why this check is filesystem-independent and runs on the
  // source names rather than probing --out-dir.
  const nameCollisions = findNormalizedNameCollisions(fileNames);
  if (nameCollisions.length > 0) {
    const detail = nameCollisions.map((group) => group.map((n) => JSON.stringify(n)).join(' vs ')).join('; ');
    throw new Error(
      `--from-restored-dir ${fromDir} contains filenames that would collide on a case-insensitive or ` +
        `Unicode-normalization-insensitive destination filesystem (e.g. the default on macOS/APFS): ${detail}. ` +
        'Refusing rather than risk one silently overwriting the other once copied into data/ — with no error, ' +
        'since manifest-sha256.txt is generated from what actually landed there, not from this original list. ' +
        'Rename one of the conflicting files in --from-restored-dir before retrying.',
    );
  }

  // Atomicity: everything is written into a temporary SIBLING directory first (same
  // parent as outDir, so the final publish below is a same-filesystem rename), mirroring
  // keys.ts's writeKeyFile() tmp-then-rename discipline for a single file, adapted here
  // for a whole directory tree. Nothing is ever written directly at `outDir` until every
  // other file has already been written and hashed successfully.
  await mkdir(dirname(outDir), { recursive: true });
  const tmpOutDir = join(dirname(outDir), `.bagit-export-${process.pid}-${randomBytes(4).toString('hex')}.partial`);
  // Multi-model review finding: this staging directory holds the whole in-progress bag
  // (a full plaintext copy of --from-restored-dir's payload) but was never registered
  // with signal-guard.ts — a SIGINT/SIGTERM/SIGHUP mid-export left it orphaned under
  // --out-dir's parent forever. installStageSignalGuard() is idempotent (see its own
  // call sites in ton-dns.ts/restore.ts), so calling it here is safe even when another
  // caller already installed it. mkdirSync (not the async mkdir used everywhere else in
  // this function) + an IMMEDIATE, same-tick register with no await in between — the
  // exact same reasoning ton-dns.ts's assertBagAvailable() and restore.ts's
  // expandComponents() both document at their own mkdtempSync/register call sites: an
  // async mkdir() leaves a real window (the underlying fs call runs on the libuv
  // threadpool while this function is suspended at `await`) where the directory could
  // already exist on disk but a signal landing in that window would find it still
  // unregistered.
  //
  // #944: explicit mode: 0o700 on both this and dataDir's mkdir below — this staging
  // tree holds a full plaintext copy of --from-restored-dir's payload, and without an
  // explicit mode a plain mkdir()/mkdirSync() lands at the umask-default (typically
  // 0o755 under umask 022), exposing that plaintext to other local users even when the
  // SOURCE directory was deliberately locked down to 0o700. Unlike keys.ts's
  // keygenAt()/wallet.ts's createKeyFile() (which follow their own mkdir with an
  // explicit chmod, because THEIR directory can already exist from an earlier run),
  // tmpOutDir and dataDir are always freshly created here — tmpOutDir's name is a
  // fresh per-process/per-call random suffix and dataDir is a brand-new subdirectory of
  // it, so a plain (non-recursive) mkdir with mode: 0o700 at creation time is
  // sufficient: there is no pre-existing directory whose looser mode a follow-up chmod
  // would need to correct. (0o700 also has no group/other bits for a default umask to
  // even mask out.) Once this is done, `rename(tmpOutDir, outDir)` below publishes the
  // finished bag — rename() preserves a directory's own mode, so --out-dir inherits
  // 0o700 automatically; confirmed by this file's own selftest.
  installStageSignalGuard();
  mkdirSync(tmpOutDir, { mode: 0o700 });
  addActiveBagitScratchDir(tmpOutDir);
  try {
    const dataDir = join(tmpOutDir, 'data');
    await mkdir(dataDir, { mode: 0o700 });
    for (const name of fileNames) {
      await copyFile(join(fromDir, name), join(dataDir, name));
    }

    // bagit.txt — RFC 8493 section 2.1.1: "The 'bagit.txt' tag file MUST consist of
    // exactly two lines in this order: 'BagIt-Version: M.N' / 'Tag-File-Character-
    // Encoding: ENCODING'." This version of BagIt is 1.0 (the RFC's own wording); the
    // encoding SHOULD be UTF-8 per the same section, and this writer always uses it.
    await writeFile(join(tmpOutDir, 'bagit.txt'), 'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n', 'utf8');

    // manifest-sha256.txt — one line per file under data/, each hashed by RE-READING the
    // file that was just written to dataDir above (never trusting the source bytes, or a
    // stat() of the source) — the same "verify what actually landed, not what you
    // intended to write" posture restore.ts applies throughout (e.g. its own #785 doc
    // comment on artifactChangedDigest()).
    const relFiles = (await listFilesRecursive(dataDir)).sort();
    let octetCount = 0;
    const manifestLines: string[] = [];
    for (const rel of relFiles) {
      const abs = join(dataDir, ...rel.split('/'));
      const [hash, st] = await Promise.all([sha256(abs), stat(abs)]);
      octetCount += st.size;
      manifestLines.push(`${hash}${MANIFEST_LINE_SEP}data/${rel}\n`);
    }
    await writeFile(join(tmpOutDir, 'manifest-sha256.txt'), manifestLines.join(''), 'utf8');

    // bag-info.txt — every field here is OPTIONAL per RFC 8493 (bag-info.txt itself has
    // no required fields at all), but these three are worth recording: when this bag was
    // made, what made it, and — Payload-Oxum specifically — a cheap completeness check any
    // BagIt-aware tool can run without re-hashing everything (RFC 8493 section 2.2.2:
    // "MUST be in the form 'OctetCount.StreamCount'" — no thousands separators, a literal
    // "." joining the two counts, not a decimal number).
    const baggingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
    const softwareAgent = `cypher-brain ${resolveOwnVersion()}`;
    const bagInfoLines =
      `Bagging-Date: ${baggingDate}\n` +
      `Bag-Software-Agent: ${softwareAgent}\n` +
      `Payload-Oxum: ${octetCount}.${relFiles.length}\n`;
    await writeFile(join(tmpOutDir, 'bag-info.txt'), bagInfoLines, 'utf8');

    // tagmanifest-sha256.txt — written LAST, and covers EXACTLY the three tag files just
    // written above (bagit.txt, bag-info.txt, manifest-sha256.txt), hashed only once each
    // is fully on disk. RFC 8493 section 2.2.1: a tag manifest "MUST list every payload
    // manifest" and "MUST NOT list any tag manifests" (itself) "MUST NOT list any payload
    // files" (nothing under data/ belongs here).
    const tagFiles = ['bagit.txt', 'bag-info.txt', 'manifest-sha256.txt'];
    const tagLines: string[] = [];
    for (const name of tagFiles) {
      const hash = await sha256(join(tmpOutDir, name));
      tagLines.push(`${hash}${MANIFEST_LINE_SEP}${name}\n`);
    }
    await writeFile(join(tmpOutDir, 'tagmanifest-sha256.txt'), tagLines.join(''), 'utf8');

    // Publish. A plain rename() cannot atomically REPLACE a non-empty existing directory
    // (unlike writeKeyFile()'s single-file rename, which the OS itself makes atomic even
    // when replacing) — so under --force, the old outDir is removed immediately before
    // the rename, not before everything above. Residual, stated rather than hidden (same
    // posture as restore.ts's own documented TOCTOU residuals): a failure in the narrow
    // window between this rm() and the rename() just below reaches the catch block below,
    // which removes `tmpOutDir` on ANY failure — so this specific window can leave NEITHER
    // --out-dir NOR the freshly-built bag behind. Nothing is silently corrupted or lost,
    // though: --from-restored-dir (the only source of truth) is never touched by any of
    // this, so the fix is simply re-running bagit-export, which recomputes byte-identical
    // output from it — not a data-loss case, just a wasted computation in an already rare
    // race (mkdir/rename failing at exactly this line, e.g. ENOSPC/EIO).
    if (force && outExists) await rm(outDir, { recursive: true, force: true });
    await rename(tmpOutDir, outDir);
    // Deregister only AFTER the rename actually moved it away from tmpOutDir (same
    // "delete() only after confirmed gone" convention keys.ts's writeKeyFile() and
    // restore.ts's expandComponents() both use) — a signal landing between the rename
    // above and this line would find tmpOutDir already gone (ENOENT), so
    // forceRmSync's own swallowed-ENOENT handling makes that harmless either way.
    removeActiveBagitScratchDir(tmpOutDir);
    return { outDir, fileCount: relFiles.length, octetCount, files: relFiles };
  } catch (e) {
    try {
      await rm(tmpOutDir, { recursive: true, force: true });
      removeActiveBagitScratchDir(tmpOutDir);
    } catch {
      // Leave it registered on a genuine removal failure (not swallowed): the same
      // keys.ts writeKeyFile() convention — a later signal's own forceRmSync gets
      // another chance, instead of the bookkeeping wrongly saying it was already
      // handled.
    }
    throw e;
  }
}

// CLI entry point (`cypher-brain bagit-export`, src/cli.ts's dispatch table).
export async function bagitExportCommand(o: CliOptions): Promise<void> {
  if (!o.from_restored_dir) throw new UsageError('--from-restored-dir <dir> required');
  if (!o.out_dir) throw new UsageError('--out-dir <path> required');
  const result = await exportBagit({ fromDir: o.from_restored_dir, outDir: o.out_dir, force: o.force });
  if (o.json) {
    printJson(result);
    return;
  }
  console.log(`BagIt bag written to ${result.outDir} (${result.fileCount} file(s), ${result.octetCount} bytes)`);
}
