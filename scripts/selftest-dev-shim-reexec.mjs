#!/usr/bin/env node
// Proof for the multi-model-review narrowing of dev-shim-reexec.mjs's
// isMissingDevEntrypoint() (see that file's own doc comment): the bin/*.mjs shims'
// re-exec fallback must fire ONLY when the top-level entrypoint import itself is what
// failed to resolve (needs the dev TS-resolve loader), never on some OTHER, genuinely
// unrelated ERR_MODULE_NOT_FOUND raised several layers deeper once that loader is
// already active (a typo'd import inside src/cli.ts, say) — the exact "too broad a
// trigger" bug a prior audit flagged.
//
// Never touches the real bin/*.mjs or src/cli.ts/src/mcp.ts: every fixture below is a
// disposable file under this test's own mkdtemp tree, wired to the REAL
// scripts/dev-shim-reexec.mjs (imported by absolute path) and the REAL
// scripts/dev-cli-loader.mjs/dev-ts-resolve-hook.mjs (which reexecUnderDevLoader()
// resolves relative to dev-shim-reexec.mjs's own location, not the fixture's) — so this
// exercises the actual production code path, not a reimplementation of it.
//
// Part A: unit-level coverage of isMissingDevEntrypoint() itself against synthetic
// error shapes — fast, and covers the two edge cases a process-spawn test cannot easily
// force (a non-ERR_MODULE_NOT_FOUND code; a future Node that stops setting err.url).
// Part B: two real `node` process runs against disposable fixtures, mirroring
// bin/cypher-brain.mjs's own catch-block shape exactly:
//   (1) the genuine scenario — a bare invocation (no dev flags) whose entrypoint has
//       only a sibling .ts file — must still transparently re-exec and succeed.
//   (2) the bug this fix closes — the dev loader is ALREADY active (as if the caller's
//       own NODE_OPTIONS already carried it) and a NESTED import several layers deep is
//       genuinely missing — must fail on the FIRST attempt with the real error, and
//       must NOT spawn a second (reexec) process at all.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REEXEC_MODULE = join(ROOT, 'scripts', 'dev-shim-reexec.mjs');
const LOADER = join(ROOT, 'scripts', 'dev-cli-loader.mjs');

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// ---------------------------------------------------------------------------
// Part A: isMissingDevEntrypoint() against synthetic error shapes
// ---------------------------------------------------------------------------
{
  const { isMissingDevEntrypoint } = await import(REEXEC_MODULE);
  const callerUrl = 'file:///fake-repo/bin/cypher-brain.mjs';
  const specifier = '../src/cli.js';
  const entrypointUrl = new URL(specifier, callerUrl).href;

  const entrypointMissing = Object.assign(new Error('x'), {
    code: 'ERR_MODULE_NOT_FOUND',
    url: entrypointUrl,
  });
  check(
    'Part A: the entrypoint itself failing to resolve IS the known scenario',
    isMissingDevEntrypoint(entrypointMissing, specifier, callerUrl) === true,
  );

  const nestedMissing = Object.assign(new Error('x'), {
    code: 'ERR_MODULE_NOT_FOUND',
    url: new URL('../src/lib/nope.ts', 'file:///fake-repo/src/cli.ts').href,
  });
  check(
    'Part A: a DIFFERENT (nested) specifier failing is NOT the known scenario',
    isMissingDevEntrypoint(nestedMissing, specifier, callerUrl) === false,
  );

  const wrongCode = Object.assign(new Error('x'), { code: 'ERR_SOMETHING_ELSE', url: entrypointUrl });
  check(
    'Part A: a non-ERR_MODULE_NOT_FOUND code never matches, even with the right url',
    isMissingDevEntrypoint(wrongCode, specifier, callerUrl) === false,
  );

  const noUrlAtAll = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
  check(
    'Part A: a missing err.url (e.g. a future Node) fails closed to "not the known scenario", not the old broad match',
    isMissingDevEntrypoint(noUrlAtAll, specifier, callerUrl) === false,
  );

  check(
    'Part A: a null/undefined err never throws and never matches',
    isMissingDevEntrypoint(null, specifier, callerUrl) === false &&
      isMissingDevEntrypoint(undefined, specifier, callerUrl) === false,
  );
}

