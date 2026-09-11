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
import { readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { sha256 } from './util.js';
import { printJson } from './ui.js';
import { UsageError } from './errors.js';
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
    console.log(
      `bagit-export: skipping "${join(fromDir, 'expanded')}" — this is restore's own derived/expanded view of ` +
        'components already present as their own *.tar.gz archives; re-including it would duplicate the payload ' +
        'and inflate the bag for no interoperability benefit',
    );
  }
  return { files };
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

// The core writer. See this module's own header comment for scope, and RFC 8493 for the
// exact normative shapes below — every format decision here was checked against the
// RFC's own text, not written from memory of what a "bag" generally looks like.
export async function exportBagit(opts: BagitExportOptions): Promise<BagitExportResult> {
  const { fromDir, outDir, force } = opts;
  const { files: fileNames } = await planTopLevel(fromDir);

  // --force semantics: refuse an existing destination outright unless --force, matching
  // this codebase's existing no-clobber convention (e.g. sss-combine's own `--out already
  // exists` refusal in keys.ts). lstat (not stat/exists()) so a symlink already sitting at
  // outDir counts as "already exists" too, rather than silently following it.
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

  // Atomicity: everything is written into a temporary SIBLING directory first (same
  // parent as outDir, so the final publish below is a same-filesystem rename), mirroring
  // keys.ts's writeKeyFile() tmp-then-rename discipline for a single file, adapted here
  // for a whole directory tree. Nothing is ever written directly at `outDir` until every
  // other file has already been written and hashed successfully.
  await mkdir(dirname(outDir), { recursive: true });
  const tmpOutDir = join(dirname(outDir), `.bagit-export-${process.pid}-${randomBytes(4).toString('hex')}.partial`);
  await mkdir(tmpOutDir);
  try {
    const dataDir = join(tmpOutDir, 'data');
    await mkdir(dataDir);
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
    return { outDir, fileCount: relFiles.length, octetCount, files: relFiles };
  } catch (e) {
    await rm(tmpOutDir, { recursive: true, force: true }).catch(() => {});
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
