#!/usr/bin/env node
// Unit tests for src/lib/bagit.ts's exportBagit()/bagitExportCommand() (issue #217,
// BagIt only — see that file's own header comment for scope), plus a handful of
// `dist/cli.mjs bagit-export` invocations for the CLI/--json/exit-code surface.
//
// Everything lives under one mkdtemp'd scratch tree, removed in a `finally` — no
// CYPHER_BRAIN_HOME, no port, no LaunchAgent write, no encryption/backend/network touched
// (bagit-export operates entirely on plaintext already on local disk).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist/cli.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
async function checkThrows(name, fn, matcher) {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (e) {
    const ok = matcher ? matcher(e) : true;
    check(name, ok, ok ? undefined : `wrong/unexpected error: ${e.message}`);
  }
}
async function pathExists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
const sha256hex = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

const tmp = await mkdtemp(join(tmpdir(), 'cb-bagit-export-'));
try {
  const { exportBagit } = await import('../src/lib/bagit.ts');

  // ---- fixture builder: a tiny fake "restore --out-dir" output ----
  async function makeRestoreDir(name, opts = {}) {
    const dir = join(tmp, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ tool: 'cypher-brain', schema: 1, components: [] }));
    await writeFile(join(dir, 'component-a.tar.gz'), 'fake tar bytes for component a — content need not be a real tar');
    await writeFile(join(dir, 'db.dump'), 'fake pg_dump bytes');
    if (opts.minisig) await writeFile(join(dir, 'component-a.tar.gz.minisig'), 'fake detached signature');
    if (opts.empty) await writeFile(join(dir, 'empty-component.tar.gz'), Buffer.alloc(0));
    if (opts.unicode) await writeFile(join(dir, opts.unicode), 'unicode-named component bytes');
    if (opts.expanded) {
      const exp = join(dir, 'expanded');
      await mkdir(join(exp, '001-thing'), { recursive: true });
      await writeFile(join(exp, '001-thing', 'inner.txt'), 'restore-derived, already-decompressed content');
      await writeFile(join(exp, 'README.txt'), 'source-path mapping table');
    }
    return dir;
  }

  // ---- 1. basic round trip: exact bagit.txt, bag-info.txt fields, manifest/tagmanifest
  //         hashes match an INDEPENDENTLY recomputed sha256 of the actual data/ files ----
  {
    const from = await makeRestoreDir('basic', { minisig: true });
    const out = join(tmp, 'basic-out');
    const result = await exportBagit({ fromDir: from, outDir: out });
    check(
      'basic: result reports the 4 real files (manifest.json, component-a.tar.gz, its .minisig, db.dump)',
      result.fileCount === 4,
      JSON.stringify(result),
    );

    const bagit = await readFile(join(out, 'bagit.txt'), 'utf8');
    check(
      'basic: bagit.txt is exactly the RFC 8493 two-line form',
      bagit === 'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n',
      JSON.stringify(bagit),
    );

    const baginfo = await readFile(join(out, 'bag-info.txt'), 'utf8');
    check(
      'basic: bag-info.txt has Bagging-Date as a bare ISO date',
      /^Bagging-Date: \d{4}-\d{2}-\d{2}$/m.test(baginfo),
    );
    check(
      'basic: bag-info.txt has Bag-Software-Agent naming cypher-brain',
      /^Bag-Software-Agent: cypher-brain \S+$/m.test(baginfo),
    );
    check(
      'basic: bag-info.txt Payload-Oxum matches the result exactly (OctetCount.StreamCount, no comma)',
      new RegExp(`^Payload-Oxum: ${result.octetCount}\\.${result.fileCount}$`, 'm').test(baginfo),
      baginfo,
    );

    const manifest = await readFile(join(out, 'manifest-sha256.txt'), 'utf8');
    const manifestLines = manifest.split('\n').filter((l) => l.length > 0);
    check('basic: manifest-sha256.txt has exactly one line per data/ file', manifestLines.length === result.fileCount);
    let recomputedOctets = 0;
    for (const line of manifestLines) {
      const m = /^([0-9a-f]{64}) {2}data\/(.+)$/.exec(line);
      assert.ok(m, `manifest line does not match "<sha256>  data/<path>": ${JSON.stringify(line)}`);
      const [, hash, relPath] = m;
      const dataPath = join(out, 'data', relPath);
      const actualHash = await sha256hex(dataPath);
      check(`basic: manifest hash for data/${relPath} matches an independently recomputed sha256`, hash === actualHash);
      recomputedOctets += (await readFile(dataPath)).length;
    }
    check(
      'basic: Payload-Oxum octet count matches an independently summed data/ size',
      recomputedOctets === result.octetCount,
    );

    const tagmanifest = await readFile(join(out, 'tagmanifest-sha256.txt'), 'utf8');
    const tagLines = tagmanifest.split('\n').filter((l) => l.length > 0);
    check(
      'basic: tagmanifest-sha256.txt lists exactly the 3 tag files (bagit.txt, bag-info.txt, manifest-sha256.txt)',
      tagLines.length === 3,
    );
    check('basic: tagmanifest-sha256.txt names no payload (data/) file', !tagmanifest.includes('data/'));
    for (const line of tagLines) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      assert.ok(m, `tagmanifest line does not match "<sha256>  <name>": ${JSON.stringify(line)}`);
      const [, hash, name] = m;
      check(
        `basic: tagmanifest hash for ${name} matches an independently recomputed sha256`,
        hash === (await sha256hex(join(out, name))),
      );
    }
  }

  // ---- 2. expanded/ is skipped (info message, not an error), never copied into data/ ----
  {
    const from = await makeRestoreDir('with-expanded', { expanded: true });
    const out = join(tmp, 'expanded-out');
    await exportBagit({ fromDir: from, outDir: out });
    const dataEntries = await readdir(join(out, 'data'));
    check('expanded: "expanded" is not copied into data/', !dataEntries.includes('expanded'));
    const manifest = await readFile(join(out, 'manifest-sha256.txt'), 'utf8');
    check('expanded: manifest-sha256.txt has no entry mentioning expanded/', !manifest.includes('expanded'));
  }

  // ---- 3. any top-level symlink refuses the whole export, before anything is written ----
  {
    const from = await makeRestoreDir('with-symlink');
    await symlink(join(from, 'manifest.json'), join(from, 'evil-link.tar.gz'));
    const out = join(tmp, 'symlink-out');
    await checkThrows(
      'symlink: a top-level symlink refuses the export via the DEDICATED symlink check (not just the generic "unexpected entry type" fallback)',
      () => exportBagit({ fromDir: from, outDir: out }),
      (e) => /refuses to follow or include any symlink/.test(e.message),
    );
    check('symlink: no --out-dir was created at all', !(await pathExists(out)));
    const siblings = await readdir(tmp);
    check(
      'symlink: no leftover .bagit-export-*.partial temp directory either',
      !siblings.some((n) => n.startsWith('.bagit-export-')),
    );
  }

  // ---- 4. an unexpected directory (not "expanded") at the top level refuses ----
  {
    const from = await makeRestoreDir('with-unexpected-dir');
    await mkdir(join(from, 'not-expanded'));
    await checkThrows(
      'unexpected dir: a non-"expanded" top-level directory refuses the export',
      () => exportBagit({ fromDir: from, outDir: join(tmp, 'unexpected-dir-out') }),
      (e) => /unexpected directory/.test(e.message),
    );
  }

  // ---- 5. empty file and a Unicode/special-character filename are both handled ----
  {
    const unicodeName = 'コンポーネント-emoji-😀ファイル.tar.gz';
    const from = await makeRestoreDir('unicode', { empty: true, unicode: unicodeName });
    const out = join(tmp, 'unicode-out');
    const result = await exportBagit({ fromDir: from, outDir: out });
    check('unicode: empty file is present in the result', result.files.includes('empty-component.tar.gz'));
    check('unicode: unicode-named file is present in the result', result.files.includes(unicodeName));
    check(
      'unicode: empty file actually landed as 0 bytes in data/',
      (await readFile(join(out, 'data', 'empty-component.tar.gz'))).length === 0,
    );
    const emptyHash = await sha256hex(join(out, 'data', 'empty-component.tar.gz'));
    check(
      "unicode: empty file's manifest hash is sha256 of the empty string",
      emptyHash === createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    );
    const manifest = await readFile(join(out, 'manifest-sha256.txt'), 'utf8');
    check(
      'unicode: manifest-sha256.txt references the unicode filename verbatim',
      manifest.includes(`data/${unicodeName}`),
    );
    check(
      'unicode: unicode-named file landed with correct, matching bytes',
      (await readFile(join(out, 'data', unicodeName), 'utf8')) === 'unicode-named component bytes',
    );
  }

  // ---- 6. --from-restored-dir missing manifest.json is refused ----
  {
    const from = join(tmp, 'no-manifest');
    await mkdir(from);
    await writeFile(join(from, 'component-a.tar.gz'), 'x');
    await checkThrows(
      'no manifest.json: refuses',
      () => exportBagit({ fromDir: from, outDir: join(tmp, 'no-manifest-out') }),
      (e) => /manifest\.json/.test(e.message),
    );
  }

  // ---- 7. nonexistent --from-restored-dir is refused with a clear message ----
  await checkThrows(
    'nonexistent --from-restored-dir: refuses',
    () => exportBagit({ fromDir: join(tmp, 'does-not-exist'), outDir: join(tmp, 'does-not-exist-out') }),
    (e) => /does not exist/.test(e.message),
  );

  // ---- 8. --out-dir already existing: refused without --force, replaces (not merges)
  //         with --force ----
  {
    const from = await makeRestoreDir('force-test');
    const out = join(tmp, 'force-out');
    await mkdir(out);
    await writeFile(join(out, 'stale-marker.txt'), 'leftover from an earlier, unrelated bag');
    await checkThrows(
      'force: an existing --out-dir is refused without --force',
      () => exportBagit({ fromDir: from, outDir: out }),
      (e) => /already exists/.test(e.message),
    );
    check('force: the stale marker survives the refusal untouched', await pathExists(join(out, 'stale-marker.txt')));
    await exportBagit({ fromDir: from, outDir: out, force: true });
    check(
      'force: --force REPLACES rather than merges — the stale marker is gone',
      !(await pathExists(join(out, 'stale-marker.txt'))),
    );
    check('force: the freshly-written bagit.txt is now present', await pathExists(join(out, 'bagit.txt')));
  }

  // ---- 9. an interrupted write leaves NO half-written directory at the final --out-dir
  //         path. Simulated by revoking read permission on one of the source files
  //         partway through the copy loop — copyFile() then throws for that file, exactly
  //         as an unwritable target/a disk error would; either way the loop dies mid-run,
  //         which is the class of fault this test is for. ----
  {
    const from = await makeRestoreDir('interrupt-test');
    const out = join(tmp, 'interrupt-out');
    const blocked = join(from, 'db.dump');
    await chmod(blocked, 0o000);
    try {
      await checkThrows(
        'interrupt: a mid-loop read/write failure throws (not a silent partial success)',
        () => exportBagit({ fromDir: from, outDir: out }),
        (e) => /EACCES|permission/i.test(e.message),
      );
    } finally {
      await chmod(blocked, 0o644); // restore perms so this scratch tree can be rm -rf'd
    }
    check('interrupt: no directory was left at the final --out-dir path', !(await pathExists(out)));
    const siblings = await readdir(tmp);
    check(
      'interrupt: no leftover .bagit-export-*.partial temp directory either',
      !siblings.some((n) => n.startsWith('.bagit-export-')),
    );
  }

  // ---- 10. --out-dir overlapping --from-restored-dir (same path, --out-dir nested
  //          inside it, or --out-dir an ancestor of it) refuses BEFORE anything is
  //          written or removed, even with --force — regression test for a Critical
  //          multi-model review finding: without this check, --force would have this
  //          function's own destination-clobber rm() delete the restore output it
  //          promises to only ever read. ----
  {
    const from = await makeRestoreDir('overlap-same');
    await checkThrows(
      'overlap: --out-dir identical to --from-restored-dir refuses, even with --force',
      () => exportBagit({ fromDir: from, outDir: from, force: true }),
      (e) => /overlaps/.test(e.message),
    );
    check(
      'overlap (same): --from-restored-dir/manifest.json survives untouched',
      await pathExists(join(from, 'manifest.json')),
    );

    const fromNested = await makeRestoreDir('overlap-nested');
    const insideIt = join(fromNested, 'bag-goes-here');
    await checkThrows(
      'overlap: --out-dir nested INSIDE --from-restored-dir refuses, even with --force',
      () => exportBagit({ fromDir: fromNested, outDir: insideIt, force: true }),
      (e) => /overlaps/.test(e.message),
    );
    check(
      'overlap (nested-in): --from-restored-dir/manifest.json survives untouched',
      await pathExists(join(fromNested, 'manifest.json')),
    );

    const ancestorOut = join(tmp, 'overlap-ancestor-out');
    const fromInsideOut = join(ancestorOut, 'restored');
    await mkdir(fromInsideOut, { recursive: true });
    await writeFile(join(fromInsideOut, 'manifest.json'), '{}');
    await checkThrows(
      'overlap: --out-dir an ANCESTOR of --from-restored-dir refuses, even with --force',
      () => exportBagit({ fromDir: fromInsideOut, outDir: ancestorOut, force: true }),
      (e) => /overlaps/.test(e.message),
    );
    check(
      'overlap (ancestor-out): --from-restored-dir/manifest.json survives untouched',
      await pathExists(join(fromInsideOut, 'manifest.json')),
    );
  }

  // ---- 11. a top-level filename containing a literal CR or LF is refused, rather than
  //          silently corrupting manifest-sha256.txt's line-oriented format ----
  {
    const from = await makeRestoreDir('crlf-name');
    await writeFile(join(from, 'bad\nname.tar.gz'), 'x');
    await checkThrows(
      'crlf: a top-level filename containing LF refuses the export',
      () => exportBagit({ fromDir: from, outDir: join(tmp, 'crlf-out') }),
      (e) => /CR or LF/.test(e.message),
    );
  }

  // ---- 12. --json output is never corrupted by the "skipping expanded/" informational
  //          message — regression test for a Warning multi-model review finding
  //          (that message must go to stderr, never stdout) ----
  {
    const from = await makeRestoreDir('json-with-expanded', { expanded: true });
    const out = join(tmp, 'json-with-expanded-out');
    const cli = (args) => spawnSync(process.execPath, [dist, ...args], { encoding: 'utf8', timeout: 30000 });
    const r = cli(['bagit-export', '--from-restored-dir', from, '--out-dir', out, '--json']);
    check('json+expanded: exits 0', r.status === 0, `${r.stdout}${r.stderr}`);
    check('json+expanded: the "skipping expanded" message appears on stderr', /skipping/.test(r.stderr ?? ''));
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      check(
        'json+expanded: stdout is valid JSON, not polluted by the informational message',
        false,
        `${e.message} — stdout was: ${JSON.stringify(r.stdout)}`,
      );
    }
    if (parsed) {
      check(
        'json+expanded: stdout parses to exactly the result object',
        parsed.outDir === out && typeof parsed.fileCount === 'number',
      );
    }
  }

  // ---- 13. CLI surface: --json shape, exit codes, missing-flag messages ----
  {
    const cli = (args) => {
      const r = spawnSync(process.execPath, [dist, ...args], { encoding: 'utf8', timeout: 30000 });
      return { ...r, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const from = await makeRestoreDir('cli-basic');
    const out = join(tmp, 'cli-out');

    const rJson = cli(['bagit-export', '--from-restored-dir', from, '--out-dir', out, '--json']);
    check('cli: --json invocation exits 0', rJson.status === 0, rJson.output);
    let parsed;
    try {
      parsed = JSON.parse(rJson.stdout);
    } catch {
      /* left undefined — asserted below */
    }
    check(
      'cli: --json prints exactly {outDir, fileCount, octetCount, files}',
      !!parsed &&
        parsed.outDir === out &&
        typeof parsed.fileCount === 'number' &&
        typeof parsed.octetCount === 'number' &&
        Array.isArray(parsed.files),
      rJson.stdout,
    );

    const rMissingFrom = cli(['bagit-export', '--out-dir', join(tmp, 'cli-missing-from-out')]);
    check('cli: missing --from-restored-dir exits non-zero', rMissingFrom.status !== 0);
    check('cli: missing --from-restored-dir names the flag on stderr', /--from-restored-dir/.test(rMissingFrom.output));

    const rMissingOut = cli(['bagit-export', '--from-restored-dir', from]);
    check('cli: missing --out-dir exits non-zero', rMissingOut.status !== 0);
    check('cli: missing --out-dir names the flag on stderr', /--out-dir/.test(rMissingOut.output));

    const rExists = cli(['bagit-export', '--from-restored-dir', from, '--out-dir', out]);
    check('cli: re-running against an existing --out-dir without --force exits non-zero', rExists.status !== 0);
    check('cli: names --force as the remedy', /--force/.test(rExists.output));

    const rForce = cli(['bagit-export', '--from-restored-dir', from, '--out-dir', out, '--force']);
    check('cli: re-running with --force succeeds', rForce.status === 0, rForce.output);
  }

  // ---- 14. --out-dir already existing (no --force) refuses BEFORE planTopLevel() ever
  //          walks --from-restored-dir — regression test for #923: the cheap, purely-local
  //          "does --out-dir exist" check must run first, so a doomed invocation never
  //          prints the "skipping ... expanded" informational message (which would
  //          otherwise imply progress on a run that is about to abort anyway) ----
  {
    const from = await makeRestoreDir('preexisting-out-with-expanded', { expanded: true });
    const out = join(tmp, 'preexisting-out-with-expanded-out');
    await mkdir(out); // pre-create --out-dir so the existing-out-dir refusal fires
    const cli = (args) => spawnSync(process.execPath, [dist, ...args], { encoding: 'utf8', timeout: 30000 });
    const r = cli(['bagit-export', '--from-restored-dir', from, '--out-dir', out]);
    check('existing-out-dir+expanded: exits non-zero', r.status !== 0, `${r.stdout}${r.stderr}`);
    check('existing-out-dir+expanded: refuses with "already exists"', /already exists/.test(r.stderr ?? ''), r.stderr);
    check(
      'existing-out-dir+expanded: the "skipping expanded" message is NOT printed — the ' +
        'out-dir-exists check ran before planTopLevel() ever walked fromDir',
      !/skipping/.test(r.stderr ?? ''),
      r.stderr,
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\nBAGIT-EXPORT SELFTEST: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