// ---------------------------------------------------------------------------
// Part B: real process runs against disposable fixtures
// ---------------------------------------------------------------------------
const TMP = await mkdtemp(join(tmpdir(), 'cb-shim-reexec-'));
try {
  // ---- (1) the genuine scenario: bare invocation, entrypoint needs the dev loader ----
  {
    const dir = join(TMP, 'good');
    await mkdir(join(dir, 'bin'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    // Only a .ts sibling exists — the SAME shape src/cli.ts/src/mcp.ts are in relative
    // to their own bin/*.mjs shim (no build step, no compiled .js).
    await writeFile(join(dir, 'src', 'entry.ts'), "console.log('ENTRY-OK');\n");
    await writeFile(
      join(dir, 'bin', 'shim.mjs'),
      [
        'try {',
        "  await import('../src/entry.js');",
        '} catch (err) {',
        "  const alreadyReexeced = process.env.CYPHER_BRAIN_DEV_SHIM_REEXEC === '1';",
        "  if (alreadyReexeced || !(err && err.code === 'ERR_MODULE_NOT_FOUND')) throw err;",
        `  const { reexecUnderDevLoader, isMissingDevEntrypoint } = await import(${JSON.stringify(REEXEC_MODULE)});`,
        "  if (!isMissingDevEntrypoint(err, '../src/entry.js', import.meta.url)) throw err;",
        '  await reexecUnderDevLoader(import.meta.url, process.argv.slice(2));',
        '}',
        '',
      ].join('\n'),
    );
    const r = spawnSync('node', [join(dir, 'bin', 'shim.mjs')], { encoding: 'utf8', env: { ...process.env } });
    check(
      '(1) genuine scenario: a bare invocation re-execs under the dev loader and succeeds',
      r.status === 0 && r.stdout.includes('ENTRY-OK'),
      `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );
  }

  // ---- (2) the bug this fix closes: loader already active, a NESTED import is genuinely missing ----
  {
    const dir = join(TMP, 'nested');
    await mkdir(join(dir, 'bin'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    const attemptsLog = join(dir, 'attempts.log');
    // The entrypoint itself resolves fine (once the loader is active) — its OWN static
    // import of a module that does not exist, even as .ts, is what must fail here.
    // (Deliberately NOT where the attempt counter lives: a static `import` is resolved
    // during module LINKING, before entry-nested.ts's own body ever runs, so it never
    // reaches a marker placed inside it — see shim2.mjs's own marker instead, which DOES
    // run on every invocation of the shim file itself, re-exec'd or not.)
    await writeFile(join(dir, 'src', 'entry-nested.ts'), "import './this-module-genuinely-does-not-exist.js';\n");
    await writeFile(
      join(dir, 'bin', 'shim2.mjs'),
      [
        `import { appendFileSync } from 'node:fs';`,
        // Marks every time THIS shim file itself is entered — the original invocation,
        // AND (if the old, too-broad predicate were still in place) a re-exec'd child
        // re-running this exact same file. Placed here, not inside entry-nested.ts,
        // since only this file is guaranteed to actually execute a line of its own body
        // regardless of what its import below does.
        `appendFileSync(${JSON.stringify(attemptsLog)}, 'attempt\\n');`,
        'try {',
        "  await import('../src/entry-nested.js');",
        '} catch (err) {',
        "  const alreadyReexeced = process.env.CYPHER_BRAIN_DEV_SHIM_REEXEC === '1';",
        "  if (alreadyReexeced || !(err && err.code === 'ERR_MODULE_NOT_FOUND')) throw err;",
        `  const { reexecUnderDevLoader, isMissingDevEntrypoint } = await import(${JSON.stringify(REEXEC_MODULE)});`,
        "  if (!isMissingDevEntrypoint(err, '../src/entry-nested.js', import.meta.url)) throw err;",
        '  await reexecUnderDevLoader(import.meta.url, process.argv.slice(2));',
        '}',
        '',
      ].join('\n'),
    );
    // The dev loader is passed as literal argv flags here — simulating a caller whose
    // OWN NODE_OPTIONS already carries them (exactly the selftest*.sh/cli-smoke.sh
    // convention this repo already uses) — so `entry-nested.ts` resolves on the FIRST
    // try, and its own nested import is the only thing that can still fail.
    const r = spawnSync('node', ['--experimental-strip-types', '--import', LOADER, join(dir, 'bin', 'shim2.mjs')], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    check(
      '(2) fixed behavior: a genuinely missing NESTED import still fails the run (non-zero exit)',
      r.status !== 0,
      `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
    );
    check(
      '(2) fixed behavior: the real error (the nested missing specifier) reaches stderr, not a swallowed/replaced one',
      /this-module-genuinely-does-not-exist/.test(r.stderr),
      r.stderr,
    );
    const attempts = (await readFile(attemptsLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    check(
      '(2) fixed behavior: the narrowed predicate declines to re-exec — entry-nested.ts is evaluated exactly ONCE, not twice',
      attempts.length === 1,
      `attempts=${attempts.length}`,
    );
  }
} finally {
  await rm(TMP, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nDEV SHIM REEXEC SELFTEST: ALL PASS');
