#!/usr/bin/env node
// Proof for #785: restore must bind the bytes it VERIFIES to the bytes it EXTRACTS.
//
// Before this, every phase re-opened `--in` by pathname — the sha256 pin, the minisign
// verification, the size cap, the tar-entry inspection (#218's allowlist), and the
// extraction itself. A writer who could replace that path for a few seconds passed
// verification against a genuine, correctly-signed artifact and had a DIFFERENT one
// extracted into `--out-dir`. age is public-key encryption, so the replacement needs no
// secret at all: the recipient public key is published by design, which is why the
// "attacker" artifact below is built with nothing but this test's own recipient.
//
// The barrier is DETERMINISTIC, not a race the test hopes to win. restoreImpl() calls
// `tar --version` exactly once (tarNoClobberFlag) between the last verification phase
// and the extraction, so a stub `tar` on PATH parks there, announces the phase has been
// reached, and waits for a go-file — the same announce-then-park technique
// scripts/selftest.sh uses to pin a SIGINT to a named snapshot phase. Not reaching the
// barrier is reported as BLOCKED and fails the run: every assertion after it would
// otherwise be vacuous.
//
// Three attacks, all launched at that barrier:
//
//   (a) rename-swap — a different artifact is renamed ONTO --in's path. Defeated by the
//       descriptor: the fd keeps pointing at the inode it was opened on, so extraction
//       never sees the substitute and the ORIGINAL restores, exit 0.
//   (b) in-place overwrite — the SAME inode is truncated and rewritten with
//       attacker-encrypted content. The descriptor cannot help here (it is the same
//       inode), so this is what the digest binding is for: the sha256 the extraction
//       pass streamed differs from the baseline taken before any check ran, so restore
//       refuses with CB-E026, writes no plaintext into --out-dir, and removes its
//       scratch tree.
//   (c) sidecar swap — a *.minisig that genuinely verifies against a DIFFERENT artifact
//       is put next to this one. Authenticity is checked against the pinned artifact's
//       own digest, so a signature made over other bytes cannot authenticate these.
//
// Measured on origin/main before the fix: (a) and (b) both restore the ATTACKER's
// content with exit 0.
//
// Part 0 covers what the end-to-end half structurally cannot, and says so rather than
// implying the whole guarantee is proven through the CLI. The binding is over EVERY
// phase that reads --in, not just the extraction: an attacker who leaves malicious bytes
// in place for the baseline hash, swaps genuine signed bytes in for the signature check
// and the entry inspection, then swaps back before extraction would otherwise get a
// matching baseline/extraction pair around two phases that never saw what was extracted.
// The same shape applies to verify, whose signature check and positive control are two
// separate full reads. Staging either end to end would need a barrier BETWEEN two of
// those read passes, and neither command runs an external process there to stub — the
// only stubbable point is restore's single `tar --version`, which sits after all of
// them. So Part 0 exercises the two pieces that close it directly instead:
// OpenedRestoreArtifact.completedDigests() (every phase's stream feeds it) and
// artifactChangedDigest() (what restore checks after inspection and after extraction,
// and what verify checks before its verdict), in both directions — silent while the
// reads agree, firing as soon as they do not. It also covers the two other properties
// the descriptor is relied on for: the size cap surviving a file that grows after the
// fstat, and readHead tolerating a file shorter than the header it asks for.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_ARGS } from './dev-node-flags.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'cypher-brain.mjs');
const BARRIER_TIMEOUT_MS = 60_000;

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const blocked = (name, detail) => {
  failed++;
  console.log(`[BLOCKED] ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The suite runs under an isolated TMPDIR that scripts/verify.mjs asserts is empty
// afterwards (#328) — everything this test makes lives under one root it removes.
const TMP = await mkdtemp(join(tmpdir(), 'cb-restore-toctou-'));
const HOME_DIR = join(TMP, 'keys');
const STUBBIN = join(TMP, 'stubbin');
const REAL_TAR = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();

const cliEnv = (extra = {}) => ({ ...process.env, CYPHER_BRAIN_HOME: HOME_DIR, ...extra });

function cb(args, extraEnv = {}) {
  const r = spawnSync('node', [...DEV_ARGS, BIN, ...args], { env: cliEnv(extraEnv), encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(`[BLOCKED] setup: \`cypher-brain ${args.join(' ')}\` exited ${r.status}`);
    console.log(r.stdout, r.stderr);
    process.exit(1);
  }
  return r;
}

