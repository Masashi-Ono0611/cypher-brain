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
  const { exportBagit, findNormalizedNameCollisions } = await import('../src/lib/bagit.ts');

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
  // ---- 15. #943: two top-level filenames that would collapse onto the same path on a
  //          case-insensitive or Unicode-normalization-insensitive destination
  //          filesystem (default macOS/APFS) refuse the whole export, naming both.
  //
  //          This repo's own CI matrix runs both macos-latest AND ubuntu-latest (see
  //          scripts/check-help-docs.mjs's own header comment). Two real files named
  //          e.g. "component-a.tar.gz" and "Component-A.tar.gz" CANNOT both exist as
  //          distinct dirents on macOS's default APFS -- the OS itself folds the second
  //          write onto the first (verified empirically while writing this test: doing
  //          exactly that on this machine left only ONE real file behind, before
  //          bagit-export's own code ever ran) -- while on ext4 (ubuntu-latest) they
  //          could. Building this test's SOURCE fixture from real same-named files
  //          would therefore only exercise the intended code path on ONE of the two CI
  //          runners and silently no-op (not fail -- just prove nothing) on the other.
  //          Per this task's own fallback instruction, the fix is tested at the level
  //          that IS deterministic on every runner: the exported, pure
  //          findNormalizedNameCollisions() itself, with synthetic string arrays that
  //          never touch a real filesystem, plus a non-colliding-fixture smoke check
  //          that the wiring does not false-positive on an ordinary export. ----
  {
    check(
      'findNormalizedNameCollisions: no collision among genuinely distinct names returns no groups',
      findNormalizedNameCollisions(['component-a.tar.gz', 'db.dump', 'manifest.json']).length === 0,
    );
    check(
      'findNormalizedNameCollisions: two names differing only by ASCII case are grouped together',
      (() => {
        const groups = findNormalizedNameCollisions(['component-a.tar.gz', 'Component-A.tar.gz', 'db.dump']);
        return (
          groups.length === 1 &&
          groups[0].length === 2 &&
          groups[0].includes('component-a.tar.gz') &&
          groups[0].includes('Component-A.tar.gz')
        );
      })(),
    );
    {
      // A precomposed vs. decomposed accented character, built from \u escapes (not
      // typed literals) so the source bytes of THIS file cannot silently collapse both
      // into the same form the way two visually-identical typed characters did in an
      // earlier draft of this test (caught during review). NFC form is one codepoint
      // (U+00E9 "e with acute"); NFD form is two codepoints ("e" U+0065 + a combining
      // acute accent U+0301) -- visually identical, byte-distinct.
      const nfc = 'caf\u00e9.tar.gz';
      const nfd = 'cafe\u0301.tar.gz';
      assert.notStrictEqual(nfc, nfd, 'test fixture bug: NFC/NFD forms must be byte-distinct to be a real test');
      assert.strictEqual(nfc, nfd.normalize('NFC'), 'test fixture bug: nfd must actually normalize to nfc');
      const groups = findNormalizedNameCollisions([nfc, nfd, 'unrelated.txt']);
      check(
        'findNormalizedNameCollisions: NFC vs NFD forms of the same visible name are grouped together',
        groups.length === 1 && groups[0].length === 2 && groups[0].includes(nfc) && groups[0].includes(nfd),
        JSON.stringify(groups),
      );
    }
    check(
      'findNormalizedNameCollisions: a 3-way collision group names all three conflicting filenames, not just the first two',
      (() => {
        const groups = findNormalizedNameCollisions(['FOO.TXT', 'foo.txt', 'Foo.Txt', 'bar.txt']);
        return groups.length === 1 && groups[0].length === 3;
      })(),
    );

    // Regression test for a multi-model review finding: normalizing BEFORE lowercasing
    // (the original order this fix shipped with) left this specific pair undetected. A
    // decomposed uppercase "J" (U+004A) + combining caron (U+030C) does not compose to
    // anything under NFC while still uppercase (there is no precomposed uppercase
    // "J WITH CARON"), so it must be lowercased FIRST — collapsing to the same
    // decomposed "j" + combining caron as the precomposed lowercase "ǰ" (U+01F0) — and
    // only THEN normalized to land on an identical key. See bagit.ts's own doc comment
    // on findNormalizedNameCollisions() for the fix (toLowerCase().normalize('NFC')).
    {
      const precomposedLowerJCaron = '\u01f0.tar.gz'; // precomposed "j with caron", already lowercase
      const decomposedUpperJCaron = 'J\u030c.tar.gz'; // "J" + combining caron, uppercase
      assert.notStrictEqual(
        precomposedLowerJCaron,
        decomposedUpperJCaron,
        'test fixture bug: these two forms must be byte-distinct to be a real test',
      );
      const groups = findNormalizedNameCollisions([precomposedLowerJCaron, decomposedUpperJCaron, 'unrelated.txt']);
      check(
        'findNormalizedNameCollisions: precomposed lowercase "ǰ" and decomposed uppercase "J+combining caron" are grouped together (order-of-operations regression)',
        groups.length === 1 &&
          groups[0].length === 2 &&
          groups[0].includes(precomposedLowerJCaron) &&
          groups[0].includes(decomposedUpperJCaron),
        JSON.stringify(groups),
      );
    }

    // Documented, deliberately accepted residual (multi-model review finding, see
    // bagit.ts's own doc comment on findNormalizedNameCollisions()): a simple
    // toLowerCase() case-fold does NOT catch Greek context-sensitive special-casing
    // pairs like "Σ"/final-form "ς" — "Σ".toLowerCase() is always "σ", never "ς". This
    // test documents that CURRENT, intentional behavior (full Unicode case-folding
    // would need a CaseFolding.txt table this file's own header comment says it
    // deliberately does not carry as a new dependency) so a future reader sees this
    // gap as a recorded decision, not a silent regression waiting to be "discovered".
    {
      const groups = findNormalizedNameCollisions([
        '\u03c3.tar.gz' /* \u03c3 (sigma) */,
        '\u03c2.tar.gz' /* \u03c2 (final sigma) */,
      ]);
      check(
        'findNormalizedNameCollisions: KNOWN LIMITATION (documented, not a bug) — Greek "σ" vs final-form "ς" is not detected as a case-fold collision',
        groups.length === 0,
        JSON.stringify(groups),
      );
    }

    // exportBagit() calls this exact function immediately after planTopLevel() (see
    // bagit.ts) and throws naming every colliding filename if it returns any groups --
    // covered directly by reading that call site plus the coverage above of the
    // function itself. This smoke check instead confirms the wiring does NOT
    // false-positive on an ordinary, non-colliding fixture (an over-eager check would
    // be its own bug).
    const from = await makeRestoreDir('collision-wiring-smoke');
    const out = join(tmp, 'collision-wiring-smoke-out');
    const result = await exportBagit({ fromDir: from, outDir: out });
    check(
      'collision check does not false-positive on a normal, non-colliding fixture (no accidental over-refusal)',
      result.fileCount > 0,
    );

    // ---- 15c. positive control: confirm the underlying defect this refusal exists to
    //           prevent actually holds — a NAIVE per-name copy loop (exactly what
    //           exportBagit()'s own copy loop does, minus the #943 refusal) that copies
    //           two DIFFERENT real source files onto the SAME destination path silently
    //           drops the first one's content, with the destination directory afterward
    //           looking completely normal (one file, one passing checksum) — exactly
    //           the "reports success, no error, no way to detect after the fact"
    //           failure mode #943 describes. This does not depend on the two SOURCE
    //           names actually colliding on this filesystem (the platform-dependent
    //           part 15's own header explains): it demonstrates the copyFile-overwrite
    //           mechanism directly, using two ordinary, genuinely-coexisting real files
    //           and manually directing both copies at one shared destination path,
    //           exactly as a case/normalization-folding destination filesystem would. ----
    {
      const collideDir = join(tmp, 'positive-control-collide-dest');
      await mkdir(collideDir, { recursive: true });
      const { copyFile: rawCopyFile } = await import('node:fs/promises');
      const destPath = join(collideDir, 'landed.tar.gz'); // both copies below target this ONE path
      await rawCopyFile(join(from, 'component-a.tar.gz'), destPath);
      const firstLanded = await readFile(destPath, 'utf8');
      await rawCopyFile(join(from, 'db.dump'), destPath); // simulates a case/normalization-folding destination
      const secondLanded = await readFile(destPath, 'utf8');
      const entries = await readdir(collideDir);
      check(
        'positive control (RED without #943): a naive per-name copy loop onto a shared/folded destination path silently drops the first file — this is the exact defect class #943 refuses to let happen',
        firstLanded !== secondLanded && entries.length === 1,
        `first=${JSON.stringify(firstLanded)} second=${JSON.stringify(secondLanded)} entries=${JSON.stringify(entries)}`,
      );
    }

    // ---- 15d. real, adaptive integration test through exportBagit() itself —
    //           regression test for a multi-model review finding: without this, the
    //           ENTIRE #943 refusal block in exportBagit() could be deleted and every
    //           test above would still pass (15a-c only test the standalone function
    //           and a generic copy loop, never exportBagit() with a real collision).
    //
    //           This repo's CI matrix runs both macos-latest (APFS folds these names —
    //           see this test's own header comment above) and ubuntu-latest (ext4 does
    //           not). Rather than skip the integration path entirely on the
    //           non-cooperating runner, this tries several candidate colliding pairs
    //           and — for whichever ones this runner's filesystem actually lets exist
    //           as two distinct real dirents — runs exportBagit() for real and asserts
    //           it refuses, naming both files, with no --out-dir or leftover
    //           .bagit-export-*.partial created. On a runner where every candidate
    //           folds (as this fix's own local development machine's does), this is
    //           reported as an explicit, visible SKIP (not a silent no-op or false
    //           PASS) rather than a failing check — the deterministic 15a coverage
    //           above still exercises the exact function exportBagit() calls. ----
    {
      const candidates = [
        { label: 'ASCII case', a: 'Collide-A.tar.gz', b: 'collide-a.tar.gz' },
        { label: 'NFC vs NFD', a: 'caf\u00e9-collide.tar.gz', b: 'cafe\u0301-collide.tar.gz' },
        { label: 'precomposed/decomposed j-caron', a: '\u01f0collide.tar.gz', b: 'J\u030ccollide.tar.gz' },
      ];
      let ranAtLeastOneIntegrationCase = false;
      for (const [candidateIndex, { label, a, b }] of candidates.entries()) {
        const collideFrom = await makeRestoreDir(`collision-integration-${candidateIndex}`);
        await writeFile(join(collideFrom, a), 'first colliding file bytes');
        await writeFile(join(collideFrom, b), 'second colliding file bytes, deliberately different');
        const entries = await readdir(collideFrom);
        if (!(entries.includes(a) && entries.includes(b))) {
          console.log(
            `[SKIP] collision-integration (${label}): this filesystem folds "${a}" and "${b}" onto the same real dirent before bagit-export's own code runs — platform-dependent, not exercisable here (see 15a for deterministic coverage of the same check)`,
          );
          continue;
        }
        ranAtLeastOneIntegrationCase = true;
        const collideOut = join(tmp, `collision-integration-${label.replace(/\s+/g, '-')}-out`);
        await checkThrows(
          `collision-integration (${label}): exportBagit() itself refuses a real on-disk collision, naming both files`,
          () => exportBagit({ fromDir: collideFrom, outDir: collideOut }),
          (e) => /collide/.test(e.message) && e.message.includes(a) && e.message.includes(b),
        );
        check(`collision-integration (${label}): no --out-dir was created at all`, !(await pathExists(collideOut)));
        const siblings = await readdir(tmp);
        check(
          `collision-integration (${label}): no leftover .bagit-export-*.partial temp directory either`,
          !siblings.some((n) => n.startsWith('.bagit-export-')),
        );
      }
      if (!ranAtLeastOneIntegrationCase) {
        console.log(
          '[SKIP] collision-integration: every candidate pair folded to one real dirent on this filesystem — no real on-disk integration case could run here this time',
        );
      }
    }
  }

  // ---- 16. #944: the bag's staging directories (the tmp `.bagit-export-*.partial`
  //          sibling AND its `data/` subdirectory, published as --out-dir via rename())
  //          are created mode 0700 even under a permissive process umask — regression
  //          test with a real red/green positive control: temporarily revert the fix
  //          (plain mkdir/mkdirSync with no explicit mode) and confirm the mode comes
  //          out world/group-readable (0755) under umask 022, THEN confirm the actual
  //          fixed code produces 0700, THEN confirm rename() really does preserve that
  //          mode rather than assuming it (per the task's own instruction to verify,
  //          not assume, this). ----
  {
    const originalUmask = process.umask(0o022); // permissive, matching the issue's own repro
    try {
      const { mkdirSync: rawMkdirSync } = await import('node:fs');
      const {
        mkdir: rawMkdir,
        chmod: rawChmod,
        mkdtemp: rawMkdtemp,
        rename: rawRename,
        stat: rawStat,
      } = await import('node:fs/promises');

      // ---- positive control: the NAIVE pre-fix shape (no explicit mode) really does
      //      land at 0755 under umask 022 — confirms the test itself can detect the
      //      defect before trusting it to confirm the fix. ----
      const naiveParent = await rawMkdtemp(join(tmpdir(), 'cb-bagit-permcontrol-'));
      try {
        const naiveTmpOutDir = join(naiveParent, '.bagit-export-naive.partial');
        rawMkdirSync(naiveTmpOutDir); // the exact pre-fix call shape: no mode option
        const naiveDataDir = join(naiveTmpOutDir, 'data');
        await rawMkdir(naiveDataDir); // ditto
        const naiveTmpMode = (await rawStat(naiveTmpOutDir)).mode & 0o777;
        const naiveDataMode = (await rawStat(naiveDataDir)).mode & 0o777;
        check(
          'permissions positive control (RED): naive mkdir/mkdirSync with no explicit mode lands at 0755 under umask 022 — confirms this test can actually detect the #944 defect',
          naiveTmpMode === 0o755 && naiveDataMode === 0o755,
          `tmpOutDir mode=${naiveTmpMode.toString(8)} dataDir mode=${naiveDataMode.toString(8)}`,
        );
      } finally {
        await rm(naiveParent, { recursive: true, force: true });
      }

      // ---- GREEN: the actual fixed exportBagit() produces 0700 on both the published
      //      --out-dir (post-rename) and its data/ subdirectory, under the same
      //      permissive umask. ----
      const from = await makeRestoreDir('permissions-test');
      const out = join(tmp, 'permissions-out');
      await exportBagit({ fromDir: from, outDir: out });
      const outMode = (await rawStat(out)).mode & 0o777;
      const dataMode = (await rawStat(join(out, 'data'))).mode & 0o777;
      check(
        'permissions: published --out-dir is mode 0700 even under umask 022',
        outMode === 0o700,
        outMode.toString(8),
      );
      check('permissions: --out-dir/data is mode 0700 even under umask 022', dataMode === 0o700, dataMode.toString(8));

      // ---- rename() actually preserves mode across the publish step — verified
      //      directly here (task's own instruction: confirm, don't assume), isolated
      //      from exportBagit()'s own logic. ----
      const renameParent = await rawMkdtemp(join(tmpdir(), 'cb-bagit-renamecontrol-'));
      try {
        const preRename = join(renameParent, 'pre-rename-0700');
        const postRename = join(renameParent, 'post-rename');
        rawMkdirSync(preRename, { mode: 0o700 });
        await rawChmod(preRename, 0o700); // belt-and-suspenders against this OS's own umask folding the literal mkdir mode
        await rawRename(preRename, postRename);
        const preservedMode = (await rawStat(postRename)).mode & 0o777;
        check(
          "rename() preserves a directory's own mode across a publish step (verified directly, not assumed)",
          preservedMode === 0o700,
          preservedMode.toString(8),
        );
      } finally {
        await rm(renameParent, { recursive: true, force: true });
      }
    } finally {
      process.umask(originalUmask);
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\nBAGIT-EXPORT SELFTEST: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