try {
  if (!REAL_TAR) {
    console.log('[SKIP] restore TOCTOU selftest: no `tar` on PATH to stub');
    await rm(TMP, { recursive: true, force: true });
    process.exit(0);
  }

  // ---- Part 0: the descriptor owner's own guarantees -------------------------
  {
    const { openRestoreArtifact } = await import('../src/lib/artifact.ts');
    const { artifactChangedDigest } = await import('../src/lib/restore.ts');
    const p = join(TMP, 'owner.bin');
    const alt = join(TMP, 'owner-alt.bin');
    await writeFile(p, Buffer.alloc(300 * 1024, 0x41));
    const a = await openRestoreArtifact(p);
    try {
      const baseline = await a.sha256();
      check(
        'Part 0: with one consistent read so far, the change detector stays silent (negative control)',
        artifactChangedDigest(a) === undefined && artifactChangedDigest(a, baseline) === undefined,
      );
      // Every phase's stream feeds completedDigests(), so a rewrite seen by ONE phase
      // shows up even if the baseline and the last phase happen to agree. The front of
      // this file is untouched, so it is the WHOLE-FILE comparison that has to catch it —
      // the head comparison cannot, which is exactly why both exist.
      await writeFile(p, Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.alloc(200 * 1024, 0x42)]));
      const second = await a.sha256();
      // The guard restore calls after inspection and after extraction, and verify calls
      // before its verdict. Both forms: against an explicit baseline (restore) and
      // against whatever was read first (verify).
      check(
        'Part 0: the change detector fires once two passes disagree (positive control)',
        artifactChangedDigest(a, baseline)?.observed === second && artifactChangedDigest(a)?.observed === second,
        JSON.stringify(artifactChangedDigest(a)),
      );
      check(
        'Part 0: a change past the header is attributed to the whole-file comparison',
        artifactChangedDigest(a)?.scope === 'contents',
        JSON.stringify(artifactChangedDigest(a)),
      );
      check('Part 0: an in-place rewrite is visible through the descriptor', second !== baseline);
      const digests = a.completedDigests();
      check(
        'Part 0: every completed stream is recorded, so any phase that read other bytes is caught',
        digests.length === 2 && digests[0] === baseline && digests[1] === second,
        JSON.stringify(digests),
      );
      // A rename replaces the directory entry, never the inode this fd holds.
      await writeFile(alt, Buffer.alloc(50 * 1024, 0x43));
      await rename(alt, p);
      check('Part 0: a rename onto the path is invisible to the descriptor', (await a.sha256()) === second);
    } finally {
      await a.close();
    }
    // #218's cap has to survive a file that GROWS after the fstat at open time: the cap
    // is accepted here (32 KiB file, 64 KiB limit) and must still fire once a stream
    // actually delivers more than that.
    const grows = join(TMP, 'grows.bin');
    await writeFile(grows, Buffer.alloc(32 * 1024, 0x44));
    const g = await openRestoreArtifact(grows);
    try {
      g.limitBytes(64 * 1024);
      await writeFile(grows, Buffer.alloc(512 * 1024, 0x45));
      let capErr = '';
      try {
        await g.sha256();
      } catch (e) {
        capErr = e.message;
      }
      check(
        'Part 0: the size cap is enforced on the bytes actually streamed, not just the fstat',
        capErr.includes('over the') && capErr.includes('restore cap'),
        capErr || 'no error thrown',
      );
    } finally {
      await g.close();
    }
    // The header sniff hashes nothing and completes no stream, and verify's negative
    // control aborts at the age header — on a public-key-only box with an unsigned
    // artifact and no --sha256 those are the ONLY reads verify makes, so whole-file
    // digests alone would have nothing to compare. Every read's first bytes are pinned
    // too; this is the positive control for that half.
    const headers = join(TMP, 'headers.bin');
    await writeFile(headers, Buffer.concat([Buffer.from('age-encryption.org/v1\n'), Buffer.alloc(4096, 0x46)]));
    const h = await openRestoreArtifact(headers);
    try {
      await h.readHead(64);
      check(
        'Part 0: one header read on its own is not a disagreement (negative control)',
        artifactChangedDigest(h) === undefined,
      );
      // Same length, different front: nothing about the SIZE gives this away.
      await writeFile(headers, Buffer.concat([Buffer.from('AGE-ENCRYPTION.ORG/V1\n'), Buffer.alloc(4096, 0x46)]));
      await h.readHead(64);
      const change = artifactChangedDigest(h);
      check(
        'Part 0: a header-only swap between two reads is caught even though no stream completed',
        change?.scope === 'first bytes',
        JSON.stringify(change),
      );
    } finally {
      await h.close();
    }
    // readHead must tolerate a file shorter than the requested header, and a stream over
    // that same short file must pin the SAME prefix — a mismatch there would be a false
    // CB-E026 on a file nobody touched.
    const tiny = join(TMP, 'tiny.bin');
    await writeFile(tiny, 'age-enc');
    const t = await openRestoreArtifact(tiny);
    try {
      check(
        'Part 0: readHead returns what exists when the file is shorter than n',
        (await t.readHead(64)) === 'age-enc',
      );
      await t.sha256();
      check(
        'Part 0: a file shorter than the pinned prefix is not a false disagreement (negative control)',
        artifactChangedDigest(t) === undefined,
        JSON.stringify({ heads: t.observedHeads(), change: artifactChangedDigest(t) }),
      );
    } finally {
      await t.close();
    }
    // Truncating the inode to nothing between two readers must not become a blind spot:
    // the emptied stream still pins an (empty) prefix, so the disagreement is visible.
    const emptied = join(TMP, 'emptied.bin');
    await writeFile(emptied, Buffer.from('age-encryption.org/v1\nheader-bytes-here-padding-padding-padding'));
    const e = await openRestoreArtifact(emptied);
    try {
      await e.readHead(64);
      await writeFile(emptied, '');
      await e.sha256();
      check(
        'Part 0: a truncate-to-zero between two reads is still caught',
        artifactChangedDigest(e)?.scope === 'first bytes',
        JSON.stringify(artifactChangedDigest(e)),
      );
    } finally {
      await e.close();
    }
  }

  // ---- fixtures -------------------------------------------------------------
  await mkdir(STUBBIN, { recursive: true });
  // Parks ONLY on the restore pipeline's single `tar --version` probe, and only the
  // first time (a later probe — component auto-expand — must pass straight through, or
  // the run would deadlock after the go-file has already been consumed). Every other
  // tar invocation, including the ones snapshot() makes, execs the real tar untouched.
  // Assembled line by line rather than as one template literal: every `$` below is
  // shell, and escaping them inside a JS template would make this unreadable.
  await writeFile(
    join(STUBBIN, 'tar'),
    [
      '#!/usr/bin/env bash',
      // No `${VAR:-}` default form anywhere in here: this script is never run under
      // `set -u`, and an unset variable simply expands to empty.
      'if [ "$TAR_STUB_MODE" = "block-version" ] && [ "$1" = "--version" ] && [ ! -e "$CB_PHASE_SENTINEL" ]; then',
      '  printf \'reached\\n\' > "$CB_PHASE_SENTINEL"',
      '  waited=0',
      '  while [ ! -e "$CB_PHASE_GO" ]; do',
      '    sleep 0.05',
      '    waited=$((waited + 1))',
      '    if [ "$waited" -ge 1200 ]; then break; fi   # 60s ceiling: never wedge the suite',
      '  done',
      'fi',
      `exec ${JSON.stringify(REAL_TAR)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const goodSrc = join(TMP, 'src-good');
  const evilSrc = join(TMP, 'src-evil');
  await mkdir(goodSrc, { recursive: true });
  await mkdir(evilSrc, { recursive: true });
  await writeFile(join(goodSrc, 'note.txt'), 'ORIGINAL-CONTENT-9f3a\n');
  await writeFile(join(evilSrc, 'note.txt'), 'ATTACKER-CONTENT-1c7e\n');

  cb(['keygen']);
  const good = join(TMP, 'good.age');
  const evil = join(TMP, 'evil.age');
  cb(['snapshot', '--dir', goodSrc, '--out', good, '--scan-secrets', 'off']);
  // Encrypted to the SAME published recipient, with no secret of the victim's: exactly
  // what makes this class of substitution cheap for an attacker.
  cb(['snapshot', '--dir', evilSrc, '--out', evil, '--scan-secrets', 'off']);
  const evilBytes = await readFile(evil);

  // ---- the harness ----------------------------------------------------------
  let runNo = 0;
  async function restoreWithBarrier(inPath, outDir, atBarrier) {
    const n = ++runNo;
    const sentinel = join(TMP, `sentinel-${n}`);
    const go = join(TMP, `go-${n}`);
    const child = spawn('node', [...DEV_ARGS, BIN, 'restore', '--in', inPath, '--out-dir', outDir], {
      env: cliEnv({
        PATH: `${STUBBIN}:${process.env.PATH}`,
        TAR_STUB_MODE: 'block-version',
        CB_PHASE_SENTINEL: sentinel,
        CB_PHASE_GO: go,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let exitCode = null;
    const exited = new Promise((res) =>
      child.on('close', (code, signal) => {
        exitCode = code ?? `signal:${signal}`;
        res();
      }),
    );
    // Never wait on a run that is not going to finish (Codex review): if the barrier is
    // never reached, or the swap itself throws, tear the child down on a bounded
    // escalation rather than awaiting a close event that will not come. A run killed
    // this way reports reached=false, which the callers treat as BLOCKED.
    const reap = async () => {
      child.kill('SIGTERM');
      const hardDeadline = Date.now() + 5_000;
      while (exitCode === null && Date.now() < hardDeadline) await sleep(50);
      if (exitCode === null) child.kill('SIGKILL');
      await exited;
    };
    const deadline = Date.now() + BARRIER_TIMEOUT_MS;
    while (!existsSync(sentinel) && exitCode === null && Date.now() < deadline) await sleep(50);
    let reached = existsSync(sentinel);
    if (!reached) {
      if (exitCode === null) await reap();
      else await exited;
      return { reached: false, code: exitCode, out, err };
    }
    try {
      await atBarrier();
      await writeFile(go, 'go\n');
    } catch (e) {
      await reap();
      reached = false;
      err += `\nbarrier callback threw: ${e?.message ?? e}`;
      return { reached, code: exitCode, out, err };
    }
    await exited;
    return { reached, code: exitCode, out, err };
  }

  // A scratch tree is a SIBLING of --out-dir (`<out-dir>.restore-<pid>-<hex>`), so a
  // refusal that left freshly-decrypted plaintext behind shows up here.
  async function scratchSiblings(outDir) {
    const entries = await readdir(dirname(outDir));
    return entries.filter((e) => e.startsWith(`${basename(outDir)}.restore-`));
  }

  // Which marker actually reached the restored tree. Walks --out-dir rather than
  // hard-coding the component auto-expand layout, so a change in where an expanded
  // --dir component lands cannot turn a real regression into a green run.
  async function markersUnder(dir) {
    const found = new Set();
    const walk = async (d) => {
      for (const ent of await readdir(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile()) {
          const text = await readFile(p, 'utf8').catch(() => '');
          if (text.includes('ORIGINAL-CONTENT-9f3a')) found.add('original');
          if (text.includes('ATTACKER-CONTENT-1c7e')) found.add('attacker');
        }
      }
    };
    if (existsSync(dir)) await walk(dir);
    return found;
  }

  // ---- control: the barrier itself must not change a clean restore ----------
  {
    const inPath = join(TMP, 'control.age');
    const outDir = join(TMP, 'out-control');
    await copyFile(good, inPath);
    const r = await restoreWithBarrier(inPath, outDir, async () => {});
    if (!r.reached) blocked('control: restore reached the pre-extraction barrier', 'sentinel never appeared');
    else {
      check('control: a restore parked at the barrier still succeeds', r.code === 0, `exit ${r.code}: ${r.err}`);
      const markers = await markersUnder(outDir);
      check(
        'control: the original content is what landed in --out-dir',
        markers.has('original') && !markers.has('attacker'),
        `markers: ${JSON.stringify([...markers])}`,
      );
    }
  }

  // ---- (a) rename-swap ------------------------------------------------------
  {
    const inPath = join(TMP, 'rename.age');
    const outDir = join(TMP, 'out-rename');
    const decoy = join(TMP, 'rename-decoy.age');
    await copyFile(good, inPath);
    await copyFile(evil, decoy);
    const r = await restoreWithBarrier(inPath, outDir, () => rename(decoy, inPath));
    if (!r.reached) blocked('(a) rename-swap: restore reached the barrier', 'sentinel never appeared');
    else {
      check(
        '(a) rename-swap: the swap is confirmed to have landed (positive control on the attack)',
        (await readFile(inPath)).equals(evilBytes),
        '--in still holds the original bytes; the attack never happened',
      );
      check('(a) rename-swap: restore still succeeds', r.code === 0, `exit ${r.code}: ${r.err}`);
      const markers = await markersUnder(outDir);
      check(
        '(a) rename-swap: the VERIFIED bytes are what got restored, not the substitute',
        markers.has('original'),
        `markers: ${JSON.stringify([...markers])}`,
      );
      check(
        '(a) rename-swap: no attacker content reached --out-dir',
        !markers.has('attacker'),
        `markers: ${JSON.stringify([...markers])}`,
      );
    }
  }

  // ---- (b) in-place overwrite ----------------------------------------------
  {
    const inPath = join(TMP, 'inplace.age');
    const outDir = join(TMP, 'out-inplace');
    await copyFile(good, inPath);
    // writeFile truncates and rewrites the SAME inode — the primitive a writer with
    // access to --in's path would use, and the one the descriptor cannot see through.
    const r = await restoreWithBarrier(inPath, outDir, () => writeFile(inPath, evilBytes));
    if (!r.reached) blocked('(b) in-place overwrite: restore reached the barrier', 'sentinel never appeared');
    else {
      const all = `${r.out}\n${r.err}`;
      check(
        '(b) in-place overwrite: the overwrite is confirmed to have landed (positive control on the attack)',
        (await readFile(inPath)).equals(evilBytes),
      );
      check('(b) in-place overwrite: restore refuses (non-zero exit)', r.code !== 0, `exit ${r.code}`);
      check(
        '(b) in-place overwrite: refusal names the condition',
        all.includes('changed while it was being read'),
        all.slice(-400),
      );
      check('(b) in-place overwrite: refusal carries CB-E026', all.includes('CB-E026'), all.slice(-400));
      check('(b) in-place overwrite: --out-dir was never created', !existsSync(outDir));
      check(
        '(b) in-place overwrite: no plaintext at all reached --out-dir',
        (await markersUnder(outDir)).size === 0,
        'attacker (or any) content was promoted',
      );
      const left = await scratchSiblings(outDir);
      check(
        '(b) in-place overwrite: the freshly-decrypted scratch tree was removed',
        left.length === 0,
        `left ${JSON.stringify(left)}`,
      );
    }
  }

  // ---- (c) sidecar swap -----------------------------------------------------
  {
    cb(['keygen', '--sign']);
    const signedGood = join(TMP, 'signed-good.age');
    const signedEvil = join(TMP, 'signed-evil.age');
    cb(['snapshot', '--dir', goodSrc, '--out', signedGood, '--scan-secrets', 'off']);
    cb(['snapshot', '--dir', evilSrc, '--out', signedEvil, '--scan-secrets', 'off']);
    check(
      '(c) sidecar swap: both artifacts really are signed (positive control on the fixture)',
      existsSync(`${signedGood}.minisig`) && existsSync(`${signedEvil}.minisig`),
    );
    const inPath = join(TMP, 'sidecar.age');
    const outDir = join(TMP, 'out-sidecar');
    await copyFile(signedGood, inPath);
    // A genuine, correctly-made signature — over the WRONG bytes.
    await copyFile(`${signedEvil}.minisig`, `${inPath}.minisig`);
    const r = spawnSync(
      'node',
      [...DEV_ARGS, BIN, 'restore', '--in', inPath, '--out-dir', outDir, '--require-signature'],
      { env: cliEnv(), encoding: 'utf8' },
    );
    const all = `${r.stdout}\n${r.stderr}`;
    check('(c) sidecar swap: restore refuses', r.status !== 0, `exit ${r.status}`);
    check(
      '(c) sidecar swap: a signature over other bytes cannot authenticate these',
      all.includes('signature does not verify against the file content'),
      all.slice(-400),
    );
    check('(c) sidecar swap: --out-dir was never created', !existsSync(outDir));
    check('(c) sidecar swap: no scratch tree left behind', (await scratchSiblings(outDir)).length === 0);
  }
} finally {
  await rm(TMP, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nRESTORE TOCTOU SELFTEST: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nRESTORE TOCTOU SELFTEST PASS');
